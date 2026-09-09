/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { RoleId } from '../data';
import type { AppState } from '../state';
import { createState } from '../state';
import {
  renderAnalytics,
  renderBroadcasts,
  renderSettings,
} from './workspace';

const NOW = new Date('2026-09-08T12:00:00.000Z');

function stateAs(role: RoleId = 'supervisor', lang: 'ar' | 'en' = 'ar'): AppState {
  const state = createState(NOW);
  state.role = role;
  state.lang = lang;
  return state;
}

function text(element: HTMLElement): string {
  return element.textContent ?? '';
}

describe('broadcasts', () => {
  it('renders one card per campaign with its ledger', () => {
    const element = renderBroadcasts(stateAs('admin'));
    expect(element.querySelectorAll('.card')).toHaveLength(4);
    expect(text(element)).toContain('نتيجة غير معروفة');
    expect(text(element)).toContain('اكتمل الإرسال');
    expect(text(element)).toContain('غير معتمدة');
  });

  it('labels demo data and refuses to imply provider success', () => {
    const element = renderBroadcasts(stateAs('admin'));
    expect(text(element)).toContain('بيانات تجريبية');
    expect(text(element)).toContain('القبول من المزوّد ليس تسليمًا');
  });

  it('names a channel it does not have a label for by its own name', () => {
    const state = stateAs('admin');
    const first = state.dataset.campaigns[0];
    if (first === undefined) throw new Error('the seed has no campaign');
    state.dataset = {
      ...state.dataset,
      campaigns: [{ ...first, channel: 'telegram' as typeof first.channel }],
    };
    // A newer server naming a channel this build has no word for is
    // information, not noise: it is shown as itself rather than dropped.
    expect(text(renderBroadcasts(state))).toContain('telegram');
  });

  it('shows an unfixed audience snapshot honestly', () => {
    expect(text(renderBroadcasts(stateAs('admin')))).toContain('لم تُثبَّت بعد');
  });

  it('hides authoring controls without campaign.draft', () => {
    const element = renderBroadcasts(stateAs('supervisor'));
    expect(element.querySelector('[data-arg="campaign"]')).toBeNull();
    expect(element.querySelectorAll('button[disabled]').length).toBeGreaterThan(0);
  });

  it('renders in English', () => {
    expect(text(renderBroadcasts(stateAs('admin', 'en')))).toContain('Outcome unknown');
  });
});

describe('analytics', () => {
  it('publishes denominators and freshness', () => {
    const element = renderAnalytics(stateAs('supervisor'));
    expect(element.querySelectorAll('.metric').length).toBeGreaterThanOrEqual(4);
    expect(text(element)).toContain('من إجمالي');
    expect(text(element)).toContain('بيانات تجريبية');
  });

  it('never reports an unsupported receipt as zero', () => {
    const element = renderAnalytics(stateAs('supervisor'));
    const receipts = Array.from(element.querySelectorAll('.card')).at(-1) as HTMLElement;
    const values = Array.from(receipts.querySelectorAll('dd')).map((node) => node.textContent ?? '');
    expect(values.filter((value) => value.includes('غير متاح'))).toHaveLength(2);
    // An unsupported receipt is never rendered as a number, a zero or a ratio.
    for (const value of values) expect(value).not.toMatch(/[0-90-9%٪]/);
  });

  it('renders channel and workload distributions', () => {
    const element = renderAnalytics(stateAs('supervisor'));
    expect(element.querySelectorAll('.bars__row').length).toBeGreaterThan(6);
  });

  it('denies the screen without report.read', () => {
    const element = renderAnalytics(stateAs('agent'));
    expect(element.querySelector('.statebox--denied')).not.toBeNull();
    expect(text(element)).toContain('report.read');
  });

  it('renders in English', () => {
    expect(text(renderAnalytics(stateAs('admin', 'en')))).toContain('Not available');
  });
});

describe('settings', () => {
  it('renders working form controls with defaults', () => {
    const element = renderSettings(stateAs('admin'));
    expect(element.querySelectorAll('input, select')).toHaveLength(4);
    expect((element.querySelector('[data-form="company"]') as HTMLInputElement).value).toBe('Digital School');
    expect((element.querySelector('[data-form="tz"]') as HTMLSelectElement).value).toBe('Africa/Cairo');
    expect(element.querySelectorAll('[role="switch"]')).toHaveLength(3);
  });

  it('reflects edited form values', () => {
    const state = stateAs('admin');
    state.dialogForm = {
      company: 'Noor Retail',
      tz: 'Asia/Riyadh',
      retention: '36',
      slaPause: 'off',
      away: 'on',
      maskPhones: 'off',
    };
    const element = renderSettings(state);
    expect((element.querySelector('[data-form="company"]') as HTMLInputElement).value).toBe('Noor Retail');
    expect((element.querySelector('[data-form="tz"]') as HTMLSelectElement).value).toBe('Asia/Riyadh');
    const switches = Array.from(element.querySelectorAll('[role="switch"]')).map((node) =>
      node.getAttribute('aria-checked'),
    );
    expect(switches).toEqual(['false', 'true', 'false']);
  });

  it('states the retention and suppression rules', () => {
    const element = renderSettings(stateAs('admin'));
    expect(text(element)).toContain('لا يوجد زر «إلغاء حجب»');
    expect(text(element)).toContain('UTC');
    expect(text(element)).toContain('30 ثانية');
  });

  it('renders in English', () => {
    expect(text(renderSettings(stateAs('admin', 'en')))).toContain('Business hours');
  });
});
