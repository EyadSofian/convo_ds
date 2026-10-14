import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { asExecutor } from '../../packages/database/src/index.js';
import { registerChannelApp } from '../../packages/database/src/channel-app.js';
import { PINNED_GRAPH_VERSION } from '../../packages/domain/src/index.js';
import { answerMetaChallenge } from '../../packages/domain/src/channels/meta-signature.js';
import { nodeChannelCrypto } from '../../apps/api/src/channels/node-crypto.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import {
  clusterCredentials,
  createScratchDatabase,
  migrateScratch,
  scratchMigrationPool,
  scratchRuntimePool,
} from '../support/scratch.js';

/**
 * The provider-app registration, run in this process against a real database.
 *
 * This is the only way an installation can hold a `channel_apps` row, so the
 * properties asserted here are the ones a Meta go-live actually rests on: that
 * the row is created as the migration role, that the runtime still cannot write
 * it, that re-running rotates in place rather than minting a second row, and —
 * the one that is easy to get wrong and impossible to debug from a webhook log
 * — that the verify-token digest it stores is the digest the subscription
 * handshake computes.
 */
describe('registerChannelApp', () => {
  let names: DatabaseNames;
  let migrationPool: Pool;
  let runtime: Pool;

  const APP_SECRET = 'meta-app-secret-value';
  const VERIFY_TOKEN = 'the-verify-token-entered-in-meta';

  const input = (overrides: Partial<Parameters<typeof registerChannelApp>[2]> = {}) => ({
    provider: 'meta' as const,
    externalAppId: '123456789012345',
    secretRef: 'META_APP',
    graphVersion: PINNED_GRAPH_VERSION,
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    ...overrides,
  });

  beforeAll(async () => {
    names = await createScratchDatabase('convo_channel_app');
    await migrateScratch(names);
    migrationPool = scratchMigrationPool(names);
    runtime = scratchRuntimePool(names);
  }, 180_000);

  afterAll(async () => {
    await migrationPool.end();
    await runtime.end();
  });

  it('creates the row and reports it as created', async () => {
    const app = await registerChannelApp(clusterCredentials(), names, input());

    expect(app.created).toBe(true);
    expect(app.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(app).toMatchObject({
      provider: 'meta',
      externalAppId: '123456789012345',
      secretRef: 'META_APP',
      graphVersion: PINNED_GRAPH_VERSION,
    });

    const rows = await asExecutor(migrationPool).query<{
      secret_ref: string;
      secret_fingerprint: string;
      verify_token_hash: string;
      graph_version: string;
      status: string;
      rotated_at: Date | null;
    }>(
      `SELECT secret_ref, secret_fingerprint, verify_token_hash, graph_version, status, rotated_at
         FROM channel_apps WHERE id = $1`,
      [app.id],
    );
    expect(rows.rows[0]).toMatchObject({
      secret_ref: 'META_APP',
      graph_version: PINNED_GRAPH_VERSION,
      status: 'active',
      rotated_at: null,
    });
  });

  /**
   * The property that cannot be checked any other way.
   *
   * If this digest disagrees with the handshake's, every Meta webhook
   * subscription fails with a 403 that says nothing about why, and the operator
   * has no way to tell a wrong token from a wrong hash.
   */
  it('stores a verify-token hash the subscription handshake accepts', async () => {
    const app = await registerChannelApp(clusterCredentials(), names, input({ externalAppId: '222222222222222' }));
    const stored = await asExecutor(migrationPool).query<{ verify_token_hash: string }>(
      `SELECT verify_token_hash FROM channel_apps WHERE id = $1`, [app.id],
    );
    const hash = stored.rows[0]!.verify_token_hash;

    expect(answerMetaChallenge(
      { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'echo-me' },
      hash,
      nodeChannelCrypto,
    )).toBe('echo-me');

    expect(answerMetaChallenge(
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'the-wrong-token', 'hub.challenge': 'echo-me' },
      hash,
      nodeChannelCrypto,
    )).toBeNull();
  });

  it('fingerprints the app secret as SHA-256 hex', async () => {
    const app = await registerChannelApp(clusterCredentials(), names, input({ externalAppId: '333333333333333' }));
    const stored = await asExecutor(migrationPool).query<{ secret_fingerprint: string }>(
      `SELECT secret_fingerprint FROM channel_apps WHERE id = $1`, [app.id],
    );
    expect(stored.rows[0]?.secret_fingerprint)
      .toBe(createHash('sha256').update(APP_SECRET, 'utf8').digest('hex'));
  });

  /**
   * Rotation keeps the id, because the id is in the webhook URL.
   *
   * A second row for the same app would leave the URL already configured in
   * Meta pointing at a registration holding the old secret, which is a webhook
   * that verifies nothing and an operator with two rows and no way to know
   * which one is live.
   */
  it('rotates in place, keeping the id the webhook URL already uses', async () => {
    const first = await registerChannelApp(clusterCredentials(), names, input({ externalAppId: '444444444444444' }));
    const second = await registerChannelApp(clusterCredentials(), names, input({
      externalAppId: '444444444444444',
      appSecret: 'rotated-secret',
      verifyToken: 'rotated-token',
      secretRef: 'META_APP_V2',
    }));

    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);

    const rows = await asExecutor(migrationPool).query<{
      count: string; secret_ref: string; secret_fingerprint: string; rotated_at: Date | null;
    }>(
      `SELECT (SELECT count(*)::text FROM channel_apps WHERE external_app_id = $2) AS count,
              secret_ref, secret_fingerprint, rotated_at
         FROM channel_apps WHERE id = $1`,
      [first.id, '444444444444444'],
    );
    expect(rows.rows[0]?.count).toBe('1');
    expect(rows.rows[0]?.secret_ref).toBe('META_APP_V2');
    expect(rows.rows[0]?.secret_fingerprint)
      .toBe(createHash('sha256').update('rotated-secret', 'utf8').digest('hex'));
    expect(rows.rows[0]?.rotated_at).not.toBeNull();
  });

  it('brings a retired registration back to active rather than leaving it unusable', async () => {
    const app = await registerChannelApp(clusterCredentials(), names, input({ externalAppId: '555555555555555' }));
    await asExecutor(migrationPool).query(
      `UPDATE channel_apps SET status = 'retired' WHERE id = $1`, [app.id],
    );

    const again = await registerChannelApp(clusterCredentials(), names, input({ externalAppId: '555555555555555' }));
    expect(again.id).toBe(app.id);

    const rows = await asExecutor(migrationPool).query<{ status: string }>(
      `SELECT status FROM channel_apps WHERE id = $1`, [app.id],
    );
    // `loadApp` in the ingress requires `status = 'active'`, so a retired row
    // is a webhook that answers 404 for every delivery.
    expect(rows.rows[0]?.status).toBe('active');
  });

  /**
   * The privilege boundary this command exists to respect.
   *
   * The whole reason registration lives in the CLI rather than the API is that
   * the runtime must not be able to point signature verification at a secret of
   * its own choosing. If this ever passes, that argument is void.
   */
  it('is not something the runtime role can do for itself', async () => {
    await expect(asExecutor(runtime).query(
      `INSERT INTO channel_apps
         (provider, external_app_id, secret_ref, secret_fingerprint, verify_token_hash, graph_version)
       VALUES ('meta', '666666666666666', 'META_APP', $1, $1, $2)`,
      ['f'.repeat(64), PINNED_GRAPH_VERSION],
    )).rejects.toThrow(/permission denied/i);
  });

  it('refuses a secret ref the column will not hold', async () => {
    await expect(registerChannelApp(clusterCredentials(), names, input({
      externalAppId: '777777777777777', secretRef: 'lowercase_ref',
    }))).rejects.toThrow(/channel_apps_secret_ref_check|violates check constraint/i);
  });
});
