import pg from 'pg';
import type { Client as PgClient } from 'pg';
import type { ClusterCredentials, DatabaseNames } from './types.js';

// `pg` is CommonJS. Under plain Node ESM a named import of `Client` throws
// at module load -- which the real `convo-db` process does and Vitest's
// transform hides. Import the default and destructure.
const { Client } = pg;

/**
 * Cluster bootstrap. Runs once, as a superuser, before any migration.
 *
 * Role creation deliberately lives here rather than in a migration: creating
 * roles needs privileges the migration path should not carry around, and the
 * separation is what makes ADR-0003's "runtime role owns nothing" assertion
 * meaningful instead of aspirational.
 */
export async function bootstrapCluster(
  cluster: ClusterCredentials,
  names: DatabaseNames,
): Promise<void> {
  const admin = new Client({
    host: cluster.host,
    port: cluster.port,
    user: cluster.superUser,
    password: cluster.superPassword,
    database: 'postgres',
  });
  await admin.connect();
  try {
    await createRoleIfMissing(admin, names.migrationRole, names.migrationPassword);
    await createRoleIfMissing(admin, names.runtimeRole, names.runtimePassword);

    // Belt and braces: even if a role was created elsewhere with wider rights,
    // strip the two attributes that would make RLS decorative.
    await admin.query(
      `ALTER ROLE ${quoteIdent(names.runtimeRole)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );

    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      names.database,
    ]);
    if (exists.rowCount === 0) {
      await admin.query(
        `CREATE DATABASE ${quoteIdent(names.database)} OWNER ${quoteIdent(names.migrationRole)}`,
      );
    }

    // The runtime role must be able to reach the database, nothing more.
    await admin.query(
      `REVOKE ALL ON DATABASE ${quoteIdent(names.database)} FROM PUBLIC`,
    );
    await admin.query(
      `GRANT CONNECT ON DATABASE ${quoteIdent(names.database)} TO ${quoteIdent(names.runtimeRole)}`,
    );
  } finally {
    await admin.end();
  }
}

async function createRoleIfMissing(
  admin: PgClient,
  role: string,
  password: string,
): Promise<void> {
  const found = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (found.rowCount === 0) {
    await admin.query(
      `CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD ${quoteLiteral(password)}`,
    );
  }
}

/**
 * Identifiers here come from configuration, never from a request. They are
 * still quoted, because "it comes from config" is how injection bugs start.
 */
function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
