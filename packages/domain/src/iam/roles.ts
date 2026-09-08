/**
 * The seven built-in tenant roles and their exact scope matrices.
 *
 * Transcribed from `docs/product/business-rules.md` §7. That table is the
 * product design; this file is its executable form, and `roles.test.ts` asserts
 * every cell of it. Changing a cell here without changing that table (and an
 * ADR) is a bug.
 *
 * **Platform Super Admin is deliberately absent.** It is outside tenant
 * membership entirely: it manages installations, tenant lifecycle, placement,
 * quotas and health through `/platform`, holds no membership, and cannot read a
 * conversation or send a campaign by default. Modelling it as an eighth role
 * here would put it inside the tenant boundary, which is exactly the mistake
 * the business rules forbid.
 */

import type { PermissionKey } from './permissions.js';
import { PERMISSION_KEYS } from './permissions.js';

/**
 * How far a granted action reaches.
 *
 * - `tenant` — every object in the company.
 * - `scoped` — only the teams/inboxes explicitly granted to this membership.
 * - `own`    — only conversations this membership is assigned to or
 *              participating in, inside allowed inboxes.
 * - `none`   — denied. The default for every key a role does not list.
 */
export const SCOPE_LEVELS = ['tenant', 'scoped', 'own', 'none'] as const;
export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

/** Ordering used only to compare two levels; never to "upgrade" one. */
const SCOPE_RANK: Readonly<Record<ScopeLevel, number>> = {
  none: 0,
  own: 1,
  scoped: 2,
  tenant: 3,
};

/** True when `have` reaches at least as far as `need`. */
export function scopeCovers(have: ScopeLevel, need: ScopeLevel): boolean {
  return SCOPE_RANK[have] >= SCOPE_RANK[need];
}

/** The narrower of two levels — the intersection, never the union. */
export function narrowest(a: ScopeLevel, b: ScopeLevel): ScopeLevel {
  return SCOPE_RANK[a] <= SCOPE_RANK[b] ? a : b;
}

export const BUILTIN_ROLE_KEYS = [
  'owner',
  'admin',
  'supervisor',
  'agent',
  'campaign_manager',
  'analyst',
  'integration_developer',
] as const;

export type BuiltinRoleKey = (typeof BUILTIN_ROLE_KEYS)[number];

export interface BuiltinRole {
  readonly key: BuiltinRoleKey;
  readonly name: string;
  /** Every key the role holds, with the scope it holds it at. */
  readonly grants: Readonly<Partial<Record<PermissionKey, ScopeLevel>>>;
  /**
   * Keys this role does not hold by default but that an Owner or Admin may add
   * to it — the "Extra grant" cells in the matrix. Listing them is what makes
   * the difference between "denied" and "not granted yet" reviewable.
   */
  readonly grantable: readonly PermissionKey[];
}

/**
 * `Tenant` on every key in the catalogue. Built from `PERMISSION_KEYS` rather
 * than typed out, so a new permission cannot silently be missing from Owner.
 */
const OWNER_GRANTS: Readonly<Partial<Record<PermissionKey, ScopeLevel>>> = Object.freeze(
  Object.fromEntries(PERMISSION_KEYS.map((key) => [key, 'tenant' as ScopeLevel])),
);

/**
 * Admin is Owner minus the two destructive-ownership capabilities. The matrix
 * reads "Tenant except Owner" for membership management and "Tenant except
 * destructive ownership" for security settings; `tenant.delete` and ownership
 * transfer are the concrete cells behind those words, and both stay with Owner.
 */
const ADMIN_GRANTS: Readonly<Partial<Record<PermissionKey, ScopeLevel>>> = Object.freeze(
  Object.fromEntries(
    PERMISSION_KEYS.filter((key) => key !== 'tenant.delete').map((key) => [
      key,
      'tenant' as ScopeLevel,
    ]),
  ),
);

export const BUILTIN_ROLES: Readonly<Record<BuiltinRoleKey, BuiltinRole>> = Object.freeze({
  owner: {
    key: 'owner',
    name: 'Owner',
    grants: OWNER_GRANTS,
    grantable: [],
  },

  admin: {
    key: 'admin',
    name: 'Admin',
    grants: ADMIN_GRANTS,
    grantable: [],
  },

  supervisor: {
    key: 'supervisor',
    name: 'Supervisor',
    grants: {
      'conversation.read': 'scoped',
      'conversation.unassigned.preview': 'scoped',
      'conversation.reply': 'scoped',
      'conversation.note': 'scoped',
      'conversation.claim': 'scoped',
      'conversation.assign': 'scoped',
      'conversation.close': 'scoped',
      'contact.read': 'scoped',
      'contact.edit': 'scoped',
      'consent.read': 'scoped',
      'consent.record': 'scoped',
      'suppression.write': 'scoped',
      'report.read': 'scoped',
    },
    // "Merge / export contacts: Extra grant" in the matrix.
    grantable: ['contact.merge', 'contact.export'],
  },

  agent: {
    key: 'agent',
    name: 'Agent',
    grants: {
      'conversation.read': 'own',
      // Deliberately `scoped`, not `own`: an agent must see the projected queue
      // for an inbox they are allowed to work before anything is theirs.
      // business-rules.md §4.1 restricts WHAT that card shows, not whether the
      // queue is visible.
      'conversation.unassigned.preview': 'scoped',
      'conversation.claim': 'scoped',
      'conversation.reply': 'own',
      'conversation.note': 'own',
      'conversation.close': 'own',
      'contact.read': 'own',
      'contact.edit': 'own',
      'consent.read': 'own',
      'consent.record': 'own',
      'suppression.write': 'own',
      'report.read': 'own',
    },
    grantable: [],
  },

  campaign_manager: {
    key: 'campaign_manager',
    name: 'Campaign Manager',
    grants: {
      'campaign.read': 'scoped',
      'campaign.draft': 'scoped',
      // `campaign.approve` is absent on purpose: "No by default" in the matrix.
      // Approval is a separate revision-bound record, and the person who builds
      // a campaign is not the person who approves it.
      'campaign.launch': 'scoped',
      'campaign.control': 'scoped',
      'contact.read': 'scoped',
      'contact.edit': 'scoped',
      'consent.read': 'scoped',
      'consent.record': 'scoped',
      'suppression.write': 'scoped',
      'report.read': 'scoped',
    },
    grantable: ['contact.merge', 'contact.export'],
  },

  analyst: {
    key: 'analyst',
    name: 'Analyst',
    grants: {
      // Tenant-wide aggregates, and nothing else. No conversation content, no
      // contact record, no consent detail — only `report.read`.
      'report.read': 'tenant',
    },
    grantable: [],
  },

  integration_developer: {
    key: 'integration_developer',
    name: 'Integration Developer',
    grants: {
      // Configures mappings and webhooks; gets no customer data by virtue of
      // holding the key (business-rules.md §2, actor 7).
      'integration.manage': 'tenant',
      // Integration health only — scoped to what their own integrations report.
      'report.read': 'scoped',
    },
    grantable: [],
  },
});

/** Every grant a role holds, as key/scope pairs, sorted for stable seeding. */
export function grantsOf(role: BuiltinRoleKey): readonly (readonly [PermissionKey, ScopeLevel])[] {
  const grants = BUILTIN_ROLES[role].grants;
  return (Object.keys(grants) as PermissionKey[])
    .sort()
    .map((key) => [key, grants[key] as ScopeLevel] as const);
}

/** The scope a role holds a key at; `none` when it does not hold it at all. */
export function scopeFor(role: BuiltinRoleKey, key: PermissionKey): ScopeLevel {
  return BUILTIN_ROLES[role].grants[key] ?? 'none';
}
