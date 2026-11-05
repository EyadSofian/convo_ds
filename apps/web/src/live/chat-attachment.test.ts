import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createState } from '../state.js';
import { ready } from './store.js';
import type { LiveContext } from './actions.js';
import { selectAttachment, sendAttachment } from './chat-attachment.js';
import { loadTimeline } from './inbox-actions.js';
import { voiceDraft } from './voice-message.js';

vi.mock('./inbox-actions.js', () => ({ loadTimeline: vi.fn() }));
vi.mock('./voice-message.js', () => ({ voiceDraft: vi.fn().mockReturnValue(null) }));

function setup(lang: 'en' | 'ar' = 'en') {
  const state = createState(new Date());
  state.lang = lang;
  const live = state.live;
  live.session = { status: 'signed_in', email: 'agent@example.test', memberships: [], tenantId: 'tenant' };
  live.openConversationId = 'thread';
  live.openConversation = ready({ id: 'thread', channel: 'whatsapp' } as never, 1);
  Object.defineProperty(live, 'conversationsApi', { value: { replyFile: vi.fn().mockResolvedValue({ ok: true }) } });
  return { state, live, refresh: vi.fn(), newKey: () => 'attachment-id', now: () => 1 } as unknown as LiveContext;
}

const pdf = new File(['%PDF-1.4'], 'guide.pdf', { type: 'application/pdf' });
describe('attachment drafts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the same key for retry after network failure and reloads the same timeline on success', async () => {
    const context = setup();
    vi.mocked(context.live.conversationsApi.replyFile).mockResolvedValueOnce({ ok: false, error: { message: 'Offline' } } as never);
    expect(await sendAttachment(context)).toBe(false);
    selectAttachment(context, pdf);
    expect(await sendAttachment(context)).toBe(false);
    expect(context.live.attachmentDraft?.error).toBe('Offline');
    expect(await sendAttachment(context)).toBe(true);
    expect(context.live.attachmentDraft).toBeNull();
    expect(context.live.conversationsApi.replyFile).toHaveBeenNthCalledWith(2, 'tenant', 'thread', pdf, 'attachment-id');
    expect(loadTimeline).toHaveBeenCalledWith(context, 'thread');
  });

  it.each(['en', 'ar'] as const)('blocks empty, oversized and incompatible files locally (%s)', async (lang) => {
    const context = setup(lang);
    for (const file of [
      new File([], 'empty.pdf', { type: 'application/pdf' }),
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.pdf', { type: 'application/pdf' }),
      new File(['<svg/>'], 'unsafe.svg', { type: 'image/svg+xml' }),
    ]) {
      selectAttachment(context, file);
      expect(context.live.attachmentDraft?.error).toBeTruthy();
      expect(await sendAttachment(context)).toBe(false);
    }
    expect(context.live.conversationsApi.replyFile).not.toHaveBeenCalled();
  });

  it('leaves drafts alone while recording, uploading or switching conversations', async () => {
    const context = setup();
    vi.mocked(voiceDraft).mockReturnValueOnce({ status: 'recording' } as never);
    selectAttachment(context, pdf);
    expect(context.live.attachmentDraft).toBeNull();
    selectAttachment(context, pdf);
    const draft = context.live.attachmentDraft!;
    let finish!: (result: unknown) => void;
    vi.mocked(context.live.conversationsApi.replyFile).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }) as never);
    const pending = sendAttachment(context);
    expect(await sendAttachment(context)).toBe(false);
    selectAttachment(context, pdf);
    expect(context.live.attachmentDraft).toBe(draft);
    context.live.attachmentDraft = null;
    finish({ ok: true });
    expect(await pending).toBe(true);
    expect(loadTimeline).not.toHaveBeenCalled();
    const open = context.live.openConversation;
    context.live.openConversation = { status: 'loading' };
    selectAttachment(context, pdf);
    expect(context.live.attachmentDraft).toBeNull();
    context.live.openConversation = open;
    selectAttachment(context, pdf);
    context.live.openConversation = { status: 'loading' };
    expect(await sendAttachment(context)).toBe(false);
    context.live.openConversation = open;
    context.live.openConversationId = 'other';
    expect(await sendAttachment(context)).toBe(false);
    context.live.session = { status: 'signed_out', error: null };
    expect(await sendAttachment(context)).toBe(false);
  });
});
