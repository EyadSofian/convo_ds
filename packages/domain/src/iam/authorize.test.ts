import { describe, expect, it } from 'vitest';
import type { Principal, ResourceRef } from './authorize.js';
import { authorize, projectFields, QUEUE_CARD_FIELDS, reachFor } from './authorize.js';
import type { PermissionKey } from './permissions.js';
import type { BuiltinRoleKey, ScopeLevel } from './roles.js';
import { BUILTIN_ROLES } from './roles.js';

const TEAM = 'team-cairo';
const INBOX = 'inbox-wa-cairo';
const ME = 'membership-hana';
const SOMEONE_ELSE = 'membership-tarek';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    membershipId: ME,
    membershipStatus: 'active',
    tenantStatus: 'active',
    grants: BUILTIN_ROLES.supervisor.grants,
    scopes: [
      { type: 'team', id: TEAM },
      { type: 'inbox', id: INBOX },
    ],
    delegationCeiling: null,
    ...overrides,
  };
}

function asRole(role: BuiltinRoleKey, overrides: Partial<Principal> = {}): Principal {
  return principal({ grants: BUILTIN_ROLES[role].grants, ...overrides });
}

describe('term 1 — active membership', () => {
  it.each(['suspended', 'revoked'] as const)('denies a %s membership outright', (status) => {
    const decision = authorize(principal({ membershipStatus: status }), 'conversation.read', {
      inboxId: INBOX,
      assigneeMembershipId: ME,
    });
    expect(decision).toEqual({ allowed: false, reason: 'membership_inactive' });
  });

  it('denies before it even looks at the grant', () => {
    // An Owner whose membership was revoked has no access at all — the grant
    // term is never reached, which is the point of ordering the terms.
    const decision = authorize(
      asRole('owner', { membershipStatus: 'revoked' }),
      'tenant.delete',
    );
    expect(decision).toEqual({ allowed: false, reason: 'membership_inactive' });
  });
});

describe('term 2 — the tenant', () => {
  it.each(['provisioning', 'suspended', 'deletion_pending', 'deleted'] as const)(
    'denies every action while the tenant is %s',
    (status) => {
      const decision = authorize(asRole('owner', { tenantStatus: status }), 'conversation.read');
      expect(decision).toEqual({ allowed: false, reason: 'tenant_inactive' });
    },
  );
});

describe('term 3 — the action grant', () => {
  it('denies a key the role does not hold', () => {
    expect(authorize(asRole('supervisor'), 'campaign.launch')).toEqual({
      allowed: false,
      reason: 'no_grant',
    });
    expect(authorize(asRole('analyst'), 'conversation.read')).toEqual({
      allowed: false,
      reason: 'no_grant',
    });
  });

  it('allows a tenant-scope grant anywhere inside the tenant', () => {
    expect(authorize(asRole('owner'), 'conversation.read', { inboxId: 'inbox-anything' })).toEqual({
      allowed: true,
      scope: 'tenant',
    });
  });

  it('decides by key, and a role name is never consulted', () => {
    // A principal carrying Admin's grants under any label behaves as Admin;
    // there is no role field to consult, which is the structural guarantee.
    const custom = principal({ grants: { 'conversation.read': 'tenant' } });
    expect(authorize(custom, 'conversation.read')).toEqual({ allowed: true, scope: 'tenant' });
    expect(authorize(custom, 'conversation.reply')).toEqual({
      allowed: false,
      reason: 'no_grant',
    });
  });
});

describe('term 4 — the delegation ceiling', () => {
  it('lets a person through without a ceiling', () => {
    expect(authorize(asRole('owner', { delegationCeiling: null }), 'member.manage')).toEqual({
      allowed: true,
      scope: 'tenant',
    });
  });

  it('refuses a non-delegable key to a credential however wide its ceiling', () => {
    // The ceiling deliberately *contains* the key. It still loses: a credential
    // must never be a path to granting permissions or reaching a secret.
    const key = asRole('owner', { delegationCeiling: ['member.manage', 'channel.manage'] });
    expect(authorize(key, 'member.manage')).toEqual({ allowed: false, reason: 'not_delegable' });
    expect(authorize(key, 'channel.manage')).toEqual({ allowed: false, reason: 'not_delegable' });
  });

  it('refuses a delegable key that is not in the ceiling', () => {
    const key = asRole('owner', { delegationCeiling: ['contact.read'] });
    expect(authorize(key, 'conversation.read')).toEqual({
      allowed: false,
      reason: 'above_delegation_ceiling',
    });
    expect(authorize(key, 'contact.read')).toEqual({ allowed: true, scope: 'tenant' });
  });

  it('never lets a ceiling widen what the role grants', () => {
    const key = asRole('agent', {
      delegationCeiling: ['conversation.read', 'campaign.read'],
      scopes: [{ type: 'inbox', id: INBOX }],
    });
    // In the ceiling, but the role does not grant it.
    expect(authorize(key, 'campaign.read')).toEqual({ allowed: false, reason: 'no_grant' });
  });

  it('applies an empty ceiling as "nothing", not as "no ceiling"', () => {
    const key = asRole('owner', { delegationCeiling: [] });
    expect(authorize(key, 'contact.read')).toEqual({
      allowed: false,
      reason: 'above_delegation_ceiling',
    });
  });
});

describe('term 5 — resource scope', () => {
  it('allows a scoped grant inside a granted inbox', () => {
    expect(authorize(asRole('supervisor'), 'conversation.read', { inboxId: INBOX })).toEqual({
      allowed: true,
      scope: 'scoped',
    });
  });

  it('denies a scoped grant in an inbox the membership does not hold', () => {
    expect(
      authorize(asRole('supervisor'), 'conversation.read', { inboxId: 'inbox-riyadh' }),
    ).toEqual({ allowed: false, reason: 'out_of_scope' });
  });

  it('allows a scoped grant on a resource that names no team or inbox', () => {
    // Listing the teams a supervisor may see is not scoped to one team.
    expect(authorize(asRole('supervisor'), 'report.read')).toEqual({
      allowed: true,
      scope: 'scoped',
    });
  });

  it('matches on either the team or the inbox, not both', () => {
    const inboxOnly = asRole('supervisor', { scopes: [{ type: 'inbox', id: INBOX }] });
    expect(
      authorize(inboxOnly, 'conversation.read', { inboxId: INBOX, teamId: 'team-other' }),
    ).toEqual({ allowed: true, scope: 'scoped' });
  });

  it('honours a tenant-wide scope grant on a scoped role', () => {
    const wide = asRole('supervisor', { scopes: [{ type: 'tenant', id: null }] });
    expect(authorize(wide, 'conversation.read', { inboxId: 'inbox-anywhere' })).toEqual({
      allowed: true,
      scope: 'scoped',
    });
    // Still `scoped`, not `tenant`: a wide scope grant does not upgrade the role.
    expect(authorize(wide, 'conversation.assign', { inboxId: 'x' }).allowed).toBe(true);
  });

  it('denies a membership with no scope grants at all', () => {
    const unscoped = asRole('supervisor', { scopes: [] });
    expect(authorize(unscoped, 'conversation.read', { inboxId: INBOX })).toEqual({
      allowed: false,
      reason: 'out_of_scope',
    });
  });
});

describe('own scope', () => {
  const agent = (): Principal => asRole('agent', { scopes: [{ type: 'inbox', id: INBOX }] });

  it('allows the assignee', () => {
    expect(
      authorize(agent(), 'conversation.read', { inboxId: INBOX, assigneeMembershipId: ME }),
    ).toEqual({ allowed: true, scope: 'own' });
  });

  it('allows a past participant who is no longer the assignee', () => {
    expect(
      authorize(agent(), 'conversation.read', {
        inboxId: INBOX,
        assigneeMembershipId: SOMEONE_ELSE,
        participantMembershipIds: [ME, SOMEONE_ELSE],
      }),
    ).toEqual({ allowed: true, scope: 'own' });
  });

  it('denies someone else’s conversation with a distinct reason', () => {
    expect(
      authorize(agent(), 'conversation.read', {
        inboxId: INBOX,
        assigneeMembershipId: SOMEONE_ELSE,
      }),
    ).toEqual({ allowed: false, reason: 'not_own_resource' });
  });

  it('denies an unassigned conversation to an `own` grant', () => {
    expect(
      authorize(agent(), 'conversation.read', { inboxId: INBOX, assigneeMembershipId: null }),
    ).toEqual({ allowed: false, reason: 'not_own_resource' });
  });

  /**
   * business-rules.md §4.1: losing inbox access overrides assignment and
   * participation immediately. The scope term runs before the ownership term
   * precisely so this cannot be reversed.
   */
  it('lets lost inbox access override assignment', () => {
    const removed = asRole('agent', { scopes: [] });
    expect(
      authorize(removed, 'conversation.read', { inboxId: INBOX, assigneeMembershipId: ME }),
    ).toEqual({ allowed: false, reason: 'out_of_scope' });
  });

  it('still lets an agent preview and claim an unassigned queue card', () => {
    // `conversation.unassigned.preview` and `claim` are `scoped`, not `own`,
    // so an agent can see work before any of it is theirs.
    const card: ResourceRef = { inboxId: INBOX, assigneeMembershipId: null };
    expect(authorize(agent(), 'conversation.unassigned.preview', card)).toEqual({
      allowed: true,
      scope: 'scoped',
    });
    expect(authorize(agent(), 'conversation.claim', card)).toEqual({
      allowed: true,
      scope: 'scoped',
    });
  });
});

describe('reachFor', () => {
  it('reports the widest reach for a screen decision', () => {
    expect(reachFor(asRole('owner'), 'conversation.read')).toBe('tenant');
    expect(reachFor(asRole('supervisor'), 'conversation.read')).toBe('scoped');
    expect(reachFor(asRole('agent'), 'conversation.read')).toBe('own');
    expect(reachFor(asRole('analyst'), 'conversation.read')).toBe('none');
  });

  it('returns none for an inactive membership or tenant', () => {
    expect(reachFor(asRole('owner', { membershipStatus: 'revoked' }), 'report.read')).toBe('none');
    expect(reachFor(asRole('owner', { tenantStatus: 'suspended' }), 'report.read')).toBe('none');
  });

  it('applies the ceiling to a credential', () => {
    expect(
      reachFor(asRole('owner', { delegationCeiling: ['contact.read'] }), 'contact.read'),
    ).toBe('tenant');
    expect(
      reachFor(asRole('owner', { delegationCeiling: ['contact.read'] }), 'conversation.read'),
    ).toBe('none');
    expect(reachFor(asRole('owner', { delegationCeiling: ['member.manage'] }), 'member.manage')).toBe(
      'none',
    );
  });
});

describe('field projection', () => {
  it('builds a new object that never contained the withheld fields', () => {
    const record = { id: 'cv-1', snippet: 'secret', contactPhone: '+20…', priority: 'high' };
    const projected = projectFields(record, ['id', 'priority']);
    expect(projected).toEqual({ id: 'cv-1', priority: 'high' });
    expect(Object.prototype.hasOwnProperty.call(projected, 'snippet')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(projected, 'contactPhone')).toBe(false);
  });

  it('skips a field the record does not carry rather than inventing undefined', () => {
    const projected = projectFields({ id: 'cv-1' } as { id: string; missing?: string }, [
      'id',
      'missing',
    ]);
    expect(Object.prototype.hasOwnProperty.call(projected, 'missing')).toBe(false);
  });

  it('states the queue-card allowlist from business-rules.md §4.1', () => {
    expect(QUEUE_CARD_FIELDS).toEqual([
      'id',
      'inboxLabel',
      'channel',
      'maskedLabel',
      'priority',
      'status',
      'waitingSinceAt',
      'claimable',
      // The concurrency token, not a fact about the customer: IAM-13 requires a
      // claim to carry the version the agent saw, and the agent who sees a card
      // is exactly the one who may not read the conversation to find it.
      'version',
    ]);
    // No transcript, no PII, no assignment detail.
    for (const forbidden of [
      'snippet',
      'contactName',
      'contactPhone',
      'notes',
      'attachments',
      'peerIdentity',
      'assigneeMembershipId',
    ]) {
      expect(QUEUE_CARD_FIELDS as readonly string[]).not.toContain(forbidden);
    }
  });
});

describe('privilege escalation attempts', () => {
  /**
   * Each of these is a way someone might try to widen access. None of them can
   * work, because no term in `authorize` widens anything.
   */
  const escalations: readonly (readonly [string, Principal, PermissionKey, ResourceRef])[] = [
    [
      'an agent claiming a conversation in an inbox they lost',
      asRole('agent', { scopes: [] }),
      'conversation.claim',
      { inboxId: INBOX },
    ],
    [
      'a supervisor launching a campaign',
      asRole('supervisor'),
      'campaign.launch',
      {},
    ],
    [
      'a campaign manager approving their own campaign',
      asRole('campaign_manager', { scopes: [{ type: 'tenant', id: null }] }),
      'campaign.approve',
      {},
    ],
    [
      'an analyst reading a conversation',
      asRole('analyst', { scopes: [{ type: 'tenant', id: null }] }),
      'conversation.read',
      { inboxId: INBOX, assigneeMembershipId: ME },
    ],
    [
      'an integration developer reading contacts',
      asRole('integration_developer', { scopes: [{ type: 'tenant', id: null }] }),
      'contact.read',
      {},
    ],
    [
      'an admin deleting the company',
      asRole('admin', { scopes: [{ type: 'tenant', id: null }] }),
      'tenant.delete',
      {},
    ],
    [
      'an API key rotating a credential',
      asRole('owner', { delegationCeiling: ['credential.rotate'] }),
      'credential.rotate',
      {},
    ],
  ];

  it.each(escalations)('refuses %s', (_name, who, permission, resource) => {
    expect(authorize(who, permission, resource).allowed).toBe(false);
  });
});

describe('every built-in role against every key', () => {
  /**
   * A sweep, not a spot check: for all 7 roles × 29 keys, a decision must never
   * be `allowed` for a key the matrix scores `none`, and never be wider than
   * the matrix says.
   */
  it('never allows more than the matrix', () => {
    const wide: ResourceRef = {
      teamId: TEAM,
      inboxId: INBOX,
      assigneeMembershipId: ME,
      participantMembershipIds: [ME],
    };
    for (const role of Object.keys(BUILTIN_ROLES) as BuiltinRoleKey[]) {
      const who = asRole(role, {
        scopes: [
          { type: 'team', id: TEAM },
          { type: 'inbox', id: INBOX },
        ],
      });
      for (const [key, level] of Object.entries(BUILTIN_ROLES[role].grants) as [
        PermissionKey,
        ScopeLevel,
      ][]) {
        const decision = authorize(who, key, wide);
        expect(decision.allowed, `${role} × ${key}`).toBe(true);
        if (decision.allowed) {
          expect(decision.scope, `${role} × ${key}`).toBe(level);
        }
      }
    }
  });
});
