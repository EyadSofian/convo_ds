/**
 * What one actor may hand to another.
 *
 * Two different questions, deliberately answered by two functions, because they
 * have two different rules and conflating them is how privilege escalation gets
 * in:
 *
 * - **Assigning an existing role** (inviting someone, changing a membership's
 *   role). The rule is *subset*: you cannot give away reach you do not have.
 *   The `delegable` flag does NOT apply here — `member.manage` is
 *   non-delegable, and if that blocked assignment then an Admin could never
 *   invite another Admin, which is not what the matrix says.
 *
 * - **Authoring a custom role**. The rule is subset **and** delegable
 *   (IAM-14, IAM-19). A key marked non-delegable is one that grants, spends, or
 *   reaches a credential; those may exist in a built-in role the product
 *   defines, but nobody may mint a new role carrying them.
 *
 * Both are pure. Neither knows a role's display name.
 */

import type { PermissionKey } from './permissions.js';
import { isDelegable } from './permissions.js';
import type { ScopeLevel } from './roles.js';
import { scopeCovers } from './roles.js';

export type GrantMap = Readonly<Partial<Record<PermissionKey, ScopeLevel>>>;

export interface DelegationRefusal {
  readonly permission: PermissionKey;
  /**
   * - `not_held` — the actor does not hold the key at all.
   * - `wider_scope` — the actor holds it, but narrower than they are trying to give.
   * - `not_delegable` — the key may never appear in an authored role.
   */
  readonly reason: 'not_held' | 'wider_scope' | 'not_delegable';
}

export type DelegationResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusals: readonly DelegationRefusal[] };

const ALLOWED: DelegationResult = { allowed: true };

/**
 * May `actor` put someone into a role that holds `target`?
 *
 * Every key in the target must be one the actor holds, at a scope the actor's
 * own reach covers. An Owner covers everything; an Admin covers everything
 * except `tenant.delete`, which is exactly why an Admin cannot create another
 * Owner without any rule naming "Owner".
 */
export function canAssignRole(actor: GrantMap, target: GrantMap): DelegationResult {
  return check(actor, target, false);
}

/**
 * May `actor` author a role that holds `requested`?
 *
 * Subset, as above, plus: every key must be delegable. This is the rule that
 * stops someone with `role.manage` from minting "Support Admin" carrying
 * `credential.rotate` and then assigning it to themselves.
 */
export function canAuthorRole(actor: GrantMap, requested: GrantMap): DelegationResult {
  return check(actor, requested, true);
}

function check(actor: GrantMap, target: GrantMap, requireDelegable: boolean): DelegationResult {
  const refusals: DelegationRefusal[] = [];
  // `exactOptionalPropertyTypes` is on, so a key that is present in the map has
  // a defined value — `Partial` here means "may be absent", never "may be
  // explicitly undefined". The assertion states that guarantee instead of
  // adding a guard the type system has already made unreachable.
  const entries = Object.entries(target) as (readonly [PermissionKey, ScopeLevel])[];
  for (const [key, wanted] of entries) {
    if (requireDelegable && !isDelegable(key)) {
      refusals.push({ permission: key, reason: 'not_delegable' });
      continue;
    }
    const held = actor[key];
    if (held === undefined) {
      refusals.push({ permission: key, reason: 'not_held' });
      continue;
    }
    if (!scopeCovers(held, wanted)) {
      refusals.push({ permission: key, reason: 'wider_scope' });
    }
  }
  return refusals.length === 0 ? ALLOWED : { allowed: false, refusals };
}

/**
 * The scopes an actor may attach to someone else's membership.
 *
 * A tenant-wide actor may grant any team or inbox. A scoped actor may grant
 * only the exact teams and inboxes they themselves hold — otherwise "scoped"
 * would be a formality anyone could widen by inviting a colleague to an inbox
 * they cannot see.
 */
export interface ScopeRequest {
  readonly type: 'tenant' | 'team' | 'inbox';
  readonly id: string | null;
}

export function canGrantScopes(
  actorScopes: readonly ScopeRequest[],
  requested: readonly ScopeRequest[],
): DelegationResult {
  const tenantWide = actorScopes.some((scope) => scope.type === 'tenant');
  if (tenantWide) {
    return ALLOWED;
  }
  const held = new Set(actorScopes.map((scope) => `${scope.type}:${String(scope.id)}`));
  const refused = requested.filter((scope) => !held.has(`${scope.type}:${String(scope.id)}`));
  if (refused.length === 0) {
    return ALLOWED;
  }
  // Scope refusals are reported against `member.manage`: the actor is not being
  // denied a permission, they are being denied a reach for the one they hold.
  return {
    allowed: false,
    refusals: refused.map(() => ({ permission: 'member.manage' as const, reason: 'wider_scope' })),
  };
}
