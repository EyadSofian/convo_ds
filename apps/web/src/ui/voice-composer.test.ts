/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createState } from '../state.js';
import { ready } from '../live/store.js';
import type { LiveContext } from '../live/actions.js';
import { LIVE_ACTIONS } from '../live/dispatch.js';
import { cancelVoice, startVoice, voiceDraft } from '../live/voice-message.js';
import { renderInbox } from './live-inbox.js';

function setup(lang: 'en' | 'ar') {
  const state = createState(new Date()); state.lang = lang; state.route = { screen: 'inbox', conversationId: 'c', params: {} }; state.composerTab = 'reply';
  const live = state.live; live.session = { status: 'signed_in', email: 'a@b.c', memberships: [], tenantId: 't' };
  const conversation = { id: 'c', connectionId: 'cn', peerIdentity: '201012345678', channel: 'whatsapp', contactId: null, contactDisplayName: 'Parent', inboxLabel: 'Sales', assigneeMembershipId: 'm', priority: 'normal', status: 'open', version: 1, participantMembershipIds: [], ownerState: 'human_active', ownerVersion: 1, capabilities: { reply: true, note: true }, serviceWindow: { status: 'open' } };
  live.openConversationId = 'c'; live.openConversation = ready(conversation as never, 1); live.conversations = ready([conversation] as never, 1); live.timeline = ready([], 1);
  return { state, live, refresh: vi.fn(), newKey: () => 'same-key', now: () => 1 } as unknown as LiveContext;
}
class Recorder {
  static last: Recorder;
  static isTypeSupported() { return true; }
  state = 'inactive'; mimeType = 'audio/webm'; onstop?: () => void; ondataavailable?: (event: { data: Blob }) => void;
  constructor() { Recorder.last = this; }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['sample']) }); this.onstop?.(); }
}
afterEach(() => { vi.unstubAllGlobals(); });
describe('voice and emoji composer', () => {
  it.each(['en', 'ar'] as const)('renders microphone permissions, recording, preview, errors and sending: %s', async lang => {
    const c = setup(lang);
    const stream = { getTracks: () => [{ stop: vi.fn() }] }; let grant!: (value: unknown) => void;
    vi.stubGlobal('MediaRecorder', Recorder); vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise(r => { grant = r; }) } });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:preview', revokeObjectURL: vi.fn() });
    const pending = startVoice(c);
    expect(renderInbox(c.state).querySelector('[data-act="live-voice-cancel"]')).not.toBeNull();
    grant(stream); await pending;
    expect(renderInbox(c.state).querySelector('[data-act="live-voice-stop"]')).not.toBeNull();
    await LIVE_ACTIONS['live-voice-stop']?.(c, '');
    expect(renderInbox(c.state).querySelector('audio')?.getAttribute('src')).toBe('blob:preview');
    voiceDraft(c.live)!.error = 'Failed'; expect(renderInbox(c.state).textContent).toContain('Failed');
    voiceDraft(c.live)!.status = 'sending'; expect(renderInbox(c.state).querySelector('[data-act="live-voice-cancel"]')?.hasAttribute('disabled')).toBe(true);
    await LIVE_ACTIONS['live-voice-cancel']?.(c, '');
    expect(renderInbox(c.state).querySelector('[data-act="live-voice-start"]')).not.toBeNull();
    // Dispatch adapters are exercised without opening a microphone on a closed thread.
    c.live.openConversation = { status: 'idle' }; expect(await LIVE_ACTIONS['live-voice-start']?.(c, '')).toBe(false);
    expect(await LIVE_ACTIONS['live-voice-send']?.(c, '')).toBe(false);
    cancelVoice(c.live);
  });
  it('leaves the file picker out of channels that cannot deliver attachments', () => {
    const c = setup('en');
    const open = c.live.openConversation as { status: 'ready'; value: object };
    c.live.openConversation = ready({ ...open.value, channel: 'web_chat' } as never, 1);
    expect(renderInbox(c.state).querySelector('[data-act="live-attachment-file"]')).toBeNull();
  });

  it.each(['en', 'ar'] as const)('inserts emoji into replies and notes and keeps playback authenticated: %s', async lang => {
    const c = setup(lang); c.state.openMenu = 'composer-emoji';
    const panel = renderInbox(c.state); expect(panel.querySelectorAll('.composer__emoji-item')).toHaveLength(24);
    await LIVE_ACTIONS['live-emoji']?.(c, '😊'); expect(c.live.composer).toBe('😊'); expect(c.state.openMenu).toBeNull();
    c.state.composerTab = 'note'; c.state.openMenu = 'composer-emoji'; expect(renderInbox(c.state).querySelectorAll('.composer__emoji-item')).toHaveLength(24);
    await LIVE_ACTIONS['live-emoji']?.(c, '👍'); expect(c.live.noteDraft).toBe('👍');
    c.state.composerTab = 'reply'; c.live.timeline = ready([{ id: '11111111-2222-4333-8444-555555555555', direction: 'out', content_type: 'audio', text: null, at: new Date().toISOString(), attachments: [{ type: 'audio', storedMedia: true, filename: 'voice.ogg', isVoice: true }], command_state: 'queued' }] as never, 1);
    expect(renderInbox(c.state).querySelector('.msg__audio')?.getAttribute('src')).toContain('/tenants/t/conversations/c/voice-messages/');
    c.live.session = { status: 'signed_out', error: null }; expect(renderInbox(c.state).querySelector('.msg__audio')).toBeNull();
  });
});
