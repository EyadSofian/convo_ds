import type { QuickReply, QuickReplyInput } from '../api/metadata.js';
import { pushToast } from '../state.js';
import type { LiveContext } from './actions.js';
import { forTenant, fromResult, LOADING, rowsOf } from './store.js';
import { matchQuickReplies, slashToken } from './quick-replies.js';

function t(context: LiveContext, ar: string, en: string): string {
  return context.state.lang === 'ar' ? ar : en;
}

/** The dialog fields a quick reply is edited through. */
export const QUICK_REPLY_FORM = [
  'quickReplyShortcut', 'quickReplyTitle', 'quickReplyBody', 'quickReplyKind',
  'quickReplyPlace', 'quickReplyAddress', 'quickReplyLatitude', 'quickReplyLongitude',
] as const;

/**
 * Loads the saved replies once per workspace visit. `force` re-reads them, for
 * the manager in Settings, where somebody may have just changed one elsewhere.
 */
export async function loadQuickReplies(context: LiveContext, force = false): Promise<void> {
  const { live } = context;
  if (!force && (live.quickReplies.status === 'ready' || live.quickReplies.status === 'loading')) return;
  return forTenant(context, undefined, async (tenantId) => {
    live.quickReplies = LOADING;
    const result = await live.metadataApi.quickReplies(tenantId);
    live.quickReplies = fromResult(result, context.now());
    context.refresh();
  });
}

/**
 * What the dialog would save: what was typed, and for an edit, the stored
 * value of every field nobody touched. A location's coordinates stay text
 * here; the server parses and bounds them.
 */
export function quickReplyInputFrom(form: Readonly<Record<string, string>>, existing: QuickReply | undefined): QuickReplyInput {
  const value = (key: (typeof QUICK_REPLY_FORM)[number], fallback: string): string => (form[key] ?? fallback).trim();
  const kind = value('quickReplyKind', existing?.kind ?? 'text') === 'location' ? 'location' : 'text';
  const place = existing?.location ?? null;
  return {
    shortcut: value('quickReplyShortcut', existing?.shortcut ?? '').replace(/^\//, ''),
    title: value('quickReplyTitle', existing?.title ?? ''),
    kind,
    body: value('quickReplyBody', existing?.body ?? ''),
    location: kind === 'text' ? null : {
      name: value('quickReplyPlace', place?.name ?? ''),
      address: value('quickReplyAddress', place?.address ?? '') || null,
      latitude: Number(value('quickReplyLatitude', place === null ? '' : String(place.latitude)) || Number.NaN),
      longitude: Number(value('quickReplyLongitude', place === null ? '' : String(place.longitude)) || Number.NaN),
    },
  };
}

/** Creates or updates the reply the dialog is open on, then closes it. */
export async function saveQuickReply(context: LiveContext): Promise<boolean> {
  const existing = rowsOf(context.live.quickReplies).find((reply) => reply.id === context.state.dialog?.arg);
  // "New location" opens the same dialog already on the location type.
  const preset = context.state.dialog?.kind === 'quick-reply-location' ? { quickReplyKind: 'location' } : {};
  const input = quickReplyInputFrom({ ...preset, ...context.state.dialogForm }, existing);
  const busy = existing === undefined ? 'quick-reply:create' : `quick-reply:update:${existing.id}`;
  return forTenant(context, false, async (tenantId) => {
    context.live.busy = busy;
    context.live.error = null;
    context.refresh();
    const result = existing === undefined
      ? await context.live.metadataApi.createQuickReply(tenantId, input)
      : await context.live.metadataApi.updateQuickReply(tenantId, existing.id, existing.version, input);
    context.live.busy = null;
    if (!result.ok) {
      context.live.error = result.error;
      context.refresh();
      return false;
    }
    const others = rowsOf(context.live.quickReplies).filter((reply) => reply.id !== result.data.id);
    context.live.quickReplies = { status: 'ready', value: [...others, result.data].sort(byShortcut), loadedAt: context.now() };
    context.state.dialog = null;
    context.state.dialogForm = {};
    pushToast(context.state, existing === undefined ? t(context, 'حُفظ الرد السريع.', 'Quick reply saved.') : t(context, 'تحدّث الرد السريع.', 'Quick reply updated.'));
    context.refresh();
    return true;
  });
}

export async function deleteQuickReply(context: LiveContext, id: string): Promise<boolean> {
  const reply = rowsOf(context.live.quickReplies).find((item) => item.id === id);
  if (reply === undefined) return false;
  return forTenant(context, false, async (tenantId) => {
    context.live.busy = `quick-reply:delete:${id}`;
    context.live.error = null;
    context.refresh();
    const result = await context.live.metadataApi.deleteQuickReply(tenantId, id, reply.version);
    context.live.busy = null;
    if (!result.ok) {
      context.live.error = result.error;
      context.refresh();
      return false;
    }
    context.live.quickReplies = { status: 'ready', value: rowsOf(context.live.quickReplies).filter((item) => item.id !== id), loadedAt: context.now() };
    context.state.dialog = null;
    pushToast(context.state, t(context, 'حُذف الرد السريع.', 'Quick reply deleted.'));
    context.refresh();
    return true;
  });
}

/**
 * Follows the caret in the reply box: opens the "/" list while a shortcut is
 * being typed and closes it otherwise. It redraws only when that changes, so
 * ordinary typing stays as quiet as before.
 */
export function trackSlash(context: LiveContext, caret: number): void {
  const { live } = context;
  const token = slashToken(live.composer, caret);
  const before = live.slash;
  if (token === null && before === null) return;
  if (token !== null && before !== null && token.start === before.start && token.query === before.query) {
    live.slash = token;
    return;
  }
  live.slash = token;
  live.slashActive = 0;
  // The list needs the replies; the first "/" of the visit fetches them.
  if (token !== null && live.quickReplies.status === 'idle') void loadQuickReplies(context);
  context.refresh();
}

/** Arrow keys walk the "/" list, wrapping at either end. */
export function moveSlash(context: LiveContext, step: number): void {
  const { live } = context;
  const count = live.slash === null ? 0 : matchQuickReplies(rowsOf(live.quickReplies), live.slash.query).length;
  if (count === 0) return;
  live.slashActive = (live.slashActive + step + count) % count;
  context.refresh();
}

export function closeSlash(context: LiveContext): void {
  context.live.slash = null;
  context.live.slashActive = 0;
  context.refresh();
}

function byShortcut(left: QuickReply, right: QuickReply): number {
  return left.shortcut.localeCompare(right.shortcut);
}
