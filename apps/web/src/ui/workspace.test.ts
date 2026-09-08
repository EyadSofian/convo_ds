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
  renderChannels,
  renderPeople,
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

describe('channels', () => {
  it('renders one card per connection with readiness evidence', () => {
    const element = renderChannels(stateAs('admin'));
    expect(element.querySelectorAll('.card')).toHaveLength(5);
    expect(element.querySelectorAll('.checklist li').length).toBe(25);
    expect(text(element)).toContain('متصلة');
    expect(text(element)).toContain('يلزم إعادة تفويض');
    expect(text(element)).toContain('غير مُهيّأة');
  });

  it('labels demo data and never claims a live provider', () => {
    const element = renderChannels(stateAs('admin'));
    expect(text(element)).toContain('بيانات تجريبية');
    expect(text(element)).toContain('لا يوجد مزوّد متصل فعليًا');
  });

  it('offers connect for an unconfigured asset and reconnect otherwise', () => {
    const element = renderChannels(stateAs('admin'));
    expect(element.querySelector('[data-arg^="connect:"]')).not.toBeNull();
    expect(element.querySelector('[data-arg^="reconnect:"]')).not.toBeNull();
    expect(element.querySelector('[data-arg^="disconnect:"]')).not.toBeNull();
    expect(element.querySelector('[data-act="dialog"][data-arg="connect-channel"]')).not.toBeNull();
  });

  it('disables management and explains why without channel.manage', () => {
    const element = renderChannels(stateAs('supervisor'));
    expect(text(element)).toContain('channel.manage');
    expect(element.querySelector('[data-arg="connect-channel"]')).toBeNull();
    expect(element.querySelectorAll('button[disabled]').length).toBeGreaterThan(0);
  });

  it('renders in English', () => {
    expect(text(renderChannels(stateAs('admin', 'en')))).toContain('Connect a channel');
  });
});

describe('people and roles', () => {
  it('lists every member with role, load and an edit control', () => {
    const element = renderPeople(stateAs('admin'));
    const rows = element.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(7);
    expect(element.querySelector('[data-arg^="member:"]')).not.toBeNull();
    expect(text(element)).toContain('مسؤول حملات');
  });

  it('previews effective access for a chosen role', () => {
    const state = stateAs('admin');
    const agentView = renderPeople(state);
    expect(agentView.querySelectorAll('.rolegrid__key')).toHaveLength(16);
    expect(text(agentView)).toContain('conversation.unassigned.preview');
    state.dialogForm = { previewRole: 'analyst' };
    const grid = renderPeople(state).querySelector('.rolegrid') as HTMLElement;
    expect(grid.querySelectorAll('.pill--success')).toHaveLength(1);
    expect(grid.querySelectorAll('.pill--neutral')).toHaveLength(15);
  });

  it('states that the preview is not the authorization control', () => {
    expect(text(renderPeople(stateAs('admin')))).toContain('ليس ضابط تفويض');
  });

  it('restricts management without member.manage', () => {
    const element = renderPeople(stateAs('agent'));
    expect(text(element)).toContain('member.manage');
    expect(element.querySelector('[data-arg="invite"]')).toBeNull();
  });

  it('renders in English', () => {
    expect(text(renderPeople(stateAs('admin', 'en')))).toContain('Effective access preview');
  });
});

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
