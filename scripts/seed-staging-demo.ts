/**
 * Emergency staging-only bootstrap for an *empty* recovered installation.
 *
 * This is deliberately a CLI, never an HTTP route. It only reopens bootstrap
 * when the database has no tenant or membership rows, then invokes the normal
 * domain bootstrap function. It therefore cannot add an Owner to an existing
 * customer company or become a production backdoor.
 */
import { chmod, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import pg from 'pg';
// This CLI is executed with tsx from the repository checkout in the Railway
// maintenance shell, so use source-relative imports rather than workspace
// package aliases (Node does not resolve those aliases outside a package).
import { bootstrapInstallation } from '../packages/domain/src/index.ts';
import { withTenant } from '../packages/database/src/index.ts';

const OWNER_EMAIL = 'demo.owner@convo.local';
const CREDENTIALS_PATH = '.demo-staging-credentials.txt';
const STAGING_RAILWAY_ENVIRONMENT_ID = '6c7d3ce1-db61-40fd-9cf7-bffac954eda5';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') throw new Error(`Missing ${name}`);
  return value;
}

function assertStagingOnly(): void {
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.CONVO_ENVIRONMENT !== 'staging' ||
    process.env.RAILWAY_ENVIRONMENT_ID !== STAGING_RAILWAY_ENVIRONMENT_ID ||
    process.env.CONVO_STAGING_DEMO_SEED !== 'enabled'
  ) {
    throw new Error('Refusing to seed: requires the named non-production Railway staging environment with CONVO_STAGING_DEMO_SEED=enabled.');
  }
}

async function reopenOnlyEmptyInstallation(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const facts = await client.query<{ tenants: string; memberships: string }>(
      `SELECT (SELECT count(*)::text FROM tenants) AS tenants,
              (SELECT count(*)::text FROM memberships) AS memberships`,
    );
    const row = facts.rows[0];
    if (row?.tenants !== '0' || row.memberships !== '0') {
      throw new Error('Refusing to seed: the installation contains tenant or membership data.');
    }
    const changed = await client.query(
      `UPDATE installations SET bootstrap_state = 'pending'
        WHERE singleton IS TRUE AND bootstrap_state = 'completed'`,
    );
    if (changed.rowCount !== 1) throw new Error('Refusing to seed: installation is not a recoverable completed singleton.');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  assertStagingOnly();
  const pool = new pg.Pool({
    host: required('CONVO_PG_HOST'),
    port: Number(required('CONVO_PG_PORT')),
    database: required('CONVO_PG_DATABASE'),
    user: required('CONVO_PG_MIGRATION_ROLE'),
    password: required('CONVO_PG_MIGRATION_PASSWORD'),
  });
  try {
    await reopenOnlyEmptyInstallation(pool);
    const password = randomBytes(30).toString('base64url');
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    const ids = [randomUUID(), randomUUID()];
    let index = 0;
    const result = await bootstrapInstallation(
      {
        newId: () => ids[index++] as string,
        transaction: (tenantId, work) => withTenant(pool, tenantId, work),
      },
      {
        companyName: 'CONVO Demo',
        companySlug: 'convo-demo',
        ownerEmail: OWNER_EMAIL,
        ownerPasswordHash: passwordHash,
      },
    );
    if (result.status !== 'created') throw new Error(`Staging bootstrap rejected: ${result.code}`);
    await writeFile(
      CREDENTIALS_PATH,
      `CONVO STAGING DEMO\n\nURL:\nhttps://convo-client-demo-staging.up.railway.app\n\nEmail:\n${OWNER_EMAIL}\n\nTemporary Password:\n${password}\n\nRole:\nOwner\n`,
      { mode: 0o600 },
    );
    await chmod(CREDENTIALS_PATH, 0o600);
    console.log(`staging_demo_seed_complete email=${OWNER_EMAIL} credentials_file=${CREDENTIALS_PATH}`);
  } finally {
    await pool.end();
  }
}

await main();
