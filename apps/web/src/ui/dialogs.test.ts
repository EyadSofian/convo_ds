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
    expect(text(campaign.element)).toContain('اربط قناة سليمة أولًا');
    expect(campaign.element.querySelector('[data-act="live-campaign-create"]')).not.toBeNull();
  });

  it('offers healthy server channels in the campaign form and disables it while saving', () => {
    const ready = open('campaign', '', 'en');
    ready.state.live.connections = { status: 'ready', loadedAt: NOW.getTime(), value: [{
      id: 'channel-1', kind: 'whatsapp', provider: 'meta', display_name: 'Admissions WhatsApp',
      external_asset_id: 'phone-1', provider_app_id: 'app-1', status: 'healthy',
      capabilities: {
        kind: 'whatsapp', version: 'v21.0', host: 'graph.facebook.com', inboundEvents: ['messages'],
        outboundTypes: ['text', 'template'], attachmentTypes: ['image'], textLimit: { characters: 4096, bytes: 4096 },
        windowHours: 24, businessInitiated: true, templates: true, deliveryReceipts: true, readReceipts: true,
      },
      evidence: [], missing_evidence: [], last_error_code: null, last_error_at: null,
      created_at: NOW.toISOString(), disconnected_at: null, credential_held: true, credential_fingerprint: 'f'.repeat(64),
    }] };
    ready.state.dialogForm = { campaignMessage: 'Welcome' };
    const enabled = renderDialog(ready.state) as HTMLElement;
    expect((enabled.querySelector('[data-form="campaignConnection"]') as HTMLSelectElement).value).toBe('channel-1');
    expect(text(enabled)).toContain('After creating the draft');
    expect((enabled.querySelector('[data-act="live-campaign-create"]') as HTMLButtonElement).disabled).toBe(false);

    ready.state.live.busy = 'campaign-create';
    const busy = renderDialog(ready.state) as HTMLElement;
    expect((busy.querySelector('[data-act="live-campaign-create"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('prefills an editable server campaign and handles a campaign removed underneath', () => {
    const ready = open('campaign-edit', 'campaign-1', 'en');
    ready.state.live.connections = { status: 'ready', loadedAt: 1, value: [{
      id: 'channel-1', kind: 'whatsapp', provider: 'meta', display_name: 'Admissions', external_asset_id: 'phone-1',
      provider_app_id: 'app-1', status: 'healthy', capabilities: { kind: 'whatsapp', version: 'v21.0', host: 'graph.facebook.com', inboundEvents: [], outboundTypes: ['text'], attachmentTypes: [], textLimit: { characters: 4096, bytes: 4096 }, windowHours: 24, businessInitiated: true, templates: true, deliveryReceipts: true, readReceipts: true },
      evidence: [], missing_evidence: [], last_error_code: null, last_error_at: null, created_at: NOW.toISOString(), disconnected_at: null, credential_held: true, credential_fingerprint: 'f'.repeat(64),
    }] };
    ready.state.live.campaigns = { status: 'ready', loadedAt: 1, value: [{
      id: 'campaign-1', name: 'September', objective: 'Enrolment', connection_id: 'channel-1', state: 'ready', version: 3,
      revision_id: 'revision-1', revision: 1, revision_hash: 'a'.repeat(64), content: { text: 'Welcome student' },
      variables: { display_name: 'display_name' }, audience_filter: { search: 'Mona' }, timezone: 'Africa/Cairo',
      expires_at: null, budget_amount_minor: '0.000000', budget_currency: 'USD', approved: true,
      audience: { total: 2, eligible: 1, excluded: 1 }, execution: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    }] };
    const form = renderDialog(ready.state) as HTMLElement;
    expect((form.querySelector('[data-form="campaignName"]') as HTMLInputElement).value).toBe('September');
    expect((form.querySelector('[data-form="campaignMessage"]') as HTMLTextAreaElement).value).toBe('Welcome student');
    expect((form.querySelector('[data-form="campaignSearch"]') as HTMLInputElement).value).toBe('Mona');
    expect(form.querySelector('[data-act="live-campaign-update"][data-arg="campaign-1"]')).not.toBeNull();
    expect(text(form)).toContain('must be frozen and approved again');

    const current = ready.state.live.connections.value[0];
    if (current !== undefined) {
      ready.state.live.connections = { status: 'ready', loadedAt: 2, value: [{ ...current, status: 'authorization_needed' }] };
    }
    expect((renderDialog(ready.state) as HTMLElement).querySelector('[data-form="campaignConnection"]')).not.toBeNull();

    ready.state.live.campaigns = { status: 'ready', loadedAt: 2, value: [] };
    expect(text(renderDialog(ready.state) as HTMLElement)).toContain('no longer exists');
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
