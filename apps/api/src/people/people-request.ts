import type { ErrorDetail } from '@convo/contracts';
import type { PermissionKey, ScopeLevel } from '@convo/domain';
import { isPermissionKey } from '@convo/domain';

/**
 * Request parsing for the People, Roles and Teams mutations.
 *
 * Every parser is total and pure: it either returns a value the service can act
 * on without re-checking its shape, or a list of field-level rejections. No
 * service below this line asks "is this a string".
 */

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly details: readonly ErrorDetail[] };

export interface ScopeInput {
  readonly type: 'tenant' | 'team' | 'inbox';
  readonly id: string | null;
}

export interface UpdateMembershipRequest {
  /** Absent means "leave it alone" — distinct from "set it to nothing". */
  readonly roleId?: string | undefined;
  readonly status?: 'active' | 'suspended' | 'revoked' | undefined;
  readonly scopes?: readonly ScopeInput[] | undefined;
}

export interface RoleGrantInput {
  readonly permission: PermissionKey;
  readonly scope: Exclude<ScopeLevel, 'none'>;
}

export interface WriteRoleRequest {
  readonly name: string;
  readonly description: string;
  readonly grants: readonly RoleGrantInput[];
}

export interface WriteTeamRequest {
  readonly name: string;
  readonly archived: boolean;
}

export interface TeamMemberRequest {
  readonly membershipId: string;
}

export interface OwnershipOfferRequest {
  readonly membershipId: string;
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 280;
const MAX_SCOPES = 50;
const MAX_GRANTS = 64;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function malformedBody(): ParseResult<never> {
  return {
    ok: false,
    details: [{ field: 'body', code: 'malformed', message: 'The body must be an object.' }],
  };
}

/** Shared by every parser that accepts a scope list. */
function parseScopes(raw: unknown, details: ErrorDetail[]): ScopeInput[] {
  const scopes: ScopeInput[] = [];
  if (!Array.isArray(raw)) {
    details.push({ field: 'scopes', code: 'malformed', message: 'Scopes must be an array.' });
    return scopes;
  }
  if (raw.length > MAX_SCOPES) {
    details.push({ field: 'scopes', code: 'too_many', message: `At most ${String(MAX_SCOPES)}.` });
    return scopes;
  }
  for (const [index, entry] of raw.entries()) {
    const scope = asRecord(entry);
    const type = scope?.['type'];
    const id = scope?.['id'] ?? null;
    const typed = type === 'tenant' || type === 'team' || type === 'inbox';
    const idOk = type === 'tenant' ? id === null : isUuid(id);
    if (!typed || !idOk) {
      details.push({
        field: `scopes.${String(index)}`,
        code: 'malformed',
        message: 'Each scope is {type: tenant|team|inbox, id}; only a tenant scope has a null id.',
      });
      continue;
    }
    scopes.push({ type, id: type === 'tenant' ? null : (id as string) });
  }
  return scopes;
}

export function parseUpdateMembership(input: unknown): ParseResult<UpdateMembershipRequest> {
  const record = asRecord(input);
  if (record === null) {
    return malformedBody();
  }
  const details: ErrorDetail[] = [];
  const result: {
    roleId?: string;
    status?: 'active' | 'suspended' | 'revoked';
    scopes?: readonly ScopeInput[];
  } = {};

  if ('roleId' in record) {
    if (!isUuid(record['roleId'])) {
      details.push({ field: 'roleId', code: 'malformed', message: 'Provide a role id.' });
    } else {
      result.roleId = record['roleId'];
    }
  }
  if ('status' in record) {
    const status = record['status'];
    if (status !== 'active' && status !== 'suspended' && status !== 'revoked') {
      details.push({
        field: 'status',
        code: 'malformed',
        message: 'Status is active, suspended or revoked.',
      });
    } else {
      result.status = status;
    }
  }
  if ('scopes' in record) {
    const scopes = parseScopes(record['scopes'], details);
    result.scopes = scopes;
  }

  if (details.length > 0) {
    return { ok: false, details };
  }
  if (result.roleId === undefined && result.status === undefined && result.scopes === undefined) {
    // An empty patch is a client bug, not a no-op to absorb silently: it means
    // the caller believes it changed something.
    return {
      ok: false,
      details: [
        { field: 'body', code: 'empty', message: 'Provide at least one of roleId, status, scopes.' },
      ],
    };
  }
  return { ok: true, value: result };
}

export function parseWriteRole(input: unknown): ParseResult<WriteRoleRequest> {
  const record = asRecord(input);
  if (record === null) {
    return malformedBody();
  }
  const details: ErrorDetail[] = [];
  const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
  const description =
    typeof record['description'] === 'string' ? record['description'].trim() : '';
  const rawGrants = record['grants'];

  if (name.length === 0 || name.length > MAX_NAME) {
    details.push({
      field: 'name',
      code: 'malformed',
      message: `Provide a name of 1 to ${String(MAX_NAME)} characters.`,
    });
  }
  if (description.length > MAX_DESCRIPTION) {
    details.push({
      field: 'description',
      code: 'too_long',
      message: `At most ${String(MAX_DESCRIPTION)} characters.`,
    });
  }

  const grants: RoleGrantInput[] = [];
  if (!Array.isArray(rawGrants)) {
    details.push({ field: 'grants', code: 'malformed', message: 'Grants must be an array.' });
  } else if (rawGrants.length > MAX_GRANTS) {
    details.push({ field: 'grants', code: 'too_many', message: `At most ${String(MAX_GRANTS)}.` });
  } else {
    const seen = new Set<string>();
    for (const [index, entry] of rawGrants.entries()) {
      const grant = asRecord(entry);
      const permission = grant?.['permission'];
      const scope = grant?.['scope'];
      const keyOk = typeof permission === 'string' && isPermissionKey(permission);
      // `none` is rejected here for the same reason the column's CHECK rejects
      // it: a denial is the absence of a grant, and admitting a second spelling
      // would give every later reader two things to check.
      const scopeOk = scope === 'tenant' || scope === 'scoped' || scope === 'own';
      if (!keyOk || !scopeOk) {
        details.push({
          field: `grants.${String(index)}`,
          code: 'malformed',
          message: 'Each grant is {permission: <catalogue key>, scope: tenant|scoped|own}.',
        });
        continue;
      }
      if (seen.has(permission)) {
        details.push({
          field: `grants.${String(index)}`,
          code: 'duplicate',
          message: 'This permission is listed twice.',
        });
        continue;
      }
      seen.add(permission);
      grants.push({ permission, scope });
    }
  }

  if (details.length > 0) {
    return { ok: false, details };
  }
  return { ok: true, value: { name, description, grants } };
}

export function parseWriteTeam(input: unknown): ParseResult<WriteTeamRequest> {
  const record = asRecord(input);
  if (record === null) {
    return malformedBody();
  }
  const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
  if (name.length === 0 || name.length > MAX_NAME) {
    return {
      ok: false,
      details: [
        {
          field: 'name',
          code: 'malformed',
          message: `Provide a name of 1 to ${String(MAX_NAME)} characters.`,
        },
      ],
    };
  }
  const archived = record['archived'];
  if (archived !== undefined && typeof archived !== 'boolean') {
    return {
      ok: false,
      details: [{ field: 'archived', code: 'malformed', message: 'Archived is true or false.' }],
    };
  }
  return { ok: true, value: { name, archived: archived === true } };
}

/** Shared by team membership and the ownership offer: one membership id. */
export function parseMembershipRef(input: unknown, field: string): ParseResult<{ membershipId: string }> {
  const record = asRecord(input);
  if (record === null) {
    return malformedBody();
  }
  const value = record[field];
  if (!isUuid(value)) {
    return {
      ok: false,
      details: [{ field, code: 'malformed', message: 'Provide a membership id.' }],
    };
  }
  return { ok: true, value: { membershipId: value } };
}
