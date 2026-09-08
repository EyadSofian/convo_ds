import { describe, expect, it } from 'vitest';
import type { ConversationRecord, RoleId } from './data';
import { buildDataset, CURRENT_MEMBER_ID } from './data';
import type { Actor } from './permissions';
import {
  can,
  canAssignOthers,
  canOpenInbox,
  conversationAccess,
  hasTenantScope,
  ROLE_GRANTS,
  ROLE_LABELS,
} from './permissions';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const dataset = buildDataset(NOW);

function actor(role: RoleId, inboxIds: readonly string[] = ['ib-wa-orders']): Actor {
  return {
    memberId: CURRENT_MEMBER_ID,
    name: 'هناء',
    nameEn: 'Hanaa',
    role,
    inboxIds,
    teamIds: ['t-orders'],
  };
}

function conversation(patch: Partial<ConversationRecord> = {}): ConversationRecord {
  const base = dataset.conversations.find((entry) => entry.id === 'cv-4817');
  if (base === undefined) throw new Error('fixture missing');
  return { ...base, ...patch };
}

describe('grants', () => {
  it('checks by key, not by role name', () => {
    expect(can(actor('agent'), 'conversation.reply')).toBe(true);
    expect(can(actor('agent'), 'conversation.assign')).toBe(false);
    expect(can(actor('supervisor'), 'conversation.assign')).toBe(true);
    expect(canAssignOthers(actor('supervisor'))).toBe(true);
    expect(canAssignOthers(actor('agent'))).toBe(false);
  });

  it('gives owner and admin tenant scope only', () => {
    expect(hasTenantScope(actor('owner'))).toBe(true);
    expect(hasTenantScope(actor('admin'))).toBe(true);
    expect(hasTenantScope(actor('supervisor'))).toBe(false);
  });

  it('never grants a campaign role conversation access', () => {
    expect(canOpenInbox(actor('campaign_manager'))).toBe(false);
    expect(canOpenInbox(actor('analyst'))).toBe(false);
    expect(canOpenInbox(actor('agent'))).toBe(true);
  });

  it('labels every role in both languages', () => {
    for (const role of Object.keys(ROLE_GRANTS) as RoleId[]) {
      expect(ROLE_LABELS[role].ar.length).toBeGreaterThan(0);
      expect(ROLE_LABELS[role].en.length).toBeGreaterThan(0);
    }
  });
});

describe('conversationAccess', () => {
  it('denies roles with no conversation grant at all', () => {
    expect(conversationAccess(actor('analyst'), conversation())).toBe('none');
  });

  it('gives tenant-scoped roles full access anywhere', () => {
    expect(conversationAccess(actor('owner', []), conversation())).toBe('full');
  });

  it('denies anything outside the actor’s allowed inboxes', () => {
    expect(conversationAccess(actor('supervisor', ['ib-ig']), conversation())).toBe('none');
  });

  it('gives a supervisor full access inside scope', () => {
    expect(conversationAccess(actor('supervisor'), conversation())).toBe('full');
  });

  it('gives an agent full access only to their own conversations', () => {
    expect(
      conversationAccess(actor('agent'), conversation({ assigneeId: CURRENT_MEMBER_ID })),
    ).toBe('full');
    expect(
      conversationAccess(
        actor('agent'),
        conversation({ assigneeId: null, participantIds: [CURRENT_MEMBER_ID] }),
      ),
    ).toBe('full');
  });

  it('gives an agent a queue projection for unassigned work in scope', () => {
    expect(conversationAccess(actor('agent'), conversation({ assigneeId: null }))).toBe('queue');
  });

  it('hides another agent’s assigned conversation entirely', () => {
    expect(conversationAccess(actor('agent'), conversation({ assigneeId: 'm-tarek' }))).toBe('none');
  });
});
