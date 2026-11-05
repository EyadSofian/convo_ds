/**
 * Voice notes: one player for the whole product.
 *
 * The audio element lives outside the rendered tree on purpose. The tree is
 * rebuilt on every realtime event and a page of messages can shift under it, and
 * an element that rendering owns stops playing the moment it is replaced. Here,
 * rendering only ever reads what is playing, so nothing it does can stop it — and
 * starting one note stops the other, as anybody would expect.
 *
 * A note is fetched once and played from memory, because the API serves the whole
 * file without ranges: playing it directly leaves a player with no duration and no
 * way to seek. Having the bytes also gives the real waveform and the real length.
 */

/** How many bars a waveform has. The note's shape, not its length. */
export const VOICE_BARS = 40;
/** Notes kept in memory. Each is under half a megabyte. */
const KEPT_TRACKS = 24;
const RATES = [1, 1.5, 2] as const;
/** The lowest bar: silence is still part of the note and has to be visible. */
const QUIET_BAR = 0.08;

export type VoiceStatus = 'loading' | 'ready' | 'failed';

interface Track {
  readonly url: string;
  status: VoiceStatus;
  /** What the player loads. For a recording, the URL it already has. */
  source: string | null;
  /** Known length, from decoding or from the player. */
  duration: number | null;
  peaks: readonly number[] | null;
  position: number;
  ready: Promise<void>;
}

export interface VoiceView {
  readonly status: VoiceStatus;
  readonly playing: boolean;
  /** How far through, from 0 to 1. */
  readonly progress: number;
  readonly position: number;
  readonly duration: number | null;
  readonly peaks: readonly number[];
  readonly rate: number;
}

const tracks = new Map<string, Track>();
let player: HTMLAudioElement | null = null;
let current: string | null = null;
let rate: number = RATES[0];
let notify: () => void = () => undefined;

/** The app's redraw, for changes bigger than a moving playhead. */
export function bindVoicePlayback(refresh: () => void): void {
  notify = refresh;
}

function trackOf(url: string): Track | undefined {
  return tracks.get(url);
}

export function voiceView(url: string): VoiceView {
  const track = trackOf(url);
  const duration = track?.duration ?? null;
  const position = track?.position ?? 0;
  return {
    status: track?.status ?? 'loading',
    playing: current === url && player !== null && !player.paused,
    progress: duration === null || duration === 0 ? 0 : Math.min(position / duration, 1),
    position,
    duration,
    peaks: track?.peaks ?? new Array<number>(VOICE_BARS).fill(QUIET_BAR),
    rate,
  };
}

/** Bar heights from raw samples, loudest bar at full height. */
export function peaksOf(samples: ArrayLike<number>, bars = VOICE_BARS): readonly number[] {
  const size = Math.max(1, Math.floor(samples.length / bars));
  const raw: number[] = [];
  for (let bar = 0; bar < bars; bar += 1) {
    let peak = 0;
    for (let index = bar * size; index < Math.min((bar + 1) * size, samples.length); index += 1) {
      peak = Math.max(peak, Math.abs(samples[index] as number));
    }
    raw.push(peak);
  }
  const loudest = Math.max(...raw);
  return raw.map((peak) => (loudest === 0 ? QUIET_BAR : Math.max(QUIET_BAR, peak / loudest)));
}

/** The waveform and length, where this browser can decode the format. */
async function decode(track: Track, blob: Blob): Promise<void> {
  if (typeof OfflineAudioContext === 'undefined') return;
  try {
    // An offline context, because a live one asks for a user gesture.
    const buffer = await new OfflineAudioContext(1, 1, 48_000).decodeAudioData(await blob.arrayBuffer());
    track.peaks = peaksOf(buffer.getChannelData(0));
    track.duration = buffer.duration;
  } catch {
    // Not decodable here is not unplayable: the player may still manage, and it
    // then reports the length itself. Only the bars stay flat.
  }
}

function evict(): void {
  if (tracks.size <= KEPT_TRACKS) return;
  // More than one is kept, so there is always a note that is not the one playing.
  const oldest = [...tracks.values()].find((track) => track.url !== current) as Track;
  if (oldest.source !== null && oldest.source !== oldest.url) URL.revokeObjectURL(oldest.source);
  tracks.delete(oldest.url);
}

async function fetchTrack(track: Track): Promise<void> {
  try {
    const response = await fetch(track.url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`voice note answered ${String(response.status)}`);
    const blob = await response.blob();
    track.source = URL.createObjectURL(blob);
    await decode(track, blob);
    track.status = 'ready';
  } catch {
    track.status = 'failed';
  }
  notify();
}

function load(url: string): Track {
  const track: Track = { url, status: 'loading', source: null, duration: null, peaks: null, position: 0, ready: Promise.resolve() };
  tracks.set(url, track);
  evict();
  track.ready = fetchTrack(track);
  return track;
}

/**
 * Called after every render: loads the notes now on screen, and stops the one
 * that is not any more — nobody can pause what they cannot see.
 */
export function hydrateVoiceNotes(root: ParentNode): void {
  const onScreen = new Set<string>();
  for (const note of Array.from(root.querySelectorAll('[data-voice]'))) {
    const url = note.getAttribute('data-voice') as string;
    onScreen.add(url);
    if (trackOf(url) === undefined) load(url);
  }
  if (current !== null && !onScreen.has(current)) stopVoicePlayback();
}

/** A recording the browser already holds. Its URL is the one it plays from. */
export function adoptRecording(url: string, blob: Blob, seconds: number): Promise<void> {
  const track: Track = { url, status: 'ready', source: url, duration: seconds, peaks: null, position: 0, ready: Promise.resolve() };
  tracks.set(url, track);
  track.ready = decode(track, blob).then(() => {
    // A recording's container often claims no length; the timer was there.
    if (track.duration === 0 || !Number.isFinite(track.duration)) track.duration = seconds;
    notify();
  });
  return track.ready;
}

export function forgetRecording(url: string): void {
  if (current === url) stopVoicePlayback();
  tracks.delete(url);
}

/** Moves the playhead on screen without redrawing the app four times a second. */
function paintPlayhead(url: string): void {
  const view = voiceView(url);
  for (const note of Array.from(document.querySelectorAll<HTMLElement>('[data-voice]'))) {
    if (note.getAttribute('data-voice') !== url) continue;
    note.style.setProperty('--progress', String(view.progress));
    const time = note.querySelector('.voice__time');
    if (time !== null) time.textContent = voiceClock(view);
    const seek = note.querySelector<HTMLInputElement>('.voice__seek');
    if (seek !== null) seek.value = String(Math.round(view.progress * 1000));
  }
}

function playerElement(): HTMLAudioElement {
  if (player !== null) return player;
  const audio = new Audio();
  const playing = (): Track | undefined => (current === null ? undefined : trackOf(current));
  audio.addEventListener('timeupdate', () => {
    const track = playing();
    if (track === undefined) return;
    track.position = audio.currentTime;
    paintPlayhead(track.url);
  });
  audio.addEventListener('loadedmetadata', () => {
    const track = playing();
    if (track !== undefined && track.duration === null && Number.isFinite(audio.duration)) {
      track.duration = audio.duration;
      notify();
    }
  });
  audio.addEventListener('ended', () => {
    const track = playing();
    if (track !== undefined) track.position = 0;
    notify();
  });
  audio.addEventListener('error', () => {
    const track = playing();
    if (track !== undefined) track.status = 'failed';
    notify();
  });
  audio.addEventListener('play', () => { notify(); });
  audio.addEventListener('pause', () => { notify(); });
  player = audio;
  return audio;
}

export function stopVoicePlayback(): void {
  player?.pause();
  current = null;
}

/** Plays or pauses a note. A note that failed to load is tried again. */
export async function toggleVoice(url: string): Promise<boolean> {
  const known = trackOf(url);
  if (known === undefined || known.status === 'failed') {
    const track = load(url);
    notify();
    await track.ready;
    return false;
  }
  const audio = playerElement();
  if (current === url && !audio.paused) {
    audio.pause();
    return true;
  }
  await known.ready;
  if (known.status !== 'ready') return false;
  if (current !== url) {
    audio.pause();
    audio.src = known.source as string;
    current = url;
    audio.currentTime = known.position;
  }
  audio.playbackRate = rate;
  try {
    await audio.play();
    return true;
  } catch {
    known.status = 'failed';
    notify();
    return false;
  }
}

/** `arg` is `url:value`, the value out of 1000 from the seek control. */
export function seekVoice(arg: string): void {
  const split = arg.lastIndexOf(':');
  const url = arg.slice(0, split);
  const track = trackOf(url);
  if (track === undefined || track.duration === null) return;
  track.position = (Number(arg.slice(split + 1)) / 1000) * track.duration;
  if (current === url && player !== null) player.currentTime = track.position;
  paintPlayhead(url);
}

export function cycleVoiceRate(): void {
  rate = RATES[(RATES.indexOf(rate as (typeof RATES)[number]) + 1) % RATES.length] as number;
  if (player !== null) player.playbackRate = rate;
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}`;
}

/** Time left while it plays, full length at rest: what a person wants to know. */
export function voiceClock(view: Pick<VoiceView, 'position' | 'duration' | 'playing'>): string {
  if (view.duration === null) return clock(view.position);
  return clock(view.playing || view.position > 0 ? view.duration - view.position : view.duration);
}

/** Back to nothing. The state is deliberately global, and tests need a clean one. */
export function resetVoicePlayback(): void {
  stopVoicePlayback();
  player = null;
  tracks.clear();
  rate = RATES[0];
  notify = () => undefined;
}
