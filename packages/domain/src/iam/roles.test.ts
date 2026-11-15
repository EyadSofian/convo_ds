import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PermissionKey } from './permissions.js';
import {
  isDelegable,
  isPermissionKey,
  NON_DELEGABLE_PERMISSIONS,
  PERMISSION_KEYS,
} from './permissions.js';
import type { BuiltinRoleKey, ScopeLevel } from './roles.js';
import {
  BUILTIN_ROLE_KEYS,
  BUILTIN_ROLES,
  grantsOf,
  narrowest,
  scopeCovers,
  scopeFor,
  SCOPE_LEVELS,
} from './roles.js';

const ROLE_MIGRATION = readFileSync(
  fileURLToPath(new URL('../../../database/migrations/0007_role_matrix.sql', import.meta.url)),
  'utf8',
);

/**
 * Migrations are forward-only, so the matrix a tenant actually holds is the sum
 * of every migration that seeded into it — not whichever one created the table.
 * Reading only 0007 would let a later migration add a grant this module has
 * never heard of, which is exactly the drift these tests exist to catch.
 */
const GRANT_MIGRATIONS = ['0007_role_matrix.sql', '0018_work_routing.sql', '0019_metadata_catalogue.sql', '0028_automation_foundation.sql', '0064_operations_role.sql'].map((name) =>
  readFileSync(fileURLToPath(new URL(`../../../database/migrations/${name}`, import.meta.url)), 'utf8'),
);

const PERMISSION_MIGRATIONS = ['0003_permission_catalogue.sql', '0018_work_routing.sql', '0019_metadata_catalogue.sql', '0028_automation_foundation.sql'].map((name) =>
  readFileSync(fileURLToPath(new URL(`../../../database/migrations/${name}`, import.meta.url)), 'utf8'),
);

/**
 * Every occurrence of one statement in a migration, bounded at its semicolon.
 *
 * A migration that seeds permissions and then seeds grants would otherwise have
 * its first block run past the second, and the role keys in the later statement
 * would be read as permission keys.
 */
function* statementsOf(migration: string, prefix: string): Generator<string> {
  let from = migration.indexOf(prefix);
  while (from !== -1) {
    const end = migration.indexOf(';', from);
    yield migration.slice(from, end === -1 ? undefined : end);
    from = migration.indexOf(prefix, from + prefix.length);
  }
}

describe('migration 0007 seeds exactly this matrix', () => {
  /**
   * The migration is what a real tenant gets. If it and this module disagree,
   * every authorization decision in the API is made against a matrix the
   * database does not hold — so drift is a build failure, not a review comment.
   */
  it('seeds the same eight roles with the same display names', () => {
    // Every migration that defines a role, in order: 0007 seeded the first
    // seven and 0064 added Operations.
    const seeded = GRANT_MIGRATIONS.flatMap((migration) =>
      [...statementsOf(migration, 'INSERT INTO builtin_role_definitions')].flatMap((block) =>
        [...block.matchAll(/^\s*\('([a-z_]+)', '([^']+)'\)/gm)].map((m) => [
          m[1] as string,
          m[2] as string,
        ]),
      ),
    );
    expect(seeded.map(([key]) => key)).toEqual([...BUILTIN_ROLE_KEYS]);
    for (const [key, name] of seeded) {
      expect(BUILTIN_ROLES[key as BuiltinRoleKey].name).toBe(name);
    }
  });

  it('seeds the same grants at the same scope levels', () => {
    const seeded = GRANT_MIGRATIONS.flatMap((migration) =>
      [...statementsOf(migration, 'INSERT INTO builtin_role_grants')].flatMap((block) =>
        [...block.matchAll(/^\s*\('([a-z_]+)',\s+'([a-z_.]+)', '([a-z]+)'\)/gm)].map(
          (m) => `${m[1] as string}|${m[2] as string}|${m[3] as string}`,
        ),
      ),
    );
    const expected = BUILTIN_ROLE_KEYS.flatMap((role) =>
      grantsOf(role).map(([key, scope]) => `${role}|${key}|${scope}`),
    );
    expect([...seeded].sort()).toEqual([...expected].sort());
    expect(seeded).toHaveLength(expected.length);
  });

  it('never stores a denial as a row', () => {
    // `none` is the absence of a grant. A CHECK that allowed it would create a
    // second way to say "denied", and two representations of denial is how a
    // permission check ends up reading the wrong one.
    expect(ROLE_MIGRATION).toContain("CHECK (scope_level IN ('tenant', 'scoped', 'own'))");
    expect(ROLE_MIGRATION).not.toMatch(/scope_level IN \([^)]*'none'/);
  });

  it('protects the last active Owner in the database, deferred to commit', () => {
    // Deferred, so a transactional demote-then-promote transfer is legal while
    // committing with no Owner is not.
    expect(ROLE_MIGRATION).toContain('CREATE CONSTRAINT TRIGGER memberships_keep_an_owner');
    expect(ROLE_MIGRATION).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(ROLE_MIGRATION).toContain('a company must keep at least one active Owner');
  });
});

describe('permission catalogue', () => {
  /**
   * The database is the authority. If this module and the migration disagree,
   * the domain is reasoning about permissions the server does not have.
   */
  it('matches the seeded catalogue exactly', () => {
    // Every migration that inserts into `permissions`, not just the one that
    // created the table: a key seeded later is a key the database holds.
    const seeded = PERMISSION_MIGRATIONS.flatMap((migration) =>
      [...statementsOf(migration, 'INSERT INTO permissions')].flatMap((block) =>
        [...block.matchAll(/^\s*\('([a-z_.]+)',/gm)].map((m) => m[1] as string),
      ),
    );
    expect([...seeded].sort()).toEqual([...PERMISSION_KEYS].sort());
    // No key seeded twice, in one migration or across two.
    expect(new Set(seeded).size).toBe(seeded.length);
  });

  it('matches the seeded delegable flags exactly', () => {
    const nonDelegable = PERMISSION_MIGRATIONS.flatMap((migration) =>
      [...statementsOf(migration, 'INSERT INTO permissions')].flatMap((block) =>
        [...block.matchAll(/^\s*\('([a-z_.]+)',[^)]*?\bfalse\)/gm)].map((m) => m[1] as string),
      ),
    );
    expect([...nonDelegable].sort()).toEqual([...NON_DELEGABLE_PERMISSIONS].sort());
  });

  it('narrows an untrusted string to a catalogue key', () => {
    expect(isPermissionKey('conversation.read')).toBe(true);
    expect(isPermissionKey('conversation.readAll')).toBe(false);
    expect(isPermissionKey('')).toBe(false);
  });

  it('refuses to delegate anything that grants, spends or reaches a credential', () => {
    expect(isDelegable('integration.manage')).toBe(true);
    expect(isDelegable('conversation.read')).toBe(true);
    for (const key of NON_DELEGABLE_PERMISSIONS) {
      expect(isDelegable(key), key).toBe(false);
    }
  });
});

describe('scope algebra', () => {
  it('orders levels from none to tenant', () => {
    expect(SCOPE_LEVELS).toEqual(['tenant', 'scoped', 'own', 'none']);
    expect(scopeCovers('tenant', 'own')).toBe(true);
    expect(scopeCovers('scoped', 'scoped')).toBe(true);
    expect(scopeCovers('own', 'scoped')).toBe(false);
    expect(scopeCovers('none', 'own')).toBe(false);
  });

  it('always takes the narrower of two levels', () => {
    expect(narrowest('tenant', 'own')).toBe('own');
    expect(narrowest('own', 'tenant')).toBe('own');
    expect(narrowest('scoped', 'scoped')).toBe('scoped');
    expect(narrowest('none', 'tenant')).toBe('none');
  });
});

describe('the eight built-in roles', () => {
  it('defines exactly eight, and no Platform Super Admin among them', () => {
    expect(BUILTIN_ROLE_KEYS).toHaveLength(8);
    expect(Object.keys(BUILTIN_ROLES).sort()).toEqual([...BUILTIN_ROLE_KEYS].sort());
    // Platform Super Admin is outside tenant membership (business-rules.md §7).
    expect(BUILTIN_ROLE_KEYS as readonly string[]).not.toContain('platform_super_admin');
    expect(BUILTIN_ROLE_KEYS as readonly string[]).not.toContain('super_admin');
  });

  it('gives Owner every key in the catalogue at tenant scope', () => {
    for (const key of PERMISSION_KEYS) {
      expect(scopeFor('owner', key), key).toBe('tenant');
    }
  });

  it('gives Admin everything except company deletion', () => {
    for (const key of PERMISSION_KEYS) {
      expect(scopeFor('admin', key), key).toBe(key === 'tenant.delete' ? 'none' : 'tenant');
    }
  });

  /**
   * The matrix in business-rules.md §7, cell by cell. Written out rather than
   * generated: a generated expectation would just restate the implementation.
   */
  const MATRIX: readonly (readonly [PermissionKey, Record<BuiltinRoleKey, ScopeLevel>])[] = [
    [
      'conversation.read',
      { owner: 'tenant', admin: 'tenant', supervisor: 'scoped', agent: 'own', campaign_manager: 'none', analyst: 'none', integration_developer: 'none', operations: 'tenant' },
    ],
    [
      'conversation.reply',
      { owner: 'tenant', admin: 'tenant', supervisor: 'scoped', agent: 'own', campaign_manager: 'none', analyst: 'none', integration_developer: 'none', operations: 'scoped' },
    ],
    [
      'conversation.note',
      { owner: 'tenant', admin: 'tenant', supervisor: 'scoped', agent: 'own', campaign_manager: 'none', analyst: 'none', integration_developer: 'none', operations: 'scoped' },
    ],
    [
      'conversation.unassigned.preview',
      { owner: 'tenant', admin: 'tenant', supervisor: 'scoped', agent: 'scoped', campaign_manager: 'none', analyst: 'none', integration_developer: 'none', operations: 'tenant' },
    ],
    [
      'conversation.claim',
      { owner: 'tenant', admin: 'tenant', supervisor: 'scoped', agent: 'scoped', campaign_manager: 'none', analyst: 'none', integration_developer: 'none', operations: 'scoped' },
    ],
    [
      'conversation.assign',
      { owner: 'tenant', admin: 'tenant', supervisor: 'scoped', agent: 'none', campaign_manager: 'none', analyst: 'none', integration_developer: 'none', operations: 'scoped' },
    ],
    [
      'conversation.close',
      { owner: 'tenant', admin: 'tenant', supervisor: 'scoped', agent: 'own', campaign_manager: 'none', analyst: 'none', integration_developer: 'none', operations: 'scoped' },
    ],
    [
      'contact.edit',
      { owner: 'tenant', admin: 'tenant', supervisor: 'scoped', agent: 'own', campaign_manager: 'scoped', analyst: 'none', integration_developer: 'none', operations: 'scoped' },
    ],
    [
      'contact.merge',
      { owner: 'tenant', admin: 'tenant', supervisor: 'none', agent: 'none', campaign_manager: 'none', analyst: 'none', integration_developer: 'none', operations: 'none' },
    ],
    [
      'contact.export',
      { owner: 'tenant', admin: 'tenant', supervisor: 'none', agent: 'none', campaign_manager: 'none', analyst: 'none', integration_developer: 'none', operations: 'none' },
    ],
    [
      'consent.read',
      { owner: 'tenant', admin: 'tenant', supervisor: 'scoped', agent: 'own', campaign_manager: 'scoped', analyst: 'none', integration_developer: 'none', operations: 'tenant' },
    ],
    [
      'consent.record',
      { owner: 'tenant', admin: 'tenant', supervisor: 'scoped', agent: 'own', campaign_manager: 'scoped', analyst: 'none', integration_developer: 'none', operations: 'scoped' },
    ],
    [
      'campaign.draft',
      { owner: 'tenant', admin: 'tenant', supervisor: 'none', agent: 'none', campaign_manager: 'scoped', analyst: 'none', integration_developer: 'none', operations: 'scoped' },
    ],
    [
      'campaign.approve',
      { owner: 'tenant', admin: 'tenant', supervisor: 'none', agent: 'none', campaign_manager: 'none', analyst: 'none', integration_developer: 'none', operations: 'scoped' },
    ],
    [
      'campaign.launch',
      { owner: 'tenant', admin: 'tenant', supervisor: 'none', agent: 'none', campaign_manager: 'scoped', analyst: 'none', integration_developer: 'none', operations: 'scoped' },
    ],
    [
      'campaign.read',
      { owner: 'tenant', admin: 'tenant', supervisor: 'none', agent: 'none', campaign_manager: 'scoped', analyst: 'none', integration_developer: 'none', operations: 'tenant' },
    ],
    [
      'report.read',
      { owner: 'tenant', admin: 'tenant', supervisor: 'scoped', agent: 'own', campaign_manager: 'scoped', analyst: 'tenant', integration_developer: 'scoped', operations: 'tenant' },
    ],
    [
      'channel.manage',
      { owner: 'tenant', admin: 'tenant', supervisor: 'none', agent: 'none', campaign_manager: 'none', analyst: 'none', integration_developer: 'none', operations: 'none' },
    ],
    [
      'member.manage',
      { owner: 'tenant', admin: 'tenant', supervisor: 'none', agent: 'none', campaign_manager: 'none', analyst: 'none', integration_developer: 'none', operations: 'none' },
    ],
    [
      'role.manage',
      { owner: 'tenant', admin: 'tenant', supervisor: 'none', agent: 'none', campaign_manager: 'none', analyst: 'none', integration_developer: 'none', operations: 'none' },
    ],
    [
      'integration.manage',
      { owner: 'tenant', admin: 'tenant', supervisor: 'none', agent: 'none', campaign_manager: 'none', analyst: 'none', integration_developer: 'tenant', operations: 'none' },
    ],
    [
      'tenant.delete',
      { owner: 'tenant', admin: 'none', supervisor: 'none', agent: 'none', campaign_manager: 'none', analyst: 'none', integration_developer: 'none', operations: 'none' },
    ],
  ];

  it.each(MATRIX)('matches business-rules.md §7 for %s', (key, expected) => {
    for (const role of BUILTIN_ROLE_KEYS) {
      expect(scopeFor(role, key), `${role} × ${key}`).toBe(expected[role]);
    }
  });

  it('keeps an Analyst away from every piece of conversation and contact data', () => {
    const analyst = BUILTIN_ROLES.analyst;
    expect(Object.keys(analyst.grants)).toEqual(['report.read']);
    expect(scopeFor('analyst', 'conversation.read')).toBe('none');
    expect(scopeFor('analyst', 'contact.read')).toBe('none');
    expect(scopeFor('analyst', 'consent.read')).toBe('none');
  });

  it('gives an Integration Developer no customer data for holding the key', () => {
    expect(scopeFor('integration_developer', 'conversation.read')).toBe('none');
    expect(scopeFor('integration_developer', 'contact.read')).toBe('none');
    expect(scopeFor('integration_developer', 'campaign.read')).toBe('none');
  });

  it('never grants a Campaign Manager approval of their own campaign', () => {
    expect(scopeFor('campaign_manager', 'campaign.approve')).toBe('none');
    expect(scopeFor('campaign_manager', 'campaign.launch')).toBe('scoped');
  });

  it('lets Operations read every inbox and act only on its own', () => {
    const operations = BUILTIN_ROLES.operations.grants;
    // Reads reach the whole company, so another inbox can be watched.
    for (const key of ['conversation.read', 'conversation.unassigned.preview', 'contact.read', 'consent.read', 'campaign.read', 'report.read'] as const) {
      expect(operations[key], key).toBe('tenant');
    }
    // Every act is held to the inboxes on the membership's scope.
    for (const [key, scope] of grantsOf('operations')) {
      if (key.endsWith('.read') || key.endsWith('.preview')) continue;
      expect(scope, key).toBe('scoped');
    }
    // It sends campaigns end to end, but never manages channels or people.
    expect(scopeFor('operations', 'campaign.approve')).toBe('scoped');
    expect(scopeFor('operations', 'campaign.launch')).toBe('scoped');
    expect(scopeFor('operations', 'channel.manage')).toBe('none');
    expect(scopeFor('operations', 'member.manage')).toBe('none');
    expect(scopeFor('operations', 'contact.export')).toBe('none');
  });

  it('records merge and export as an extra grant, not a silent denial', () => {
    expect(BUILTIN_ROLES.supervisor.grantable).toEqual(['contact.merge', 'contact.export']);
    expect(BUILTIN_ROLES.campaign_manager.grantable).toEqual(['contact.merge', 'contact.export']);
    expect(BUILTIN_ROLES.agent.grantable).toEqual([]);
  });

  it('lists a role’s grants sorted and complete', () => {
    const grants = grantsOf('supervisor');
    expect(grants.map(([key]) => key)).toEqual([...grants.map(([key]) => key)].sort());
    expect(grants).toHaveLength(Object.keys(BUILTIN_ROLES.supervisor.grants).length);
    expect(grants).toContainEqual(['conversation.assign', 'scoped']);
    expect(grantsOf('owner')).toHaveLength(PERMISSION_KEYS.length);
  });

  it('never grants a key outside the catalogue', () => {
    for (const role of BUILTIN_ROLE_KEYS) {
      for (const [key] of grantsOf(role)) {
        expect(isPermissionKey(key), `${role} grants unknown ${key}`).toBe(true);
      }
    }
  });
});
