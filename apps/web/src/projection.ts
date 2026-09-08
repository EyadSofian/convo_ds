import type {
  ChannelKind,
  ConversationRecord,
  ConversationStatus,
  Dataset,
  Priority,
  SlaState,
  TimelineItem,
} from './data';
import { maskDisplayLabel } from './format';
import type { Access, Actor } from './permissions';
import { conversationAccess } from './permissions';

/**
 * The queue-privacy boundary (business-rules §4.1).
 *
 * A projected queue card is a **different shape**, not a full record with fields
 * hidden in CSS: it has no `snippet`, no contact name, no phone, no labels and
 * no assignee. The renderer literally cannot leak what the type does not carry,
 * and `projectThread` refuses to hand back timeline items for a queue card.
 */

export interface FullCard {
  readonly access: 'full';
  readonly id: string;
  readonly reference: string;
  readonly contactName: string;
  readonly channel: ChannelKind;
  readonly inboxId: string;
  readonly teamId: string;
  readonly assigneeId: string | null;
  readonly status: ConversationStatus;
  readonly priority: Priority;
  readonly sla: SlaState;
  readonly labels: readonly string[];
  readonly unreadCount: number;
  readonly lastActivityAt: string;
  readonly waitingSinceAt: string;
  readonly snippet: string;
  readonly snippetDirection: 'in' | 'out';
}

export interface QueueCard {
  readonly access: 'queue';
  readonly id: string;
  readonly reference: string;
  readonly channel: ChannelKind;
  readonly inboxId: string;
  readonly teamId: string;
  readonly maskedLabel: string;
  readonly status: ConversationStatus;
  readonly priority: Priority;
  readonly waitingSinceAt: string;
  readonly lastActivityAt: string;
}

export type ListCard = FullCard | QueueCard;

export function projectCard(
  conversation: ConversationRecord,
  actor: Actor,
  contactName: string,
): ListCard | null {
  const access = conversationAccess(actor, conversation);
  if (access === 'none') return null;
  if (access === 'queue') {
    return {
      access: 'queue',
      id: conversation.id,
      reference: conversation.reference,
      channel: conversation.channel,
      inboxId: conversation.inboxId,
      teamId: conversation.teamId,
      maskedLabel: maskDisplayLabel(contactName),
      status: conversation.status,
      priority: conversation.priority,
      waitingSinceAt: conversation.waitingSinceAt,
      lastActivityAt: conversation.lastActivityAt,
    };
  }
  return {
    access: 'full',
    id: conversation.id,
    reference: conversation.reference,
    contactName,
    channel: conversation.channel,
    inboxId: conversation.inboxId,
    teamId: conversation.teamId,
    assigneeId: conversation.assigneeId,
    status: conversation.status,
    priority: conversation.priority,
    sla: conversation.sla,
    labels: conversation.labels,
    unreadCount: conversation.unreadCount,
    lastActivityAt: conversation.lastActivityAt,
    waitingSinceAt: conversation.waitingSinceAt,
    snippet: conversation.snippet,
    snippetDirection: conversation.snippetDirection,
  };
}

export type ThreadProjection =
  | { readonly access: 'full'; readonly items: readonly TimelineItem[] }
  | { readonly access: 'queue'; readonly maskedLabel: string }
  | { readonly access: 'none' };

export function projectThread(
  conversation: ConversationRecord,
  actor: Actor,
  dataset: Dataset,
): ThreadProjection {
  const access: Access = conversationAccess(actor, conversation);
  if (access === 'none') return { access: 'none' };
  if (access === 'queue') {
    const contact = dataset.contacts.find((entry) => entry.id === conversation.contactId);
    return { access: 'queue', maskedLabel: maskDisplayLabel(contact === undefined ? '' : contact.name) };
  }
  return { access: 'full', items: dataset.timelines[conversation.id] ?? [] };
}

/** Conversations this actor may see at all, in dataset order. */
export function visibleConversations(
  dataset: Dataset,
  actor: Actor,
): readonly ConversationRecord[] {
  return dataset.conversations.filter(
    (conversation) => conversationAccess(actor, conversation) !== 'none',
  );
}

export function contactNameFor(dataset: Dataset, contactId: string): string {
  const contact = dataset.contacts.find((entry) => entry.id === contactId);
  return contact === undefined ? '—' : contact.name;
}
