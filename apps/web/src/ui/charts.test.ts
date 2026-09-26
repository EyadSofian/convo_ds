/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { createState } from '../state';
import type { AppState } from '../state';
import { bars, channelHue, columns, donut, gauge, key, seriesHue, share, stack, stat } from './charts';

/**
 * Every chart says its numbers in text as well as in shape and colour: that is
 * what these tests hold them to.
 */

function en(): AppState {
  const state = createState(new Date('2026-09-26T00:00:00Z'));
  state.lang = 'en';
  return state;
}

describe('the palette', () => {
  it('cycles eight categorical hues and gives every channel its brand', () => {
    expect([0, 7, 8].map(seriesHue)).toEqual(['blue', 'cyan', 'blue']);
    expect(['whatsapp', 'facebook', 'website_chat', 'custom_api', 'sms'].map(channelHue)).toEqual(['whatsapp', 'messenger', 'web', 'custom', 'muted']);
  });

  it('writes a share with one decimal, and a dash when there is no whole', () => {
    expect(share(en(), 1, 3)).toBe('33.3%');
    expect(share(en(), 1, 0)).toBe('—');
  });
});

describe('a donut', () => {
  it('draws only the parts that have something, starting at twelve o’clock, and names each in the legend', () => {
    const figure = donut(en(), {
      label: 'By status', centre: '4', centreLabel: 'conversations',
      slices: [{ label: 'Open', value: 3, hue: 'blue' }, { label: 'Pending', value: 1, hue: 'orange' }, { label: 'Snoozed', value: 0, hue: 'violet' }],
    });
    expect(figure.getAttribute('aria-label')).toBe('By status');
    const arcs = Array.from(figure.querySelectorAll('.ring__arc'));
    expect(arcs.map((arc) => arc.getAttribute('class'))).toEqual(['ring__arc viz--blue', 'ring__arc viz--orange']);
    expect(arcs.map((arc) => arc.getAttribute('stroke-dasharray'))).toEqual(['74.20 25.80', '24.20 75.80']);
    expect(arcs.map((arc) => arc.getAttribute('stroke-dashoffset'))).toEqual(['25.00', '-50.00']);
    expect(figure.querySelector('.donut__value')?.textContent).toBe('4');
    expect(Array.from(figure.querySelectorAll('.legend__item')).map((item) => item.textContent)).toEqual(['Open375%', 'Pending125%']);
  });

  it('closes the ring with no gap when one part is the whole, and never draws an arc too thin to see', () => {
    const whole = donut(en(), { label: 'x', centre: '5', centreLabel: 'y', slices: [{ label: 'All', value: 5, hue: 'green' }] });
    expect(whole.querySelector('.ring__arc')?.getAttribute('stroke-dasharray')).toBe('100.00 0.00');
    const sliver = donut(en(), { label: 'x', centre: '1001', centreLabel: 'y', slices: [{ label: 'Most', value: 1000, hue: 'green' }, { label: 'One', value: 1, hue: 'danger' }] });
    expect(sliver.querySelectorAll('.ring__arc')[1]?.getAttribute('stroke-dasharray')).toBe('0.40 99.60');
  });
});

describe('a gauge', () => {
  it('fills to its rate, clamped to the ring, with its detail under the label', () => {
    const full = gauge(en(), { label: 'Delivered', ratio: 1.4, hue: 'teal', detail: '401 delivered' });
    expect(full.getAttribute('aria-label')).toBe('Delivered: 100%');
    expect(full.querySelector('.ring__arc')?.getAttribute('stroke-dasharray')).toBe('100.00 0.00');
    expect(full.querySelector('.gauge__detail')?.textContent).toBe('401 delivered');
  });

  it('draws only the track for nothing, and a dash when there is no rate yet', () => {
    const none = gauge(en(), { label: 'Read', ratio: 0, hue: 'green' });
    expect(none.querySelector('.ring__arc')).toBeNull();
    expect(none.querySelector('.gauge__value')?.textContent).toBe('0%');
    expect(none.querySelector('.gauge__detail')).toBeNull();
    const unknown = gauge(en(), { label: 'Read', ratio: null, hue: 'green' });
    expect(unknown.querySelector('.gauge__value')?.textContent).toBe('—');
    expect(gauge(en(), { label: 'Read', ratio: -1, hue: 'green' }).querySelector('.ring__arc')).toBeNull();
  });
});

describe('bars', () => {
  it('measures each row against the largest, or against a given whole', () => {
    const list = bars(en(), [
      { label: 'Mona', value: 8, hue: 'blue' },
      { label: 'Sara', value: 2, hue: 'violet', display: '2 min', note: '4 measured' },
    ]);
    const fills = Array.from(list.querySelectorAll<HTMLElement>('.hbars__fill')).map((fill) => fill.getAttribute('style'));
    expect(fills).toEqual(['--size:100%', '--size:25%']);
    expect(list.querySelectorAll('.hbars__value')[1]?.textContent).toBe('2 min');
    expect(list.querySelector('.hbars__note')?.textContent).toBe('4 measured');
    expect(list.className).toBe('hbars');
    const shares = bars(en(), [{ label: 'x', value: 5, hue: 'teal' }], 20, true);
    expect(shares.className).toBe('hbars hbars--compact');
    expect(shares.querySelector('.hbars__fill')?.getAttribute('style')).toBe('--size:25%');
    expect(bars(en(), [{ label: 'x', value: 0, hue: 'teal' }]).querySelector('.hbars__fill')?.getAttribute('style')).toBe('--size:0%');
  });

  it('rises in columns with each value above and its label below', () => {
    const chart = columns(en(), 'Response times', [{ label: '>4h', value: 1, hue: 'danger' }, { label: '<5m', value: 4, hue: 'green' }]);
    expect(chart.getAttribute('aria-label')).toBe('Response times');
    expect(Array.from(chart.querySelectorAll('.vbars__bar')).map((bar) => bar.getAttribute('style'))).toEqual(['--size:25%', '--size:100%']);
    expect(chart.querySelector('.vbars__label bdi')?.textContent).toBe('>4h');
  });

  it('splits one bar into the parts of a whole, and says them in words', () => {
    const bar = stack(en(), [{ label: 'Read', value: 3, hue: 'green' }, { label: 'Failed', value: 0, hue: 'danger' }, { label: 'Sent', value: 1, hue: 'cyan' }], 8);
    expect(bar.getAttribute('aria-label')).toBe('Read 37.5% · Sent 12.5%');
    expect(bar.querySelectorAll('.stackbar__part')).toHaveLength(2);
    expect(stack(en(), [], 0).getAttribute('aria-label')).toBe('—');
  });

  it('keys a chart whose numbers are written elsewhere', () => {
    const legend = key([{ label: 'New', hue: 'blue' }, { label: 'Resolved', hue: 'green' }]);
    expect(legend.getAttribute('aria-hidden')).toBe('true');
    expect(legend.textContent).toBe('NewResolved');
  });
});

describe('a headline figure', () => {
  it('carries its icon, hue and foot, and says when it is a failure or not measured', () => {
    const plain = stat({ label: 'Sent', value: '502', icon: 'send', hue: 'cyan', foot: '81% of recipients' });
    expect(plain.className).toBe('kpi kpi--stat viz--cyan');
    expect(plain.querySelector('.kpi__icon svg')).not.toBeNull();
    expect(plain.querySelector('.kpi__foot')?.textContent).toBe('81% of recipients');
    expect(stat({ label: 'Failed', value: '19', icon: 'alert', hue: 'danger', danger: true }).className).toContain('kpi--danger');
    const unmeasured = stat({ label: 'Replies', value: 'Not measured', icon: 'reply', hue: 'muted', unavailable: true });
    expect(unmeasured.className).toContain('kpi--unavailable');
    expect(unmeasured.querySelector('.kpi__foot')).toBeNull();
  });
});
