/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createState } from '../state.js';
import { ready } from '../live/store.js';
import type { LiveContext } from '../live/actions.js';
import { LIVE_ACTIONS } from '../live/dispatch.js';
import { cancelVoice, METER_BARS, startVoice, voiceDraft } from '../live/voice-message.js';
import { hydrateVoiceNotes, resetVoicePlayback } from '../live/voice-playback.js';
import { renderInbox } from './live-inbox.js';
import { EMOJI_CATEGORIES } from './emoji-data.js';

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
afterEach(() => { resetVoicePlayback(); vi.unstubAllGlobals(); });
describe('voice and emoji composer', () => {
  it.each(['en', 'ar'] as const)('renders microphone permissions, recording, preview, errors and sending: %s', async lang => {
    const c = setup(lang);
    const stream = { getTracks: () => [{ stop: vi.fn() }] }; let grant!: (value: unknown) => void;
    vi.stubGlobal('MediaRecorder', Recorder); vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise(r => { grant = r; }) } });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:preview', revokeObjectURL: vi.fn() });
    const pending = startVoice(c);
    expect(renderInbox(c.state).querySelector('[data-act="live-voice-cancel"]')).not.toBeNull();
    grant(stream); await pending;
    const recording = renderInbox(c.state);
    expect(recording.querySelector('[data-act="live-voice-stop"]')).not.toBeNull();
    expect(recording.querySelector('.recorder__time')?.textContent).toBe('0:00 / 1:30');
    expect(recording.querySelectorAll('.recorder__meter i')).toHaveLength(METER_BARS);
    await LIVE_ACTIONS['live-voice-stop']?.(c, '');
    const preview = renderInbox(c.state);
    expect(preview.querySelector('.recorder [data-voice]')?.getAttribute('data-voice')).toBe('blob:preview');
    // Nothing rendered owns the audio: a redraw must not be able to stop it.
    expect(preview.querySelector('audio')).toBeNull();
    voiceDraft(c.live)!.error = 'Failed'; expect(renderInbox(c.state).querySelector('.recorder__send-error')?.textContent).toBe('Failed');
    voiceDraft(c.live)!.status = 'sending'; expect(renderInbox(c.state).querySelector('[data-act="live-voice-cancel"]')?.hasAttribute('disabled')).toBe(true);
    await LIVE_ACTIONS['live-voice-cancel']?.(c, '');
    expect(renderInbox(c.state).querySelector('[data-act="live-voice-start"]')).not.toBeNull();
    // Dispatch adapters are exercised without opening a microphone on a closed thread.
    c.live.openConversation = { status: 'idle' }; expect(await LIVE_ACTIONS['live-voice-start']?.(c, '')).toBe(false);
    expect(await LIVE_ACTIONS['live-voice-send']?.(c, '')).toBe(false);
    cancelVoice(c.live);
  });
  it.each(['en', 'ar'] as const)('tells a refused microphone from a bad recording, and offers to try again: %s', async lang => {
    const c = setup(lang);
    vi.stubGlobal('MediaRecorder', Recorder);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.reject(new Error('denied')) } });
    await startVoice(c);
    const refused = renderInbox(c.state);
    expect(refused.querySelector('.recorder__error')?.textContent).toContain(lang === 'en' ? 'Allow microphone access' : 'اسمح للموقع');
    expect(refused.textContent).not.toContain(lang === 'en' ? 'Review recording' : 'راجع التسجيل');
    expect(refused.querySelector('[data-act="live-voice-stop"]')).toBeNull();
    expect(refused.querySelector('[data-act="live-voice-send"]')).toBeNull();
    const grant = vi.fn(() => Promise.resolve({ getTracks: () => [{ stop: vi.fn() }] }));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: grant } });
    expect(refused.querySelector('[data-act="live-voice-retry"]')).not.toBeNull();
    await LIVE_ACTIONS['live-voice-retry']?.(c, '');
    expect(grant).toHaveBeenCalledOnce();
    expect(voiceDraft(c.live)?.status).toBe('recording');
    cancelVoice(c.live);
  });

  it('moves the level meter with the microphone, and leaves it out where there is none', async () => {
    vi.useFakeTimers();
    try {
      const c = setup('en');
      const closed = vi.fn(() => Promise.resolve());
      class Context {
        createAnalyser() { return { fftSize: 0, getByteTimeDomainData: (samples: Uint8Array) => { samples.fill(255); } }; }
        createMediaStreamSource() { return { connect: vi.fn() }; }
        close = closed;
      }
      vi.stubGlobal('AudioContext', Context);
      vi.stubGlobal('MediaRecorder', Recorder);
      vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop: vi.fn() }] }) } });
      await startVoice(c);
      // The meter keeps listening while nothing has drawn it yet.
      vi.advanceTimersByTime(80);
      expect(voiceDraft(c.live)?.levels.at(-1)).toBe(1);
      document.body.append(renderInbox(c.state));
      vi.advanceTimersByTime(80);
      const bars = document.querySelectorAll<HTMLElement>('.recorder__meter i');
      expect(bars[METER_BARS - 1]?.style.getPropertyValue('--level')).toBe('1.00');
      cancelVoice(c.live);
      expect(closed).toHaveBeenCalledOnce();
      document.body.replaceChildren();
      vi.advanceTimersByTime(80);

      const quiet = setup('en');
      vi.stubGlobal('AudioContext', undefined);
      await startVoice(quiet);
      vi.advanceTimersByTime(80);
      expect(voiceDraft(quiet.live)?.levels.every((level) => level === 0)).toBe(true);
      cancelVoice(quiet.live);
    } finally {
      vi.useRealTimers();
    }
  });

  it('plays, shows and offers what a customer sent, through this server', () => {
    const c = setup('en');
    const id = '11111111-2222-4333-8444-555555555555';
    const withAttachments = (attachments: unknown, direction = 'in') => { c.live.timeline = ready([{ id, direction, content_type: 'media', text: null, at: new Date().toISOString(), attachments, command_state: null }] as never, 1); return renderInbox(c.state); };
    const base = `/api/v1/tenants/t/conversations/c/inbound-media/${id}`;

    const heard = withAttachments([{ type: 'audio', providerId: '987', mimeType: 'audio/ogg' }]);
    expect(heard.querySelector('.msg__bubble--voice [data-voice]')?.getAttribute('data-voice')).toBe(`${base}/0`);
    expect(heard.textContent).not.toContain('Customer attachment');
    expect(withAttachments([{ type: 'voice', providerId: 'https://cdn.fbsbx.com/a' }]).querySelector('[data-voice]')).not.toBeNull();

    const seen = withAttachments([{ type: 'video', providerId: 'https://cdn.fbsbx.com/v' }]);
    expect(seen.querySelector('video')?.getAttribute('src')).toBe(`${base}/0`);

    // A WhatsApp image is an id, and only this server can turn it into a picture.
    expect(withAttachments([{ type: 'image', providerId: '555' }]).querySelector('img')?.getAttribute('src')).toBe(`${base}/0`);
    expect(withAttachments([{ type: 'sticker', providerId: '555' }]).querySelector('img')?.getAttribute('src')).toBe(`${base}/0`);
    // A Meta image link still loads directly, and one that is neither is not loaded at all.
    expect(withAttachments([{ type: 'image', providerId: 'https://scontent.xx.fbcdn.net/a.png' }]).querySelector('img')?.getAttribute('src')).toBe('https://scontent.xx.fbcdn.net/a.png');
    const refused = withAttachments([{ type: 'image', providerId: 'https://attacker.example/a.png' }]);
    expect(refused.querySelector('img')).toBeNull();
    expect(refused.textContent).toContain('Customer attachment');

    const file = withAttachments([{ type: 'document', providerId: '1', caption: 'Fees.pdf' }, { type: 'file', providerId: 'https://cdn.fbsbx.com/f' }, { type: 'file', providerId: 'https://cdn.fbsbx.com/g', caption: '' }, null, { type: 'file' }, { type: 'file', providerId: '' }]);
    const links = Array.from(file.querySelectorAll<HTMLAnchorElement>('a.msg__attachment-link'));
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([['Fees.pdf', `${base}/0`], ['Attachment', `${base}/1`], ['Attachment', `${base}/2`]]);

    // Sent from Business Suite, it is the same kind of thing on our side of the thread.
    expect(withAttachments([{ type: 'audio', providerId: '987' }], 'out').querySelector('.voice--out')).not.toBeNull();
    expect(withAttachments('not a list').textContent).not.toContain('Customer attachment');
    expect(withAttachments([]).querySelector('[data-voice]')).toBeNull();

    c.live.openConversationId = null;
    expect(renderInbox(c.state).querySelector('[data-voice]')).toBeNull();
  });

  it('shows a voice note that failed with a way to retry and download it, in both languages', async () => {
    for (const lang of ['en', 'ar'] as const) {
      const c = setup(lang);
      const id = '11111111-2222-4333-8444-555555555555';
      vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 404 })));
      c.live.timeline = ready([{ id, direction: 'out', content_type: 'audio', text: null, at: new Date().toISOString(), attachments: [{ type: 'audio', storedMedia: true, filename: 'voice.ogg', isVoice: true }], command_state: 'queued' }] as never, 1);
      hydrateVoiceNotes(renderInbox(c.state));
      await vi.waitFor(() => { expect(renderInbox(c.state).querySelector('.voice')?.getAttribute('data-status')).toBe('failed'); });
      const failed = renderInbox(c.state);
      expect(failed.querySelector('.voice__download')?.getAttribute('download')).toBe('voice.ogg');
      expect(failed.querySelector('.voice__seek')).toBeNull();
      resetVoicePlayback();
    }
  });

  it('offers a retry and no download when a recording under review fails', async () => {
    const c = setup('en');
    vi.stubGlobal('MediaRecorder', Recorder);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop: vi.fn() }] }) } });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:take', revokeObjectURL: vi.fn() });
    class Audio extends EventTarget { paused = true; src = ''; currentTime = 0; playbackRate = 1; duration = 0; play() { return Promise.reject(new Error('NotSupportedError')); } pause() { this.paused = true; } }
    vi.stubGlobal('Audio', Audio);
    await startVoice(c);
    await LIVE_ACTIONS['live-voice-stop']?.(c, '');
    await LIVE_ACTIONS['live-voice-play']?.(c, 'blob:take');
    const failed = renderInbox(c.state);
    expect(failed.querySelector('.voice')?.getAttribute('data-status')).toBe('failed');
    expect(failed.querySelector('.voice__toggle')?.getAttribute('aria-label')).toBe('Try again');
    expect(failed.querySelector('.voice__download')).toBeNull();
    cancelVoice(c.live);
  });

  it('labels a playing note as pausable and offers its speed', async () => {
    class Audio extends EventTarget { paused = true; src = ''; currentTime = 0; playbackRate = 1; duration = 0; play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); } pause() { this.paused = true; } }
    vi.stubGlobal('Audio', Audio);
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('bytes')));
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:note', revokeObjectURL: vi.fn() });
    for (const lang of ['en', 'ar'] as const) {
      const c = setup(lang);
      const id = '11111111-2222-4333-8444-555555555555';
      c.live.timeline = ready([{ id, direction: 'out', content_type: 'audio', text: null, at: new Date().toISOString(), attachments: [{ type: 'audio', storedMedia: true, filename: 'voice.ogg', isVoice: true }], command_state: 'queued' }] as never, 1);
      const first = renderInbox(c.state);
      const url = first.querySelector('[data-voice]')?.getAttribute('data-voice') as string;
      hydrateVoiceNotes(first);
      expect(first.querySelector('.voice__toggle')?.getAttribute('aria-label')).toBe(lang === 'en' ? 'Play' : 'تشغيل');
      await LIVE_ACTIONS['live-voice-play']?.(c, url);
      expect(renderInbox(c.state).querySelector('.voice')?.getAttribute('data-playing')).toBe('true');
      expect(renderInbox(c.state).querySelector('.voice__toggle')?.getAttribute('aria-label')).toBe(lang === 'en' ? 'Pause' : 'إيقاف مؤقت');
      await LIVE_ACTIONS['live-voice-rate']?.(c, '');
      expect(renderInbox(c.state).querySelector('.voice__rate')?.textContent).toBe('1.5×');
      expect(c.refresh).toHaveBeenCalled();
      await LIVE_ACTIONS['live-voice-seek']?.(c, `${url}:0`);
      resetVoicePlayback();
    }
  });

  it('says it is searching, in the search box, while the rows stay', () => {
    const c = setup('en');
    c.live.inboxQuery = { ...c.live.inboxQuery, search: 'sara' };
    c.live.inboxPending = true;
    const busy = renderInbox(c.state);
    expect(busy.querySelector('.inbox-search__spinner')?.getAttribute('aria-label')).toBe('Searching');
    expect(busy.querySelector('.zone--list > .zone__body')?.getAttribute('aria-busy')).toBe('true');
    c.live.inboxPending = false;
    expect(renderInbox(c.state).querySelector('.inbox-search__spinner')).toBeNull();
  });

  it('leaves the file picker out of channels that cannot deliver attachments', () => {
    const c = setup('en');
    const open = c.live.openConversation as { status: 'ready'; value: object };
    c.live.openConversation = ready({ ...open.value, channel: 'web_chat' } as never, 1);
    expect(renderInbox(c.state).querySelector('[data-act="live-attachment-file"]')).toBeNull();
  });

  it.each(['en', 'ar'] as const)('inserts emoji into replies and notes and keeps playback authenticated: %s', async lang => {
    const c = setup(lang); c.state.openMenu = 'composer-emoji';
    const smileys = EMOJI_CATEGORIES[0]!.emojis.length;
    // Nothing used yet: the picker opens on the first real category, not an empty Recent.
    const panel = renderInbox(c.state); expect(panel.querySelectorAll('.emoji-picker__item')).toHaveLength(smileys);
    expect(panel.querySelector('.emoji-picker__tab[data-arg="recent"]')).toBeNull();
    await LIVE_ACTIONS['live-emoji']?.(c, '😊'); expect(c.live.composer).toBe('😊');
    // The picker stays open for the next pick, and remembers this one.
    expect(c.state.openMenu).toBe('composer-emoji'); expect(c.state.emojiRecent).toEqual(['😊']);
    c.state.composerTab = 'note'; expect(renderInbox(c.state).querySelectorAll('.emoji-picker__item')).toHaveLength(1);
    await LIVE_ACTIONS['live-emoji']?.(c, '👍'); expect(c.live.noteDraft).toBe('👍'); expect(c.state.emojiRecent).toEqual(['👍', '😊']);
    c.state.composerTab = 'reply'; c.live.timeline = ready([{ id: '11111111-2222-4333-8444-555555555555', direction: 'out', content_type: 'audio', text: null, at: new Date().toISOString(), attachments: [{ type: 'audio', storedMedia: true, filename: 'voice.ogg', isVoice: true }], command_state: 'queued' }] as never, 1);
    expect(renderInbox(c.state).querySelector('.msg__bubble--voice [data-voice]')?.getAttribute('data-voice')).toContain('/tenants/t/conversations/c/voice-messages/');
    c.live.session = { status: 'signed_out', error: null }; expect(renderInbox(c.state).querySelector('[data-voice]')).toBeNull();
  });
});
