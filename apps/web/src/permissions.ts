import type { ConversationRecord, RoleId } from './data';

/**
 * Client-side mirror of docs/product/business-rules.md §7.
 *
 * Invariant I4 applies: this exists so the operator sees a truthful, explained
 * surface — it is **not** the authorization control. Every check here is also
 * enforced server-side, and a hidden button proves nothing.
 */

export interface Actor {
  readonly memberId: string;
  readonly name: string;
  readonly nameEn: string;
  readonly role: RoleId;
  readonly inboxIds: readonly string[];
  readonly teamIds: readonly string[];
}

export const ROLE_GRANTS: Readonly<Record<RoleId, readonly string[]>> = {
  owner: [
    'conversation.read',
    'conversation.unassigned.preview',
    'conversation.reply',
    'conversation.note',
    'conversation.claim',
    'conversation.assign',
    'conversation.close',
    'contact.read',
    'consent.read',
    'consent.record',
    'campaign.draft',
    'campaign.launch',
    'channel.manage',
    'member.manage',
    'role.manage',
    'report.read',
  ],
  admin: [
    'conversation.read',
    'conversation.unassigned.preview',
    'conversation.reply',
    'conversation.note',
    'conversation.claim',
    'conversation.assign',
    'conversation.close',
    'contact.read',
    'consent.read',
    'consent.record',
    'campaign.draft',
    'campaign.launch',
    'channel.manage',
    'member.manage',
    'role.manage',
    'report.read',
  ],
  supervisor: [
    'conversation.read',
    'conversation.unassigned.preview',
    'conversation.reply',
    'conversation.note',
    'conversation.claim',
    'conversation.assign',
    'conversation.close',
    'contact.read',
    'consent.read',
    'consent.record',
    'report.read',
  ],
  agent: [
    'conversation.read',
    'conversation.unassigned.preview',
    'conversation.reply',
    'conversation.note',
    'conversation.claim',
    'conversation.close',
    'contact.read',
    'consent.read',
  ],
  campaign_manager: ['campaign.draft', 'campaign.launch', 'report.read'],
  analyst: ['report.read'],
};

export const ROLE_LABELS: Readonly<Record<RoleId, { readonly ar: string; readonly en: string }>> = {
  owner: { ar: 'المالك', en: 'Owner' },
  admin: { ar: 'مسؤول', en: 'Admin' },
  supervisor: { ar: 'مشرف', en: 'Supervisor' },
  agent: { ar: 'موظف خدمة', en: 'Agent' },
  campaign_manager: { ar: 'مسؤول حملات', en: 'Campaign manager' },
  analyst: { ar: 'محلل', en: 'Analyst' },
};

export function can(actor: Actor, key: string): boolean {
  return ROLE_GRANTS[actor.role].includes(key);
}

/** Tenant-wide readers: scope is every inbox in the company. */
export function hasTenantScope(actor: Actor): boolean {
  return actor.role === 'owner' || actor.role === 'admin';
}

export type Access = 'full' | 'queue' | 'none';

/**
 * `full` = the permitted timeline may be read.
 * `queue` = only the projected card of §4.1 — no snippet, no timeline, no PII.
 * `none` = the conversation is not disclosed at all (404-shaped, per the API
 * convention that unknown-to-caller resources look nonexistent).
 */
export function conversationAccess(actor: Actor, conversation: ConversationRecord): Access {
  if (!can(actor, 'conversation.read') && !can(actor, 'conversation.unassigned.preview')) {
    return 'none';
  }
  if (hasTenantScope(actor)) return 'full';
  // "Losing inbox access overrides assignment and participation immediately."
  if (!actor.inboxIds.includes(conversation.inboxId)) return 'none';
  if (actor.role === 'supervisor') return 'full';
  const participates =
    conversation.assigneeId === actor.memberId ||
    conversation.participantIds.includes(actor.memberId);
  if (participates) return 'full';
  if (conversation.assigneeId === null && can(actor, 'conversation.unassigned.preview')) {
    return 'queue';
  }
  return 'none';
}

/** Whether this actor may reassign a conversation to somebody else. */
export function canAssignOthers(actor: Actor): boolean {
  return can(actor, 'conversation.assign');
}

/** The inbox screen itself is denied to roles with no conversation grant at all. */
export function canOpenInbox(actor: Actor): boolean {
  return can(actor, 'conversation.read') || can(actor, 'conversation.unassigned.preview');
}
