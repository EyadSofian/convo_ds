import { describe, expect, it } from 'vitest';
import type { GrantMap, ScopeRequest } from './delegation.js';
import { canAssignRole, canAuthorRole, canGrantScopes } from './delegation.js';
import { NON_DELEGABLE_PERMISSIONS } from './permissions.js';
import { BUILTIN_ROLES } from './roles.js';

const OWNER = BUILTIN_ROLES.owner.grants;
const ADMIN = BUILTIN_ROLES.admin.grants;
const SUPERVISOR = BUILTIN_ROLES.supervisor.grants;
const AGENT = BUILTIN_ROLES.agent.grants;

describe('assigning an existing role', () => {
  it('lets an Owner assign every built-in role', () => {
    for (const role of Object.values(BUILTIN_ROLES)) {
      expect(canAssignRole(OWNER, role.grants).allowed, role.key).toBe(true);
    }
  });

  /**
   * The one cell that separates Admin from Owner is `tenant.delete`. No rule
   * here names "Owner" — the refusal falls out of the subset check.
   */
  it('stops an Admin creating another Owner, without naming the role', () => {
    const result = canAssignRole(ADMIN, OWNER);
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('unreachable');
    expect(result.refusals).toEqual([{ permission: 'tenant.delete', reason: 'not_held' }]);
  });

  it('lets an Admin assign every role except Owner', () => {
    for (const role of Object.values(BUILTIN_ROLES)) {
      const expected = role.key !== 'owner';
      expect(canAssignRole(ADMIN, role.grants).allowed, role.key).toBe(expected);
    }
  });

  it('applies no delegable rule to assignment', () => {
    // `member.manage` is non-delegable, but an Admin must still be able to
    // invite another Admin. Blocking that would be the delegable flag leaking
    // into a question it does not govern.
    expect(ADMIN['member.manage']).toBe('tenant');
    expect(canAssignRole(ADMIN, { 'member.manage': 'tenant' }).allowed).toBe(true);
  });

  it('refuses to give away reach the actor does not have', () => {
    // A Supervisor reads conversations at `scoped`; they cannot mint someone
    // who reads the whole tenant.
    const result = canAssignRole(SUPERVISOR, { 'conversation.read': 'tenant' });
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('unreachable');
    expect(result.refusals).toEqual([{ permission: 'conversation.read', reason: 'wider_scope' }]);
  });

  it('allows a narrower scope than the actor holds', () => {
    expect(canAssignRole(SUPERVISOR, { 'conversation.read': 'own' }).allowed).toBe(true);
    expect(canAssignRole(SUPERVISOR, AGENT).allowed).toBe(true);
  });

  it('reports every refusal, not just the first', () => {
    const result = canAssignRole(AGENT, { 'campaign.launch': 'tenant', 'channel.manage': 'tenant' });
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('unreachable');
    expect(result.refusals).toHaveLength(2);
  });

  it('allows an empty role', () => {
    expect(canAssignRole(AGENT, {}).allowed).toBe(true);
  });

  it('treats an absent key as no request for it', () => {
    // An Agent's own map omits every campaign key, so asking whether an Agent
    // may assign the Agent role does not consult keys nobody asked for.
    const sparse: GrantMap = { 'conversation.read': 'own' };
    expect(canAssignRole(AGENT, sparse).allowed).toBe(true);
    expect(Object.keys(AGENT)).not.toContain('campaign.read');
  });
});

describe('authoring a custom role', () => {
  it('refuses every non-delegable key, even to an Owner', () => {
    for (const key of NON_DELEGABLE_PERMISSIONS) {
      const result = canAuthorRole(OWNER, { [key]: 'tenant' });
      expect(result.allowed, key).toBe(false);
      if (result.allowed) throw new Error('unreachable');
      expect(result.refusals).toEqual([{ permission: key, reason: 'not_delegable' }]);
    }
  });

  it('allows delegable keys the actor holds', () => {
    expect(canAuthorRole(OWNER, { 'conversation.read': 'tenant', 'contact.read': 'tenant' }).allowed).toBe(
      true,
    );
    expect(canAuthorRole(SUPERVISOR, { 'conversation.read': 'scoped' }).allowed).toBe(true);
  });

  it('still applies the subset rule to delegable keys', () => {
    const result = canAuthorRole(AGENT, { 'conversation.read': 'tenant' });
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('unreachable');
    expect(result.refusals).toEqual([{ permission: 'conversation.read', reason: 'wider_scope' }]);

    const missing = canAuthorRole(AGENT, { 'campaign.read': 'scoped' });
    expect(missing.allowed).toBe(false);
    if (missing.allowed) throw new Error('unreachable');
    expect(missing.refusals).toEqual([{ permission: 'campaign.read', reason: 'not_held' }]);
  });

  it('cannot be used to mint a role that reaches a credential', () => {
    // The escalation this rule exists to stop: someone with role.manage
    // authoring "Support Admin" carrying credential.rotate.
    const result = canAuthorRole(OWNER, {
      'conversation.read': 'tenant',
      'credential.rotate': 'tenant',
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('unreachable');
    expect(result.refusals.map((refusal) => refusal.permission)).toEqual(['credential.rotate']);
  });
});

describe('granting scopes', () => {
  const team: ScopeRequest = { type: 'team', id: 'team-cairo' };
  const inbox: ScopeRequest = { type: 'inbox', id: 'inbox-wa' };
  const other: ScopeRequest = { type: 'inbox', id: 'inbox-riyadh' };

  it('lets a tenant-wide actor grant anything', () => {
    expect(canGrantScopes([{ type: 'tenant', id: null }], [team, inbox, other]).allowed).toBe(true);
  });

  it('lets a scoped actor grant only what they hold', () => {
    expect(canGrantScopes([team, inbox], [inbox]).allowed).toBe(true);
    expect(canGrantScopes([team, inbox], [team, inbox]).allowed).toBe(true);
  });

  it('refuses a scope the actor cannot see themselves', () => {
    const result = canGrantScopes([team, inbox], [other]);
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('unreachable');
    expect(result.refusals).toEqual([{ permission: 'member.manage', reason: 'wider_scope' }]);
  });

  it('refuses a tenant-wide grant from a scoped actor', () => {
    // Otherwise "scoped" would be a formality: invite a colleague to
    // everything, then read the inbox through them.
    expect(canGrantScopes([inbox], [{ type: 'tenant', id: null }]).allowed).toBe(false);
  });

  it('allows requesting nothing', () => {
    expect(canGrantScopes([inbox], []).allowed).toBe(true);
    expect(canGrantScopes([], []).allowed).toBe(true);
  });

  it('reports one refusal per rejected scope', () => {
    const result = canGrantScopes([inbox], [other, { type: 'team', id: 'team-x' }]);
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('unreachable');
    expect(result.refusals).toHaveLength(2);
  });
});
