/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { AppState } from '../state';
import { createState } from '../state';
import { renderDialog } from './dialogs';

const NOW = new Date('2026-09-08T12:00:00.000Z');

function open(kind: string, arg = '', lang: 'ar' | 'en' = 'ar'): { state: AppState; element: HTMLElement } {
  const state = createState(NOW);
  state.lang = lang;
  state.route = { screen: 'inbox', conversationId: 'cv-4821', params: {} };
  state.dialog = { kind, arg };
  const element = renderDialog(state);
  if (element === null) throw new Error('expected a dialog');
  return { state, element };
}

function text(element: HTMLElement): string {
  return element.textContent ?? '';
}

describe('renderDialog', () => {
  it('renders nothing when no dialog is open', () => {
    expect(renderDialog(createState(NOW))).toBeNull();
  });

  it('renders the connect-channel dialog without promising a connection', () => {
    const { element } = open('connect-channel');
    expect((element.querySelector('[data-form="provider"]') as HTMLSelectElement).value).toBe('whatsapp');
    expect(text(element)).toContain('تفويض OAuth حقيقي');
  });

  it('renders the invite dialog with the delegation ceiling stated', () => {
    const { element } = open('invite');
    expect(element.querySelector('[data-form="email"]')).not.toBeNull();
    expect(text(element)).toContain('سقف تفويضك');
    expect(text(element)).toContain('لا توجد كلمة مرور افتراضية');
  });

  it('renders a member dialog, and says so when the member is gone', () => {
    const found = open('member', 'm-tarek');
    expect(text(found.element)).toContain('طارق منير');
    expect(text(found.element)).toContain('آخر مالك');
    const missing = open('member', 'm-ghost');
    expect(text(missing.element)).toContain('العضو غير موجود');
  });

  it('renders the team and campaign dialogs', () => {
    const team = open('team');
    expect((team.element.querySelector('[data-form="teamInbox"]') as HTMLSelectElement).value).toBe('ib-wa-cairo');
    const campaign = open('campaign');
    expect(text(campaign.element)).toContain('«جاهزة» لا تعني «معتمدة»');
  });

  it('survives a workspace with no inboxes', () => {
    const state = createState(NOW);
    state.dataset = { ...state.dataset, inboxes: [] };
    state.dialog = { kind: 'team', arg: '' };
    const element = renderDialog(state) as HTMLElement;
    expect((element.querySelector('[data-form="teamInbox"]') as HTMLSelectElement).value).toBe('');
  });

  it('falls back for an unknown dialog kind', () => {
    const { element } = open('nonsense');
    expect(text(element)).toContain('لا يوجد محتوى لهذا الحوار');
  });

  it('renders every dialog in English too', () => {
    for (const kind of ['save-view', 'resolve', 'snooze', 'connect-channel', 'invite', 'team', 'campaign', 'nonsense']) {
      expect(text(open(kind, 'm-tarek', 'en').element).length).toBeGreaterThan(10);
    }
    expect(text(open('member', 'm-tarek', 'en').element)).toContain('Tarek Mounir');
    expect(text(open('member', 'm-ghost', 'en').element)).toContain('Member not found');
  });
});
