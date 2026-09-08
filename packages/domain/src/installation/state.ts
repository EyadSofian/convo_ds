import type { DeploymentMode } from '@convo/contracts';
import type { SqlExecutor } from '../ports/sql.js';

/**
 * Reconciles the single `installations` row with the validated boot
 * configuration (MODE-01).
 *
 * The row is a mirror, not the authority: the authority is the environment
 * parsed by `parseInstallationConfig`. What the row adds is memory. Once an
 * installation has been provisioned as SaaS, flipping an environment variable
 * must not silently turn it into a single-company install with a different
 * tenancy contract -- that is a data migration (MODE-16), so we refuse and say
 * so instead of booting into a mode the data was not built for.
 */
export type InstallationStateResult =
  | { readonly status: 'created'; readonly deploymentMode: DeploymentMode }
  | {
      readonly status: 'unchanged';
      readonly deploymentMode: DeploymentMode;
      readonly bootstrapState: BootstrapState;
    }
  | {
      readonly status: 'mismatch';
      readonly code: 'installation_mode_mismatch';
      readonly configured: DeploymentMode;
      readonly recorded: string;
      readonly message: string;
    };

export const BOOTSTRAP_STATES = ['pending', 'completed', 'disabled'] as const;
export type BootstrapState = (typeof BOOTSTRAP_STATES)[number];

interface InstallationRow {
  readonly deployment_mode: string;
  readonly bootstrap_state: BootstrapState;
}

export async function applyInstallationConfig(
  sql: SqlExecutor,
  deploymentMode: DeploymentMode,
): Promise<InstallationStateResult> {
  // The singleton UNIQUE constraint is what makes this safe under concurrent
  // boots: the loser of the race takes the DO NOTHING path and then reads the
  // winner's row, rather than creating a second installation.
  const inserted = await sql.query<InstallationRow>(
    `INSERT INTO installations (singleton, deployment_mode)
     VALUES (true, $1)
     ON CONFLICT (singleton) DO NOTHING
     RETURNING deployment_mode, bootstrap_state`,
    [deploymentMode],
  );
  if (inserted.rows.length > 0) {
    return { status: 'created', deploymentMode };
  }

  const existing = await sql.query<InstallationRow>(
    'SELECT deployment_mode, bootstrap_state FROM installations WHERE singleton IS TRUE',
  );
  const row = existing.rows[0];
  /* The row cannot be missing here: the INSERT above either created it or hit
     the singleton conflict, and both happen before this read in the same
     transaction. Reported as an explicit failure rather than a `!` assertion. */
  if (row === undefined) {
    return {
      status: 'mismatch',
      code: 'installation_mode_mismatch',
      configured: deploymentMode,
      recorded: 'missing',
      message: 'The installation row disappeared between insert and read.',
    };
  }
  if (row.deployment_mode !== deploymentMode) {
    return {
      status: 'mismatch',
      code: 'installation_mode_mismatch',
      configured: deploymentMode,
      recorded: row.deployment_mode,
      message:
        `This installation was provisioned as "${row.deployment_mode}" but is configured as ` +
        `"${deploymentMode}". Changing tenancy mode is a data migration, not a restart.`,
    };
  }
  return {
    status: 'unchanged',
    deploymentMode,
    bootstrapState: row.bootstrap_state,
  };
}

export async function readBootstrapState(sql: SqlExecutor): Promise<BootstrapState | null> {
  const result = await sql.query<{ bootstrap_state: BootstrapState }>(
    'SELECT bootstrap_state FROM installations WHERE singleton IS TRUE',
  );
  return result.rows[0]?.bootstrap_state ?? null;
}
