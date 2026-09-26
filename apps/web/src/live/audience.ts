import { conditionsFromFilter, filterFromConditions } from '@convo/domain';
import type { AudienceFilter } from '../api/campaigns.js';
import type { ChannelConnection } from '../api/channels.js';
import type { SavedAudience } from '../api/saved-views.js';
import type { AppState } from '../state.js';
import { rowsOf } from './store.js';

/**
 * A campaign audience, as the editor describes it.
 *
 * The operator picks **where** the people come from — everyone reachable on
 * the channel, contacts carrying labels, people whose conversations carry a
 * label, a hand-picked list, or a saved audience — and may narrow any of them
 * by name. The editor's form holds the choice; the helpers here turn it into
 * the filter the server freezes, and a filter into the condition document a
 * saved audience stores, and back.
 */

export type AudienceSource = 'all' | 'labels' | 'conversations' | 'picked' | 'saved';

export const AUDIENCE_SOURCES: readonly AudienceSource[] = ['all', 'labels', 'conversations', 'picked', 'saved'];

export interface AudienceDraft {
  readonly source: AudienceSource;
  readonly search: string;
  readonly labelIds: readonly string[];
  readonly conversationLabelIds: readonly string[];
  readonly contactIds: readonly string[];
  readonly savedId: string;
}

/** A comma-separated form value as a list, without blanks or repeats. */
export function idList(value: string): readonly string[] {
  return [...new Set(value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== ''))];
}

/** A list with one id added, or removed when it was already there. */
export function toggled(list: readonly string[], id: string): string {
  return (list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id]).join(',');
}

/** Where a saved filter's people came from, for opening an existing draft. */
export function sourceOf(filter: AudienceFilter): AudienceSource {
  if ((filter.contactIds ?? []).length > 0) return 'picked';
  if ((filter.conversationLabelIds ?? []).length > 0) return 'conversations';
  if ((filter.labelIds ?? []).length > 0) return 'labels';
  return 'all';
}

function sourceFrom(value: string | undefined): AudienceSource | null {
  return (AUDIENCE_SOURCES as readonly (string | undefined)[]).includes(value) ? value as AudienceSource : null;
}

/**
 * The editor's audience: what was typed, falling back to what the draft being
 * edited already holds, so an untouched control keeps the saved value.
 */
export function audienceDraft(form: Readonly<Record<string, string>>, initial: AudienceFilter): AudienceDraft {
  const list = (key: string, fallback: readonly string[] | undefined): readonly string[] => {
    const typed = form[key];
    return typed === undefined ? fallback ?? [] : idList(typed);
  };
  return {
    source: sourceFrom(form['campaignAudienceSource']) ?? sourceOf(initial),
    search: form['campaignSearch'] ?? initial.search ?? '',
    labelIds: list('campaignLabelIds', initial.labelIds),
    conversationLabelIds: list('campaignConversationLabelIds', initial.conversationLabelIds),
    contactIds: list('campaignContactIds', initial.contactIds),
    savedId: form['campaignSavedAudience'] ?? '',
  };
}

/**
 * The filter the server should freeze, or `null` when the draft cannot name
 * one yet — a saved audience that is not chosen, or that uses conditions a
 * campaign cannot apply.
 */
export function filterOf(draft: AudienceDraft, saved: readonly SavedAudience[]): AudienceFilter | null {
  const search = draft.search.trim();
  const named: AudienceFilter = search === '' ? {} : { search };
  if (draft.source === 'labels') return { ...named, labelIds: draft.labelIds };
  if (draft.source === 'conversations') return { ...named, conversationLabelIds: draft.conversationLabelIds };
  if (draft.source === 'picked') return { ...named, contactIds: draft.contactIds };
  if (draft.source === 'saved') {
    const audience = saved.find((entry) => entry.id === draft.savedId);
    return audience === undefined ? null : filterFromConditions(audience.conditions);
  }
  return named;
}

export { conditionsFromFilter, filterFromConditions };

/**
 * What the operator still has to choose before this audience means anything,
 * or `null`. A narrowing source with nothing picked would silently widen to
 * everyone on the channel, so it is refused instead.
 */
export function audienceGap(draft: AudienceDraft, filter: AudienceFilter | null): Exclude<AudienceSource, 'all'> | null {
  if (draft.source === 'labels' && draft.labelIds.length === 0) return 'labels';
  if (draft.source === 'conversations' && draft.conversationLabelIds.length === 0) return 'conversations';
  if (draft.source === 'picked' && draft.contactIds.length === 0) return 'picked';
  if (draft.source === 'saved' && filter === null) return 'saved';
  return null;
}

/** Identifies one count: the channel and the exact filter it was taken for. */
export function previewKey(connectionId: string, filter: AudienceFilter): string {
  return `${connectionId}|${JSON.stringify(filter)}`;
}

export interface EditorAudience {
  readonly draft: AudienceDraft;
  readonly filter: AudienceFilter | null;
  readonly connectionId: string;
}

/**
 * The audience in the campaign editor that is open: the draft on screen, the
 * filter it names and the channel it would be counted on. One function, used
 * by the editor and by every action it triggers, so what is counted, saved and
 * frozen is always what the operator is looking at.
 */
export function editorAudience(state: AppState): EditorAudience {
  const live = state.live;
  const dialog = state.dialog;
  const campaign = dialog?.kind === 'campaign-edit'
    ? rowsOf(live.campaigns).find((entry) => entry.id === dialog.arg)
    : undefined;
  const initial = (campaign?.audience_filter ?? {}) as AudienceFilter;
  const draft = audienceDraft(state.dialogForm, initial);
  return {
    draft,
    filter: filterOf(draft, rowsOf(live.audiences)),
    connectionId: state.dialogForm['campaignConnection'] ?? campaign?.connection_id ?? whatsappNumbers(state)[0]?.id ?? '',
  };
}

/**
 * The WhatsApp numbers a broadcast can go from, ready ones first. A campaign
 * saved on another channel before broadcasts were WhatsApp-only keeps its own.
 */
export function whatsappNumbers(state: AppState, keep?: string): readonly ChannelConnection[] {
  const live = rowsOf(state.live.connections).filter((connection) => connection.disconnected_at === null && (connection.kind === 'whatsapp' || connection.id === keep));
  return [...live.filter((connection) => connection.status === 'healthy'), ...live.filter((connection) => connection.status !== 'healthy')];
}
