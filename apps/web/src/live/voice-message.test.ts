import { afterEach, describe, expect, it, vi } from 'vitest';
import { createState } from '../state.js';
import { ready } from './store.js';
import type { LiveContext } from './actions.js';
import { cancelVoice, sendVoice, startVoice, stopVoice, syncVoice, voiceDraft } from './voice-message.js';
import { loadTimeline } from './inbox-actions.js';
vi.mock('./inbox-actions.js', () => ({ loadTimeline: vi.fn() }));
function context() {
  const state = createState(new Date()); state.lang = 'en'; state.route = { screen: 'inbox', conversationId: 'c', params: {} }; state.composerTab = 'reply';
  const live = state.live; live.session = { status: 'signed_in', email: 'a@b.c', memberships: [], tenantId: 't' };
  live.openConversationId = 'c'; live.openConversation = ready({ id: 'c', channel: 'whatsapp', assigneeMembershipId: 'm', capabilities: { reply: true }, serviceWindow: { status: 'open' } } as never, 1);
  Object.defineProperty(live, 'conversationsApi', { value: { replyVoice: vi.fn().mockResolvedValue({ ok: true }) } });
  return { state, live, refresh: vi.fn(), newKey: () => 'same-key', now: () => 1 } as unknown as LiveContext;
}
class Recorder {
  static supported = true;
  static isTypeSupported() { return this.supported; }
  static last: Recorder;
  state = 'inactive'; mimeType = 'audio/webm'; onstop?: () => void; onerror?: () => void; ondataavailable?: (event: { data: Blob }) => void;
  constructor() { Recorder.last = this; }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.onstop?.(); }
  data(text = 'audio') { this.ondataavailable?.({ data: new Blob([text]) }); }
}
function browser() {
  const stop = vi.fn(); const stream = { getTracks: () => [{ stop }] };
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } }); vi.stubGlobal('MediaRecorder', Recorder);
  Recorder.supported = true;
  return { stop, stream, getUserMedia };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('voice recording lifecycle', () => {
  it('records, previews, sends the same idempotency key on retry and releases the microphone', async () => {
    const c = context(); const b = browser(); expect(voiceDraft(c.live)).toBeNull(); stopVoice(c); cancelVoice(c.live); syncVoice(c);
    expect(await sendVoice(c)).toBe(false);
    expect(await startVoice(c)).toBe(true); expect(await startVoice(c)).toBe(false); expect(voiceDraft(c.live)?.status).toBe('recording');
    Recorder.last.data(); stopVoice(c); expect(b.stop).toHaveBeenCalled(); expect(voiceDraft(c.live)?.status).toBe('ready');
    vi.mocked(c.live.conversationsApi.replyVoice).mockResolvedValueOnce({ ok: false, error: { message: 'Retry', code: 'offline' } } as never);
    expect(await sendVoice(c)).toBe(false); expect(voiceDraft(c.live)?.error).toBe('Retry');
    expect(await sendVoice(c)).toBe(true); expect(voiceDraft(c.live)).toBeNull(); expect(loadTimeline).toHaveBeenCalledWith(c, 'c');
    expect(c.live.conversationsApi.replyVoice).toHaveBeenNthCalledWith(2, 't', 'c', 'YXVkaW8=', 'same-key');
  });
  it('refuses recording without an owned WhatsApp conversation and active window', async () => {
    const c = context(); browser();
    for (const change of [{ channel: 'messenger' }, { capabilities: { reply: false } }, { assigneeMembershipId: null }, { serviceWindow: { status: 'closed' } }]) {
      const before = c.live.openConversation; c.live.openConversation = ready({ ...(before as { value: object }).value, ...change } as never, 1);
      expect(await startVoice(c)).toBe(false); c.live.openConversation = before;
    }
    c.live.openConversation = { status: 'idle' }; expect(await startVoice(c)).toBe(false);
  });
  it.each(['recorder', 'devices'])('explains unavailable %s in both languages', async (missing) => {
    const c = context(); browser(); if (missing === 'recorder') { vi.stubGlobal('MediaRecorder', undefined); c.state.lang = 'ar'; }
    else vi.stubGlobal('navigator', {});
    expect(await startVoice(c)).toBe(false); expect(voiceDraft(c.live)?.status).toBe('error'); cancelVoice(c.live);
  });
  it.each(['en', 'ar'] as const)('handles permission denial and recording errors: %s', async (lang) => {
    const c = context(); c.state.lang = lang; const b = browser();
    b.getUserMedia.mockRejectedValueOnce(new Error('denied')); expect(await startVoice(c)).toBe(false); expect(voiceDraft(c.live)?.error).toBeTruthy(); cancelVoice(c.live);
    await startVoice(c); Recorder.last.onerror?.(); expect(voiceDraft(c.live)?.status).toBe('error'); cancelVoice(c.live);
    await startVoice(c); stopVoice(c); expect(voiceDraft(c.live)?.status).toBe('error'); cancelVoice(c.live);
    await startVoice(c); Recorder.last.data('x'.repeat(350001)); expect(voiceDraft(c.live)?.status).toBe('error'); cancelVoice(c.live);
  });
  it('cancels a pending permission prompt without keeping a late microphone stream', async () => {
    const c = context(); const b = browser(); let resolve!: (value: unknown) => void;
    b.getUserMedia.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const pending = startVoice(c); cancelVoice(c.live); resolve(b.stream); expect(await pending).toBe(false); expect(b.stop).toHaveBeenCalled();
    b.getUserMedia.mockRejectedValueOnce(new Error('denied')); const cancelled = startVoice(c); cancelVoice(c.live); expect(await cancelled).toBe(false);
  });
  it('stops at 90 seconds and uses browser default when no preferred format exists', async () => {
    const c = context(); browser(); Recorder.supported = false; vi.useFakeTimers();
    await startVoice(c); Recorder.last.data(); await vi.advanceTimersByTimeAsync(90000);
    expect(voiceDraft(c.live)?.seconds).toBe(90); expect(voiceDraft(c.live)?.status).toBe('ready'); cancelVoice(c.live);
  });
  it('does not restore a draft after navigating away or switching workspaces during send', async () => {
    const c = context(); browser(); await startVoice(c); const recorder = Recorder.last; cancelVoice(c.live); recorder.data(); recorder.onstop?.(); expect(voiceDraft(c.live)).toBeNull();
    await startVoice(c); Recorder.last.data(); stopVoice(c); let finish!: (value: unknown) => void;
    vi.mocked(c.live.conversationsApi.replyVoice).mockReturnValueOnce(new Promise((r) => { finish = r; }) as never);
    const sending = sendVoice(c); await Promise.resolve(); await Promise.resolve(); cancelVoice(c.live); finish({ ok: true }); expect(await sending).toBe(true); expect(voiceDraft(c.live)).toBeNull();
  });
  it('cancels when conversation, route, composer, supervisor lens or reply capability changes', async () => {
    for (const change of ['conversation', 'route', 'composer', 'supervisor', 'capability', 'window', 'loading', 'unchanged']) {
      const c = context(); browser(); await startVoice(c);
      if (change === 'conversation') c.live.openConversationId = 'other';
      if (change === 'route') c.state.route = { screen: 'contacts', conversationId: null, params: {} };
      if (change === 'composer') c.state.composerTab = 'note';
      if (change === 'supervisor') c.live.supervisorAgentId = 'm';
      if (change === 'capability') c.live.openConversation = ready({ capabilities: { reply: false } } as never, 1);
      if (change === 'window') c.live.openConversation = ready({ capabilities: {}, serviceWindow: { status: 'closed' } } as never, 1);
      if (change === 'loading') c.live.openConversation = { status: 'loading' };
      syncVoice(c); expect(voiceDraft(c.live) === null).toBe(!['loading', 'unchanged'].includes(change)); cancelVoice(c.live);
    }
  });
});
