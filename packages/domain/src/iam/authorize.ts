/**
 * The authorization decision.
 *
 * Invariant I3 in `docs/product/business-rules.md`:
 *
 *   effective access = action grant
 *                    ∩ resource scope
 *                    ∩ active membership
 *                    ∩ inbox access
 *                    ∩ field policy
 *                    ∩ credential / support ceiling
 *
 * Every one of those is a separate term below, and every one can only *narrow*
 * the result. There is no branch that widens a decision, which is what makes
 * "default deny" true rather than aspirational.
 *
 * Two rules this module exists to make unbreakable:
 *
 * 1. **Decisions are by permission key, never by role name.** A `Principal`
 *    carries grants, not a role label. There is nowhere to write
 *    `if (role === 'admin')`.
 * 2. **A hidden button is not an authorization control** (I4). This runs on the
 *    server. The browser's copy of the same matrix is a convenience for drawing
 *    the screen, and the endpoint enforces the decision regardless.
 */

import type { PermissionKey } from './permissions.js';
import { isDelegable } from './permissions.js';
import type { ScopeLevel } from './roles.js';

/** A team or inbox the membership is explicitly allowed to work. */
export interface ScopeGrant {
  readonly type: 'tenant' | 'team' | 'inbox';
  /** `null` only for `tenant`. */
  readonly id: string | null;
}

export interface Principal {
  readonly membershipId: string;
  readonly membershipStatus: 'active' | 'suspended' | 'revoked';
  readonly tenantStatus: 'provisioning' | 'active' | 'suspended' | 'deletion_pending' | 'deleted';
  /** What the membership's role grants, by key. Absent key = `none`. */
  readonly grants: Readonly<Partial<Record<PermissionKey, ScopeLevel>>>;
  /** Which teams and inboxes this membership may touch. */
  readonly scopes: readonly ScopeGrant[];
  /**
   * Delegation ceiling for a non-human principal — an API key or a service
   * credential. `null` means "this is a person, no ceiling applies". A present
   * list is a hard upper bound: the principal can never exceed it, however
   * generous the underlying role is.
   */
  readonly delegationCeiling: readonly PermissionKey[] | null;
}

/** What is being touched. Everything is optional; absent means "not scoped". */
export interface ResourceRef {
  readonly teamId?: string | undefined;
  readonly inboxId?: string | undefined;
  /** Membership assigned to the conversation, when there is one. */
  readonly assigneeMembershipId?: string | null | undefined;
  /** Memberships that have participated (replied, noted, claimed). */
  readonly participantMembershipIds?: readonly string[] | undefined;
}

export type DenialReason =
  | 'membership_inactive'
  | 'tenant_inactive'
  | 'no_grant'
  | 'not_delegable'
  | 'above_delegation_ceiling'
  | 'out_of_scope'
  | 'not_own_resource'
  | 'field_not_permitted';

export type Decision =
  | { readonly allowed: true; readonly scope: Exclude<ScopeLevel, 'none'> }
  | { readonly allowed: false; readonly reason: DenialReason };

const DENY = (reason: DenialReason): Decision => ({ allowed: false, reason });

/**
 * Decides one action against one resource.
 *
 * Read it as a sequence of narrowing steps: each `if` can only reject or
 * restrict. Nothing after the first term can restore access the first term
 * denied.
 */
export function authorize(
  principal: Principal,
  permission: PermissionKey,
  resource: ResourceRef = {},
): Decision {
  // ── term 1: active membership ────────────────────────────────────────────
  // A suspended or revoked membership is not a smaller membership. It is none.
  if (principal.membershipStatus !== 'active') {
    return DENY('membership_inactive');
  }

  // ── term 2: the tenant itself ────────────────────────────────────────────
  // A suspended company cannot be worked, whatever the person's role says.
  if (principal.tenantStatus !== 'active') {
    return DENY('tenant_inactive');
  }

  // ── term 3: the action grant ─────────────────────────────────────────────
  const granted = principal.grants[permission] ?? 'none';
  if (granted === 'none') {
    return DENY('no_grant');
  }

  // ── term 4: the credential / delegation ceiling ──────────────────────────
  if (principal.delegationCeiling !== null) {
    // A non-delegable key can never be reached through a delegated credential,
    // even if someone managed to put it in the ceiling list.
    if (!isDelegable(permission)) {
      return DENY('not_delegable');
    }
    if (!principal.delegationCeiling.includes(permission)) {
      return DENY('above_delegation_ceiling');
    }
  }

  // ── term 5: resource scope ───────────────────────────────────────────────
  // The reason names the term that actually failed, not the grant level. An
  // agent who lost inbox access is `out_of_scope`, not `not_own_resource`:
  // the operator's next step is "ask for the inbox back", and the audit line
  // has to say so. Deriving the reason from the grant level instead would
  // report the wrong cause for exactly the case that matters most
  // (business-rules.md §4.1, "losing inbox access overrides assignment").
  const reach = effectiveScope(principal, granted, resource);
  if (reach.kind === 'denied') {
    return DENY(reach.reason);
  }

  return { allowed: true, scope: reach.scope };
}

/**
 * Narrows the granted level against the actual resource.
 *
 * A `tenant` grant still has to be inside the tenant, which the caller
 * guarantees by loading the principal under that tenant's RLS context. A
 * `scoped` grant has to match a team or inbox the membership holds. An `own`
 * grant additionally has to be this membership's assignment or participation.
 */
type ScopeOutcome =
  | { readonly kind: 'allowed'; readonly scope: Exclude<ScopeLevel, 'none'> }
  | { readonly kind: 'denied'; readonly reason: 'out_of_scope' | 'not_own_resource' };

function effectiveScope(
  principal: Principal,
  granted: ScopeLevel,
  resource: ResourceRef,
): ScopeOutcome {
  if (granted === 'tenant') {
    return { kind: 'allowed', scope: 'tenant' };
  }

  // A tenant-wide scope grant satisfies any team/inbox requirement, but it does
  // not turn an `own` grant into a `scoped` one — the level is narrowed by the
  // grant, never widened by the scope.
  const tenantWide = principal.scopes.some((scope) => scope.type === 'tenant');
  const inScope = tenantWide || matchesScope(principal.scopes, resource);
  if (!inScope) {
    return { kind: 'denied', reason: 'out_of_scope' };
  }

  if (granted === 'scoped') {
    return { kind: 'allowed', scope: 'scoped' };
  }

  // granted === 'own'
  if (!isOwnResource(principal.membershipId, resource)) {
    return { kind: 'denied', reason: 'not_own_resource' };
  }
  return { kind: 'allowed', scope: 'own' };
}

/**
 * True when the resource names a team or inbox this membership holds.
 *
 * A resource that names neither is not scoped to anything, so a `scoped` grant
 * covers it — listing the tenant's own teams, for instance. A resource that
 * names both must match at least one; requiring both would make a conversation
 * unreachable to someone granted its inbox but not its team, which is not what
 * "explicitly allowed teams/inboxes" means.
 */
function matchesScope(scopes: readonly ScopeGrant[], resource: ResourceRef): boolean {
  const wanted: ScopeGrant[] = [];
  if (resource.teamId !== undefined) wanted.push({ type: 'team', id: resource.teamId });
  if (resource.inboxId !== undefined) wanted.push({ type: 'inbox', id: resource.inboxId });
  if (wanted.length === 0) {
    return true;
  }
  return wanted.some((want) =>
    scopes.some((scope) => scope.type === want.type && scope.id === want.id),
  );
}

/**
 * "Own" is assignment **or** participation.
 *
 * Participation matters because an agent who replied to a conversation and was
 * then reassigned must still be able to read what they wrote — but losing inbox
 * access overrides both, which is why this is checked *after* the scope term
 * rather than instead of it (business-rules.md §4.1).
 */
function isOwnResource(membershipId: string, resource: ResourceRef): boolean {
  if (resource.assigneeMembershipId === membershipId) {
    return true;
  }
  return resource.participantMembershipIds?.includes(membershipId) ?? false;
}

/* ------------------------------------------------------- field policy -- */

/**
 * Field-level projection: the last term of I3.
 *
 * Hiding a field in the browser is not a control. A caller that is only allowed
 * a projection must be handed a *projection* — an object that never contained
 * the withheld values — which is what this returns.
 */
export function projectFields<T extends object>(
  record: T,
  allowed: readonly (keyof T)[],
): Partial<T> {
  const projection: Partial<T> = {};
  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      projection[field] = record[field];
    }
  }
  return projection;
}

/**
 * The only fields an unassigned queue card may carry before a claim.
 *
 * business-rules.md §4.1: conversation ID, inbox/channel label, masked display
 * label, priority, status, wait time, claim availability. No snippet, no
 * timeline, no notes, no attachments, no contact PII.
 */
export const QUEUE_CARD_FIELDS = [
  'id',
  'inboxLabel',
  'channel',
  'maskedLabel',
  'priority',
  'status',
  'waitingSinceAt',
  'claimable',
] as const;

/**
 * Highest level this principal reaches for a key, ignoring any single resource.
 * Used to decide whether a *screen* is offered at all; never used to authorize
 * an action, which always goes through `authorize` with its resource.
 */
export function reachFor(principal: Principal, permission: PermissionKey): ScopeLevel {
  if (principal.membershipStatus !== 'active' || principal.tenantStatus !== 'active') {
    return 'none';
  }
  const granted = principal.grants[permission] ?? 'none';
  if (granted === 'none') {
    return 'none';
  }
  if (principal.delegationCeiling !== null) {
    if (!isDelegable(permission) || !principal.delegationCeiling.includes(permission)) {
      return 'none';
    }
  }
  return granted;
}
