import type { ErrorDetail } from '@convo/contracts';
import type { SqlExecutor, TenantTransaction } from '../ports/sql.js';

/**
 * The one-time installation bootstrap (MODE-03).
 *
 * It creates exactly one company, one Owner identity, the built-in Owner role
 * carrying the whole permission catalogue, and the membership that binds them.
 * Then it disables itself. Every later attempt is a **typed rejection**, not an
 * exception and not a second company: an operator who double-clicks the form,
 * a retried HTTP request and a second replica racing at boot must all be
 * harmless.
 *
 * The one-time flag is claimed with a conditional UPDATE inside the same
 * transaction as the writes it guards. That is the whole concurrency argument:
 * two callers cannot both see `pending`, because the first one's row lock is
 * held until commit, and the second then reads `completed` and loses.
 */
export interface InstallationBootstrapInput {
  readonly companyName: string;
  readonly companySlug: string;
  readonly ownerEmail: string;
  /** Already hashed by the caller. This module never sees a plaintext password. */
  readonly ownerPasswordHash: string;
}

export interface InstallationBootstrapDeps {
  readonly transaction: TenantTransaction;
  readonly newId: () => string;
}

export type InstallationBootstrapResult =
  | {
      readonly status: 'created';
      readonly tenantId: string;
      readonly ownerUserId: string;
      readonly ownerRoleId: string;
      readonly membershipId: string;
    }
  | {
      readonly status: 'rejected';
      readonly code: InstallationBootstrapRejection;
      readonly message: string;
      readonly details: readonly ErrorDetail[];
    };

export type InstallationBootstrapRejection =
  | 'installation_not_configured'
  | 'installation_already_bootstrapped'
  | 'invalid_input';

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** Argon2id or bcrypt. Refusing anything else stops a plaintext password here. */
const PASSWORD_HASH_PATTERN = /^\$(argon2(id|i|d)|2[aby])\$/;
const MAX_NAME_LENGTH = 80;
const MAX_EMAIL_LENGTH = 254;

export async function bootstrapInstallation(
  deps: InstallationBootstrapDeps,
  input: InstallationBootstrapInput,
): Promise<InstallationBootstrapResult> {
  const details = validate(input);
  if (details.length > 0) {
    return {
      status: 'rejected',
      code: 'invalid_input',
      message: 'The installation bootstrap request is not valid.',
      details,
    };
  }

  const tenantId = deps.newId();
  const ownerUserId = deps.newId();

  return deps.transaction(tenantId, async (sql) => {
    const claim = await claimBootstrap(sql);
    if (claim !== 'claimed') {
      return rejection(claim);
    }
    return writeFirstCompany(sql, {
      tenantId,
      ownerUserId,
      companyName: input.companyName.trim(),
      companySlug: input.companySlug.trim(),
      ownerEmail: input.ownerEmail.trim(),
      ownerPasswordHash: input.ownerPasswordHash,
    });
  });
}

type ClaimOutcome = 'claimed' | 'installation_not_configured' | 'installation_already_bootstrapped';

async function claimBootstrap(sql: SqlExecutor): Promise<ClaimOutcome> {
  const claimed = await sql.query<{ id: string }>(
    `UPDATE installations
        SET bootstrap_state = 'completed'
      WHERE singleton IS TRUE AND bootstrap_state = 'pending'
      RETURNING id`,
  );
  if (claimed.rows.length > 0) {
    return 'claimed';
  }
  // Nothing was claimed. Distinguish "never configured" from "already used",
  // because the operator's next action is completely different.
  const present = await sql.query<{ id: string }>(
    'SELECT id FROM installations WHERE singleton IS TRUE',
  );
  return present.rows.length === 0
    ? 'installation_not_configured'
    : 'installation_already_bootstrapped';
}

interface FirstCompanyWrite {
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly companyName: string;
  readonly companySlug: string;
  readonly ownerEmail: string;
  readonly ownerPasswordHash: string;
}

async function writeFirstCompany(
  sql: SqlExecutor,
  write: FirstCompanyWrite,
): Promise<InstallationBootstrapResult> {
  // `users` is global identity and lives outside tenant RLS.
  await sql.query(
    `INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, $3, 'active')`,
    [write.ownerUserId, write.ownerEmail, write.ownerPasswordHash],
  );

  await sql.query(
    `INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, 'active')`,
    [write.tenantId, write.companyName, write.companySlug],
  );

  const role = await sql.query<{ id: string }>(
    `INSERT INTO roles (tenant_id, key, name, is_builtin)
     VALUES ($1, 'owner', 'Owner', true)
     RETURNING id`,
    [write.tenantId],
  );
  const ownerRoleId = role.rows[0]?.id;
  if (ownerRoleId === undefined) {
    throw new Error('Owner role insert returned no id');
  }

  // The Owner holds the catalogue by key, never by role name (IAM-08).
  await sql.query(
    `INSERT INTO role_permissions (tenant_id, role_id, permission_key)
     SELECT $1, $2, key FROM permissions`,
    [write.tenantId, ownerRoleId],
  );

  const membership = await sql.query<{ id: string }>(
    `INSERT INTO memberships (tenant_id, user_id, role_id, status)
     VALUES ($1, $2, $3, 'active')
     RETURNING id`,
    [write.tenantId, write.ownerUserId, ownerRoleId],
  );
  const membershipId = membership.rows[0]?.id;
  if (membershipId === undefined) {
    throw new Error('Owner membership insert returned no id');
  }

  await sql.query(
    `INSERT INTO membership_scopes (tenant_id, membership_id, scope_type, scope_id)
     VALUES ($1, $2, 'tenant', NULL)`,
    [write.tenantId, membershipId],
  );

  return {
    status: 'created',
    tenantId: write.tenantId,
    ownerUserId: write.ownerUserId,
    ownerRoleId,
    membershipId,
  };
}

function rejection(
  code: 'installation_not_configured' | 'installation_already_bootstrapped',
): InstallationBootstrapResult {
  return {
    status: 'rejected',
    code,
    message:
      code === 'installation_already_bootstrapped'
        ? 'This installation has already been bootstrapped.'
        : 'This installation has no configuration row; start the application before bootstrapping.',
    details: [],
  };
}

function validate(input: InstallationBootstrapInput): ErrorDetail[] {
  const details: ErrorDetail[] = [];
  const name = input.companyName.trim();
  if (name === '') {
    details.push(detail('companyName', 'required', 'A company name is required.'));
  } else if (name.length > MAX_NAME_LENGTH) {
    details.push(
      detail('companyName', 'too_long', `At most ${MAX_NAME_LENGTH} characters are allowed.`),
    );
  }

  const slug = input.companySlug.trim();
  if (!SLUG_PATTERN.test(slug)) {
    details.push(
      detail(
        'companySlug',
        'malformed',
        'A slug is 1-40 lowercase letters, digits or hyphens and cannot start or end with a hyphen.',
      ),
    );
  }

  const email = input.ownerEmail.trim();
  if (!isPlausibleEmail(email)) {
    details.push(detail('ownerEmail', 'malformed', 'A valid owner email address is required.'));
  }

  if (!PASSWORD_HASH_PATTERN.test(input.ownerPasswordHash)) {
    details.push(
      detail(
        'ownerPasswordHash',
        'not_a_supported_hash',
        'The owner password must arrive already hashed with argon2 or bcrypt.',
      ),
    );
  }
  return details;
}

/**
 * Deliberately conservative rather than clever. Full RFC 5322 acceptance is not
 * the goal; refusing whitespace, missing parts and unbounded length is.
 */
function isPlausibleEmail(value: string): boolean {
  if (value.length === 0 || value.length > MAX_EMAIL_LENGTH || /\s/.test(value)) {
    return false;
  }
  const parts = value.split('@');
  if (parts.length !== 2) {
    return false;
  }
  const [local, domain] = parts;
  if (local === undefined || domain === undefined || local === '') {
    return false;
  }
  return /^[^.@]+(?:\.[^.@]+)*\.[A-Za-z]{2,}$/.test(domain);
}

function detail(field: string, code: string, message: string): ErrorDetail {
  return { field, code, message };
}
