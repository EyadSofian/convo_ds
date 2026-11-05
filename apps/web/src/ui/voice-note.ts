import { h } from '../dom.js';
import { icon } from '../icons.js';
import { voiceClock, voiceView } from '../live/voice-playback.js';
import type { AppState } from '../state.js';
import { t } from './copy.js';

/**
 * A voice note: play, its real waveform, time left, speed.
 *
 * Laid out left to right in every language. A timeline runs the way a recording
 * runs, and flipping it in Arabic would make the playhead look like rewinding.
 */
export function voiceNote(state: AppState, url: string, tone: 'in' | 'out' | 'draft', label: string, downloadName: string | null): HTMLElement {
  const view = voiceView(url);
  const failed = view.status === 'failed';
  const bars = (): readonly HTMLElement[] => view.peaks.map((peak) => h('i', { style: `--bar:${peak.toFixed(2)}` }));
  return h('div', {
    class: `voice voice--${tone}`,
    dir: 'ltr',
    role: 'group',
    'aria-label': label,
    'data-voice': url,
    'data-status': view.status,
    'data-playing': String(view.playing),
    style: `--progress:${String(view.progress)}`,
  }, [
    h('button', {
      type: 'button',
      class: 'voice__toggle',
      'data-act': 'live-voice-play',
      'data-arg': url,
      'aria-label': failed
        ? t(state, 'إعادة المحاولة', 'Try again')
        : view.playing ? t(state, 'إيقاف مؤقت', 'Pause') : t(state, 'تشغيل', 'Play'),
    }, [icon(failed ? 'refresh' : view.playing ? 'pause' : 'play', 16)]),
    failed
      ? h('p', { class: 'voice__failed', dir: 'auto' }, [
          t(state, 'تعذّر تشغيل الرسالة الصوتية.', 'This voice note could not be played.'),
          downloadName === null ? null : h('a', { class: 'voice__download', href: url, download: downloadName }, [t(state, 'تحميلها', 'Download it')]),
        ])
      : h('div', { class: 'voice__body' }, [
          h('div', { class: 'voice__track' }, [
            h('div', { class: 'voice__bars', 'aria-hidden': 'true' }, bars()),
            h('div', { class: 'voice__bars voice__bars--played', 'aria-hidden': 'true' }, bars()),
            h('input', {
              class: 'voice__seek',
              type: 'range',
              min: '0',
              max: '1000',
              value: String(Math.round(view.progress * 1000)),
              disabled: view.duration === null,
              'aria-label': t(state, 'موضع التشغيل', 'Playback position'),
              'data-act': 'live-voice-seek',
              'data-form': url,
            }),
          ]),
          h('div', { class: 'voice__foot' }, [
            h('span', { class: 'voice__time' }, [voiceClock(view)]),
            h('button', {
              type: 'button',
              class: 'voice__rate',
              'data-act': 'live-voice-rate',
              'aria-label': t(state, 'سرعة التشغيل', 'Playback speed'),
            }, [`${String(view.rate)}×`]),
          ]),
        ]),
  ]);
}
