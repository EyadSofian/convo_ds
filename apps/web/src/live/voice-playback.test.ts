/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adoptRecording,
  bindVoicePlayback,
  cycleVoiceRate,
  forgetRecording,
  hydrateVoiceNotes,
  peaksOf,
  resetVoicePlayback,
  seekVoice,
  stopVoicePlayback,
  toggleVoice,
  voiceClock,
  VOICE_BARS,
  voiceView,
} from './voice-playback.js';

const URL_A = '/api/v1/tenants/t/conversations/c/voice-messages/a/audio';
const URL_B = '/api/v1/tenants/t/conversations/c/voice-messages/b/audio';

/** A browser's audio element, without the sound. */
class FakeAudio extends EventTarget {
  static all: FakeAudio[] = [];
  static refuse = false;
  src = '';
  paused = true;
  currentTime = 0;
  playbackRate = 1;
  duration = Number.NaN;
  constructor() { super(); FakeAudio.all.push(this); }
  play(): Promise<void> {
    if (FakeAudio.refuse) return Promise.reject(new Error('NotAllowedError'));
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
}

const note = (url: string): HTMLElement => {
  const element = document.createElement('div');
  element.setAttribute('data-voice', url);
  element.innerHTML = '<span class="voice__time"></span><input class="voice__seek" type="range" min="0" max="1000">';
  document.body.append(element);
  return element;
};

const flush = async (): Promise<void> => { for (let tick = 0; tick < 12; tick += 1) await Promise.resolve(); await new Promise((resolve) => { setTimeout(resolve, 0); }); };

let fetched: string[];
let answer: () => Promise<Response>;

function audio(): FakeAudio {
  return FakeAudio.all.at(-1) as FakeAudio;
}

beforeEach(() => {
  FakeAudio.all = [];
  FakeAudio.refuse = false;
  fetched = [];
  answer = () => Promise.resolve(new Response('bytes', { status: 200 }));
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    expect(init.credentials).toBe('same-origin');
    fetched.push(url);
    return answer();
  });
  let next = 0;
  vi.stubGlobal('URL', { createObjectURL: () => `blob:${String(next += 1)}`, revokeObjectURL: vi.fn() });
  vi.stubGlobal('OfflineAudioContext', class {
    decodeAudioData() {
      return Promise.resolve({ duration: 42, getChannelData: () => new Float32Array(400).map((_, index) => (index === 0 ? 0.5 : 0.25)) });
    }
  });
});

afterEach(() => {
  resetVoicePlayback();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('reading a note', () => {
  it('answers for a note it has not heard of yet: loading, flat, unplayed', () => {
    expect(voiceView(URL_A)).toMatchObject({ status: 'loading', playing: false, progress: 0, duration: null, rate: 1 });
    expect(voiceView(URL_A).peaks).toHaveLength(VOICE_BARS);
  });

  it('loads what is on screen once, and learns its real shape and length', async () => {
    const refreshed = vi.fn();
    bindVoicePlayback(refreshed);
    note(URL_A);
    hydrateVoiceNotes(document);
    hydrateVoiceNotes(document);
    await flush();
    expect(fetched).toEqual([URL_A]);
    const view = voiceView(URL_A);
    expect(view).toMatchObject({ status: 'ready', duration: 42 });
    expect(view.peaks[0]).toBe(1);
    expect(view.peaks[1]).toBe(0.5);
    expect(refreshed).toHaveBeenCalled();
  });

  it('still plays where the browser cannot decode the format, with flat bars', async () => {
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData() { return Promise.reject(new Error('EncodingError')); } });
    const refreshed = vi.fn();
    bindVoicePlayback(refreshed);
    note(URL_A);
    hydrateVoiceNotes(document);
    await flush();
    expect(voiceView(URL_A)).toMatchObject({ status: 'ready', duration: null });
    await toggleVoice(URL_A);
    // The player then reports the length itself, once and only if it is real.
    audio().dispatchEvent(new Event('loadedmetadata'));
    expect(voiceView(URL_A).duration).toBeNull();
    audio().duration = 12;
    refreshed.mockClear();
    audio().dispatchEvent(new Event('loadedmetadata'));
    expect(voiceView(URL_A).duration).toBe(12);
    expect(refreshed).toHaveBeenCalledOnce();
    audio().duration = 99;
    audio().dispatchEvent(new Event('loadedmetadata'));
    expect(voiceView(URL_A).duration).toBe(12);
  });

  it('copes with a browser that has no decoding at all', async () => {
    vi.stubGlobal('OfflineAudioContext', undefined);
    note(URL_A);
    hydrateVoiceNotes(document);
    await flush();
    expect(voiceView(URL_A)).toMatchObject({ status: 'ready', duration: null });
  });

  it('reports a note the server would not give, and tries again when asked', async () => {
    answer = () => Promise.resolve(new Response('', { status: 404 }));
    note(URL_A);
    hydrateVoiceNotes(document);
    await flush();
    expect(voiceView(URL_A).status).toBe('failed');
    answer = () => Promise.reject(new Error('offline'));
    expect(await toggleVoice(URL_A)).toBe(false);
    expect(voiceView(URL_A).status).toBe('failed');
    answer = () => Promise.resolve(new Response('bytes'));
    expect(await toggleVoice(URL_A)).toBe(false);
    expect(voiceView(URL_A).status).toBe('ready');
    expect(fetched).toHaveLength(3);
    expect(FakeAudio.all).toHaveLength(0);
  });

  it('loads a note pressed before anything rendered it', async () => {
    expect(await toggleVoice(URL_A)).toBe(false);
    expect(voiceView(URL_A).status).toBe('ready');
  });

  it('keeps a bounded number of notes, never dropping the one playing', async () => {
    const revoke = vi.mocked(URL.revokeObjectURL);
    note(URL_A);
    hydrateVoiceNotes(document);
    await flush();
    await toggleVoice(URL_A);
    for (let index = 0; index < 25; index += 1) {
      note(`/voice/${String(index)}`);
      hydrateVoiceNotes(document);
      await flush();
    }
    expect(voiceView(URL_A).status).toBe('ready');
    expect(voiceView(URL_A).playing).toBe(true);
    // The oldest other note went, and its memory with it.
    expect(revoke).toHaveBeenCalled();
    expect(voiceView('/voice/0').status).toBe('loading');
    expect(voiceView('/voice/24').status).toBe('ready');
    expect(revoke).not.toHaveBeenCalledWith('blob:1');
  });
});

describe('dropping the oldest note', () => {
  it('skips the one playing even when it is the oldest, and frees the next one', async () => {
    const revoke = vi.mocked(URL.revokeObjectURL);
    note(URL_A);
    hydrateVoiceNotes(document);
    await flush();
    await toggleVoice(URL_A);
    note(URL_B);
    hydrateVoiceNotes(document);
    await flush();
    for (let index = 0; index < 23; index += 1) {
      note(`/older/${String(index)}`);
      hydrateVoiceNotes(document);
      await flush();
    }
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(voiceView(URL_B).status).toBe('loading');
    expect(voiceView(URL_A).playing).toBe(true);
  });
});

describe('peaks', () => {
  it('scales to the loudest moment and keeps silence visible', () => {
    expect(peaksOf([0, 0, 1, -0.5], 2)).toEqual([0.08, 1]);
  });

  it('draws silence as a flat line rather than dividing by nothing', () => {
    expect(peaksOf([0, 0, 0, 0], 2)).toEqual([0.08, 0.08]);
  });

  it('handles a note shorter than its bars', () => {
    expect(peaksOf([1], 2)).toEqual([1, 0.08]);
  });
});

describe('playing', () => {
  const ready = async (url: string): Promise<HTMLElement> => {
    const element = note(url);
    hydrateVoiceNotes(document);
    await flush();
    return element;
  };

  it('plays and pauses, from one element that nothing rendered', async () => {
    await ready(URL_A);
    expect(await toggleVoice(URL_A)).toBe(true);
    expect(audio().src).toBe('blob:1');
    expect(voiceView(URL_A).playing).toBe(true);
    expect(await toggleVoice(URL_A)).toBe(true);
    expect(voiceView(URL_A).playing).toBe(false);
    expect(await toggleVoice(URL_A)).toBe(true);
    expect(FakeAudio.all).toHaveLength(1);
    expect(document.querySelector('audio')).toBeNull();
  });

  it('waits for a note still loading, then plays it', async () => {
    let release!: (value: Response) => void;
    answer = () => new Promise((resolve) => { release = resolve; });
    note(URL_A);
    hydrateVoiceNotes(document);
    const pressed = toggleVoice(URL_A);
    release(new Response('bytes'));
    expect(await pressed).toBe(true);
    expect(voiceView(URL_A).playing).toBe(true);
  });

  it('does not play a note that failed while it was waiting', async () => {
    let release!: (value: Response) => void;
    answer = () => new Promise((resolve) => { release = resolve; });
    note(URL_A);
    hydrateVoiceNotes(document);
    const pressed = toggleVoice(URL_A);
    release(new Response('', { status: 500 }));
    expect(await pressed).toBe(false);
    expect(voiceView(URL_A).status).toBe('failed');
  });

  it('stops the other note when a second one starts, and remembers where each was', async () => {
    await ready(URL_A);
    await ready(URL_B);
    await toggleVoice(URL_A);
    audio().currentTime = 10;
    audio().dispatchEvent(new Event('timeupdate'));
    await toggleVoice(URL_B);
    expect(voiceView(URL_A).playing).toBe(false);
    expect(voiceView(URL_B).playing).toBe(true);
    expect(audio().currentTime).toBe(0);
    await toggleVoice(URL_A);
    expect(audio().currentTime).toBe(10);
  });

  it('moves the playhead on screen without redrawing, and shows time left', async () => {
    const refreshed = vi.fn();
    bindVoicePlayback(refreshed);
    const element = await ready(URL_A);
    const other = note(URL_B);
    await toggleVoice(URL_A);
    refreshed.mockClear();
    audio().currentTime = 21;
    audio().dispatchEvent(new Event('timeupdate'));
    expect(refreshed).not.toHaveBeenCalled();
    expect(element.style.getPropertyValue('--progress')).toBe('0.5');
    expect(element.querySelector('.voice__time')?.textContent).toBe('0:21');
    expect((element.querySelector('.voice__seek') as HTMLInputElement).value).toBe('500');
    expect(other.style.getPropertyValue('--progress')).toBe('');
  });

  it('tolerates a note drawn without its time or seek control', async () => {
    const element = await ready(URL_A);
    element.replaceChildren();
    await toggleVoice(URL_A);
    audio().currentTime = 1;
    audio().dispatchEvent(new Event('timeupdate'));
    expect(element.style.getPropertyValue('--progress')).not.toBe('');
  });

  it('goes back to the start when the note ends', async () => {
    const refreshed = vi.fn();
    bindVoicePlayback(refreshed);
    await ready(URL_A);
    await toggleVoice(URL_A);
    audio().currentTime = 42;
    audio().dispatchEvent(new Event('timeupdate'));
    refreshed.mockClear();
    audio().dispatchEvent(new Event('ended'));
    expect(voiceView(URL_A).position).toBe(0);
    expect(refreshed).toHaveBeenCalled();
  });

  it('says so when the player cannot read what it was given', async () => {
    await ready(URL_A);
    await toggleVoice(URL_A);
    audio().dispatchEvent(new Event('error'));
    expect(voiceView(URL_A).status).toBe('failed');
  });

  it('says so when the browser refuses to start playing', async () => {
    await ready(URL_A);
    FakeAudio.refuse = true;
    expect(await toggleVoice(URL_A)).toBe(false);
    expect(voiceView(URL_A).status).toBe('failed');
  });

  it('ignores player events once nothing is current', async () => {
    await ready(URL_A);
    await toggleVoice(URL_A);
    const element = audio();
    stopVoicePlayback();
    for (const type of ['timeupdate', 'loadedmetadata', 'ended', 'error']) element.dispatchEvent(new Event(type));
    expect(voiceView(URL_A).status).toBe('ready');
  });

  it('stops a note when it leaves the screen, because nobody could pause it', async () => {
    const element = await ready(URL_A);
    await toggleVoice(URL_A);
    hydrateVoiceNotes(document);
    expect(voiceView(URL_A).playing).toBe(true);
    element.remove();
    hydrateVoiceNotes(document);
    expect(voiceView(URL_A).playing).toBe(false);
  });
});

describe('seeking and speed', () => {
  const ready = async (): Promise<void> => {
    note(URL_A);
    hydrateVoiceNotes(document);
    await flush();
  };

  it('moves a stopped note, and the playing one in place', async () => {
    await ready();
    seekVoice(`${URL_A}:250`);
    expect(voiceView(URL_A).position).toBe(10.5);
    await toggleVoice(URL_A);
    expect(audio().currentTime).toBe(10.5);
    seekVoice(`${URL_A}:500`);
    expect(audio().currentTime).toBe(21);
  });

  it('cannot seek what it knows no length for', () => {
    seekVoice(`${URL_A}:500`);
    expect(voiceView(URL_A).position).toBe(0);
  });

  it('keeps a seek on one note from moving the one playing', async () => {
    await ready();
    note(URL_B);
    hydrateVoiceNotes(document);
    await flush();
    await toggleVoice(URL_B);
    audio().currentTime = 3;
    seekVoice(`${URL_A}:500`);
    expect(audio().currentTime).toBe(3);
  });

  it('cycles the speed everywhere, and keeps it for the next note', async () => {
    await ready();
    cycleVoiceRate();
    expect(voiceView(URL_A).rate).toBe(1.5);
    await toggleVoice(URL_A);
    expect(audio().playbackRate).toBe(1.5);
    cycleVoiceRate();
    expect(audio().playbackRate).toBe(2);
    cycleVoiceRate();
    expect(audio().playbackRate).toBe(1);
  });
});

describe('a recording being reviewed', () => {
  const blob = new Blob(['take']);

  it('plays from the URL it already has, without fetching, and keeps the real length', async () => {
    const refreshed = vi.fn();
    bindVoicePlayback(refreshed);
    await adoptRecording('blob:take', blob, 7);
    expect(fetched).toEqual([]);
    expect(voiceView('blob:take')).toMatchObject({ status: 'ready', duration: 42 });
    expect(refreshed).toHaveBeenCalled();
    await toggleVoice('blob:take');
    expect(audio().src).toBe('blob:take');
    forgetRecording('blob:take');
    expect(voiceView('blob:take').playing).toBe(false);
    expect(voiceView('blob:take').status).toBe('loading');
  });

  it('falls back on the timer when the container claims no length', async () => {
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData() { return Promise.resolve({ duration: Number.POSITIVE_INFINITY, getChannelData: () => new Float32Array(4) }); } });
    await adoptRecording('blob:take', blob, 7);
    expect(voiceView('blob:take').duration).toBe(7);
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData() { return Promise.resolve({ duration: 0, getChannelData: () => new Float32Array(4) }); } });
    await adoptRecording('blob:zero', blob, 3);
    expect(voiceView('blob:zero').duration).toBe(3);
  });

  it('forgets a recording that was not the one playing without stopping anything', async () => {
    await adoptRecording('blob:one', blob, 1);
    await adoptRecording('blob:two', blob, 1);
    await toggleVoice('blob:one');
    forgetRecording('blob:two');
    expect(voiceView('blob:one').playing).toBe(true);
  });

  it('never revokes the URL a recording owner still holds', async () => {
    const revoke = vi.mocked(URL.revokeObjectURL);
    await adoptRecording('blob:keep', blob, 1);
    for (let index = 0; index < 25; index += 1) note(`/v/${String(index)}`);
    hydrateVoiceNotes(document);
    await flush();
    expect(voiceView('blob:keep').status).toBe('loading');
    expect(revoke).not.toHaveBeenCalledWith('blob:keep');
  });
});

describe('the clock', () => {
  it('shows full length at rest and time left once started', () => {
    expect(voiceClock({ position: 0, duration: 65, playing: false })).toBe('1:05');
    expect(voiceClock({ position: 5, duration: 65, playing: true })).toBe('1:00');
    expect(voiceClock({ position: 5, duration: 65, playing: false })).toBe('1:00');
    expect(voiceClock({ position: 0, duration: 65, playing: true })).toBe('1:05');
  });

  it('counts up when it has no length to count down from', () => {
    expect(voiceClock({ position: 3, duration: null, playing: true })).toBe('0:03');
  });

  it('never shows a negative time', () => {
    expect(voiceClock({ position: 70, duration: 65, playing: true })).toBe('0:00');
  });
});

describe('progress', () => {
  it('stays at zero for a zero-length note', async () => {
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData() { return Promise.resolve({ duration: 0, getChannelData: () => new Float32Array(4) }); } });
    note(URL_A);
    hydrateVoiceNotes(document);
    await flush();
    expect(voiceView(URL_A).progress).toBe(0);
  });
});

describe('a clean slate', () => {
  it('resets without ever having played', () => {
    resetVoicePlayback();
    stopVoicePlayback();
    cycleVoiceRate();
    expect(voiceView(URL_A).rate).toBe(1.5);
  });
});
