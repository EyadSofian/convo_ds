import type { LiveContext } from './actions.js';
import type { LiveState } from './store.js';
import { currentTenantId } from './store.js';
import { loadTimeline } from './inbox-actions.js';
import { adoptRecording, forgetRecording } from './voice-playback.js';

/** The bars of the live level meter, and how often it moves. */
export const METER_BARS = 36;
const METER_INTERVAL_MS = 80;
/** How much of full scale counts as a loud voice, so speech fills the meter. */
const METER_LOUD = 0.25;

interface VoiceDraft {
  readonly conversationId: string;
  readonly clientMessageId: string;
  status: 'requesting' | 'recording' | 'ready' | 'sending' | 'error';
  seconds: number;
  error: string | null;
  url: string | null;
  blob?: Blob;
  recorder?: MediaRecorder;
  stream?: MediaStream;
  timer?: ReturnType<typeof setInterval>;
  /** Recent input levels, newest last, from 0 to 1. Always `METER_BARS` long. */
  levels: readonly number[];
  stopMeter?: () => void;
}

const sessions = new WeakMap<LiveState, VoiceDraft>();
export const voiceDraft = (live: LiveState): VoiceDraft | null => sessions.get(live) ?? null;

/** Moves the meter's bars between the redraws the seconds counter causes. */
function paintMeter(levels: readonly number[]): void {
  const bars = document.querySelector('.recorder__meter')?.children ?? [];
  Array.from(bars).forEach((bar, index) => {
    (bar as HTMLElement).style.setProperty('--level', (levels[index] as number).toFixed(2));
  });
}

/**
 * Hearing that the microphone hears: the whole point of a meter. A browser that
 * cannot provide one simply records without it.
 */
function startMeter(draft: VoiceDraft, stream: MediaStream): void {
  if (typeof AudioContext === 'undefined') return;
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  const timer = setInterval(() => {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
    const level = Math.min(1, Math.sqrt(sum / samples.length) / METER_LOUD);
    draft.levels = [...draft.levels.slice(1), level];
    paintMeter(draft.levels);
  }, METER_INTERVAL_MS);
  draft.stopMeter = () => {
    clearInterval(timer);
    void context.close();
  };
}

function release(draft: VoiceDraft): void {
  clearInterval(draft.timer);
  // Released twice when a recording is cancelled: here, and when it then stops.
  // Closing an audio context twice rejects, so the meter only stops once.
  draft.stopMeter?.();
  delete draft.stopMeter;
  if (draft.recorder?.state === 'recording') draft.recorder.stop();
  draft.stream?.getTracks().forEach((track) => track.stop());
}

export function cancelVoice(live: LiveState): void {
  const draft = sessions.get(live);
  if (draft === undefined) return;
  sessions.delete(live);
  release(draft);
  if (draft.url !== null) {
    forgetRecording(draft.url);
    URL.revokeObjectURL(draft.url);
  }
}

export function syncVoice(context: LiveContext): void {
  const draft = sessions.get(context.live);
  const current = context.live.openConversation.status === 'ready' ? context.live.openConversation.value : null;
  if (draft !== undefined && (draft.conversationId !== context.live.openConversationId || context.state.route.screen !== 'inbox' ||
    context.state.composerTab !== 'reply' || context.live.supervisorAgentId !== null ||
    current !== null && (current.capabilities?.reply === false || current.serviceWindow?.status !== 'open'))) cancelVoice(context.live);
}

export async function startVoice(context: LiveContext): Promise<boolean> {
  const { live } = context;
  if (sessions.has(live) || live.attachmentDraft !== null) return false;
  const conversation = live.openConversation.status === 'ready' ? live.openConversation.value : null;
  if (conversation === null || conversation.channel !== 'whatsapp' || conversation.capabilities?.reply === false ||
    conversation.assigneeMembershipId === null || conversation.serviceWindow?.status !== 'open') return false;
  const draft: VoiceDraft = { conversationId: conversation.id, clientMessageId: context.newKey(), status: 'requesting', seconds: 0, error: null, url: null, levels: new Array<number>(METER_BARS).fill(0) };
  sessions.set(live, draft);
  const fail = (message: string): void => {
    draft.status = 'error';
    draft.error = message;
    release(draft);
    context.refresh();
  };
  context.refresh();
  if (typeof MediaRecorder === 'undefined' || navigator.mediaDevices?.getUserMedia === undefined) {
    fail(context.state.lang === 'ar' ? 'التسجيل غير متاح في المتصفح ده. استخدم Chrome أو Safari على HTTPS.' : 'Recording is unavailable. Use Chrome or Safari over HTTPS.');
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (sessions.get(live) !== draft) { stream.getTracks().forEach((track) => track.stop()); return false; }
    draft.stream = stream;
    const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, { ...(mimeType === undefined ? {} : { mimeType }), audioBitsPerSecond: 24000 });
    draft.recorder = recorder;
    const chunks: Blob[] = [];
    let bytes = 0;
    recorder.ondataavailable = (event) => {
      chunks.push(event.data);
      bytes += event.data.size;
      if (bytes > 350000) fail(context.state.lang === 'ar' ? 'التسجيل كبير. سجّل رسالة أقصر.' : 'Recording is too large. Record a shorter message.');
    };
    recorder.onerror = () => fail(context.state.lang === 'ar' ? 'حصل خطأ في التسجيل. جرّب تاني.' : 'Recording failed. Try again.');
    recorder.onstop = () => {
      release(draft);
      if (sessions.get(live) !== draft || draft.status === 'error') return;
      const blob = new Blob(chunks, { type: recorder.mimeType });
      if (blob.size === 0) { fail(context.state.lang === 'ar' ? 'التسجيل فاضي. جرّب تاني.' : 'The recording is empty. Try again.'); return; }
      draft.blob = blob;
      draft.url = URL.createObjectURL(blob);
      draft.status = 'ready';
      void adoptRecording(draft.url, blob, draft.seconds);
      context.refresh();
    };
    recorder.start(1000);
    startMeter(draft, stream);
    draft.status = 'recording';
    draft.timer = setInterval(() => {
      draft.seconds += 1;
      if (draft.seconds >= 90) recorder.stop();
      context.refresh();
    }, 1000);
    context.refresh();
    return true;
  } catch {
    if (sessions.get(live) === draft) fail(context.state.lang === 'ar' ? 'اسمح للموقع باستخدام الميكروفون من إعدادات المتصفح، وجرّب تاني.' : 'Allow microphone access for this site in your browser, then try again.');
    return false;
  }
}

export function stopVoice(context: LiveContext): void {
  const draft = sessions.get(context.live);
  if (draft?.recorder?.state === 'recording') draft.recorder.stop();
}

export async function sendVoice(context: LiveContext): Promise<boolean> {
  const { live } = context;
  const draft = sessions.get(live);
  const tenantId = currentTenantId(live);
  if (draft?.status !== 'ready' || draft.blob === undefined || tenantId === null || live.openConversationId !== draft.conversationId) return false;
  draft.status = 'sending';
  draft.error = null;
  context.refresh();
  const bytes = new Uint8Array(await draft.blob.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const result = await live.conversationsApi.replyVoice(tenantId, draft.conversationId, btoa(binary), draft.clientMessageId);
  if (sessions.get(live) !== draft) return result.ok;
  if (!result.ok) {
    draft.status = 'ready';
    draft.error = result.error.message;
    context.refresh();
    return false;
  }
  cancelVoice(live);
  await loadTimeline(context, draft.conversationId);
  return true;
}
