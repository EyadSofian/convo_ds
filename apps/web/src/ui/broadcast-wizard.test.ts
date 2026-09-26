/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { WhatsAppTemplate } from '../api/automations';
import type { Campaign } from '../api/campaigns';
import type { ChannelConnection } from '../api/channels';
import { previewKey } from '../live/audience';
import { createState } from '../state';
import type { AppState } from '../state';
import { broadcastWizard } from './broadcast-wizard';

const NOW = new Date('2026-09-26T09:00:00.000Z');
const ALL = ['campaign.read', 'campaign.draft', 'campaign.approve', 'campaign.launch'];

const TEMPLATE: WhatsAppTemplate = {
  id: 'wa-1', connectionId: 'cn-1', providerTemplateId: 'p-1', templateName: 'class_open', language: 'en', category: 'MARKETING', status: 'approved',
  components: [{ type: 'BODY', text: 'Hi {{1}}, class on {{2}}' }], variables: [], lastSyncedAt: NOW.toISOString(),
};

const CAMPAIGN: Campaign = {
  id: 'c-1', name: 'Autumn offer', objective: null, connection_id: 'cn-1', state: 'draft', version: 2, revision_id: 'r', revision: 1,
  revision_hash: 'h', content: { type: 'template', template: { id: 'wa-1', name: 'class_open', language: 'en', parameters: { 'body:1': { source: 'display_name' }, 'body:2': { source: 'static', value: 'Sunday' } } } },
  variables: {}, audience_filter: {}, timezone: 'Africa/Cairo', expires_at: null, budget_amount_minor: '0', budget_currency: 'USD',
  approved: false, audience: null, execution: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
};

function number(id: string, status: ChannelConnection['status'] = 'healthy'): ChannelConnection {
  return { id, kind: 'whatsapp', display_name: `Line ${id}`, external_asset_id: `phone-${id}`, status, disconnected_at: null } as ChannelConnection;
}

function wizard(permissions: readonly string[] = ALL, lang: 'ar' | 'en' = 'en'): AppState {
  const state = createState(NOW);
  state.lang = lang;
  state.live.session = {
    status: 'signed_in', email: 'a@b.c', tenantId: 't',
    memberships: [{ id: 'm', tenant: { id: 't', name: 'School', slug: 'school' }, role: { id: 'r', key: 'x', name: 'X' }, permissions }],
  };
  state.live.connections = { status: 'ready', loadedAt: 1, value: [number('cn-1'), number('cn-2', 'webhook_pending')] };
  state.live.whatsappTemplates = { status: 'ready', loadedAt: 1, value: [TEMPLATE] };
  state.dialog = { kind: 'campaign', arg: '' };
  return state;
}

const render = (state: AppState): HTMLElement => broadcastWizard(state, state.dialog!.kind, state.dialog!.arg);
const text = (element: Element | null | undefined): string => element?.textContent ?? '';

describe('before the wizard can start', () => {
  it('says when the campaign being edited is gone, and when there is no WhatsApp number', () => {
    const state = wizard();
    state.dialog = { kind: 'campaign-edit', arg: 'gone' };
    state.live.campaigns = { status: 'ready', loadedAt: 1, value: [] };
    expect(text(render(state))).toContain('no longer exists');
    state.dialog = { kind: 'campaign', arg: '' };
    state.live.connections = { status: 'ready', loadedAt: 1, value: [] };
    const none = render(state);
    expect(text(none)).toContain('Connect a WhatsApp number first');
    expect(none.querySelector('.empty [data-act="nav"]')?.getAttribute('data-arg')).toBe('channels');
  });
});

describe('the steps', () => {
  it('starts on setup: a name, and the WhatsApp number it goes from', () => {
    const state = wizard();
    let root = render(state);
    expect(text(root.querySelector('.dialog__title'))).toBe('New WhatsApp broadcast');
    expect([...root.querySelectorAll('.broadcast__step')].map((step) => step.className)).toEqual([
      'broadcast__step is-current', 'broadcast__step', 'broadcast__step', 'broadcast__step',
    ]);
    const numbers = [...root.querySelectorAll('.broadcast__number')];
    expect(numbers.map((entry) => entry.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(numbers.map((entry) => text(entry.querySelector('.broadcast__number-state')))).toEqual(['Ready', 'Setup incomplete']);
    expect(root.querySelector('.dialog__footer [data-act="close-dialog"]')).not.toBeNull();
    expect(root.querySelector('.dialog__footer [data-act="live-broadcast-step"]')?.getAttribute('data-arg')).toBe('1');
    state.formErrors = { campaignName: 'Name the broadcast.', campaignConnection: 'Choose a WhatsApp number.' };
    state.dialogForm = { campaignConnection: 'cn-2' };
    root = render(state);
    expect([...root.querySelectorAll('.field__error')].map((error) => error.textContent)).toEqual(['Name the broadcast.', 'Choose a WhatsApp number.']);
    expect(root.querySelector('.broadcast__number[aria-checked="true"]')?.getAttribute('data-arg')).toBe('campaignConnection:cn-2');
  });

  it('picks the message from the number’s approved templates, however they are loading', () => {
    const state = wizard();
    state.dialogForm = { broadcastStep: '1' };
    state.live.whatsappTemplates = { status: 'loading' };
    expect(text(render(state))).toContain('Loading approved templates…');
    state.live.whatsappTemplates = { status: 'error', error: { code: 'x', message: 'Templates down', requestId: 'r', status: 500, details: [] } };
    expect(text(render(state))).toContain('Templates down');
    state.live.whatsappTemplates = { status: 'ready', loadedAt: 1, value: [{ ...TEMPLATE, connectionId: 'elsewhere' }] };
    expect(text(render(state))).toContain('No approved templates on this number');
    state.live.whatsappTemplates = { status: 'ready', loadedAt: 1, value: [TEMPLATE] };
    state.dialogForm = { broadcastStep: '1', campaignTemplate: 'wa-1' };
    state.formErrors = { campaignTemplate: 'Give every variable a value.' };
    const root = render(state);
    expect(root.querySelector('.tpl-card.is-selected')).not.toBeNull();
    expect(text(root.querySelector('.wa-phone__name'))).toBe('Line cn-1');
    expect(text(root.querySelector('.broadcast__panel > .notice'))).toBe('Give every variable a value.');
    expect(root.querySelector('.tpl-var--missing')).not.toBeNull();
    expect(root.querySelector('.dialog__footer [data-act="live-broadcast-step"]')?.getAttribute('data-arg')).toBe('0');
    // A number whose details are not loaded still previews under a plain name.
    state.dialogForm = { broadcastStep: '1', campaignConnection: 'cn-9', campaignTemplate: 'wa-1' };
    state.live.whatsappTemplates = { status: 'ready', loadedAt: 1, value: [{ ...TEMPLATE, connectionId: 'cn-9' }] };
    expect(text(render(state).querySelector('.wa-phone__name'))).toBe('WhatsApp');
  });

  it('edits a saved broadcast from what it holds', () => {
    const state = wizard();
    state.dialog = { kind: 'campaign-edit', arg: 'c-1' };
    state.live.campaigns = { status: 'ready', loadedAt: 1, value: [CAMPAIGN] };
    let root = render(state);
    expect(text(root.querySelector('.dialog__title'))).toBe('Edit broadcast');
    expect((root.querySelector('#campaign-name') as HTMLInputElement).value).toBe('Autumn offer');
    state.dialogForm = { broadcastStep: '1' };
    root = render(state);
    expect(text(root.querySelector('.wa-bubble__body'))).toBe('Hi Mona, class on Sunday');
  });

  it('chooses the audience with the shared audience block', () => {
    const state = wizard();
    state.dialogForm = { broadcastStep: '2' };
    expect(render(state).querySelector('.broadcast__panel--audience .audience')).not.toBeNull();
  });
});

describe('the last step', () => {
  function review(state: AppState): readonly string[] {
    return [...render(state).querySelectorAll('.broadcast__review-row')].map((row) => text(row));
  }

  it('reads everything back and sends now, as far as the operator may take it', () => {
    const state = wizard();
    state.dialogForm = { broadcastStep: '3', campaignName: 'Sunday reminder', campaignTemplate: 'wa-1', campaignParam_body_2_value: 'Sunday' };
    let root = render(state);
    expect([...root.querySelectorAll('.broadcast__choice')].map((choice) => choice.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(review(state)).toEqual([
      'NameSunday reminder', 'FromLine cn-1 · phone-cn-1', 'Templateclass_open · en', 'VariablesBody {{1}}: name, Body {{2}}: fixed text',
      'AudienceNot counted yet', 'WhenNow',
    ]);
    expect(root.querySelector('.broadcast__panel [data-act="live-campaign-audience-preview"]')).not.toBeNull();
    const send = root.querySelector('.broadcast__finish [data-arg="now"]') as HTMLButtonElement;
    expect(text(send)).toBe('Send now');
    expect(root.querySelector('.broadcast__finish [data-arg="draft"]')).not.toBeNull();
    // Counted: the review says how many.
    state.live.audiencePreview = { key: previewKey('cn-1', {}), result: { status: 'ready', loadedAt: 1, value: { total: 5, eligible: 3, excluded: 2, reasons: { suppressed: 1, no_consent: 1, identity_inactive: 0 }, sample: [] } } };
    root = render(state);
    expect(review(state)).toContain('Audience3 will receive it, of 5');
    expect(root.querySelector('.broadcast__panel [data-act="live-campaign-audience-preview"]')).toBeNull();
    // Busy: the button that was pressed spins.
    state.live.busy = 'broadcast-submit';
    state.dialogForm = { ...state.dialogForm, broadcastMode: 'draft' };
    root = render(state);
    expect(root.querySelector('.broadcast__finish [data-arg="draft"]')?.getAttribute('aria-busy')).toBe('true');
    expect(root.querySelector('.broadcast__finish [data-arg="now"]')?.getAttribute('aria-busy')).toBeNull();
    state.dialogForm = { ...state.dialogForm, broadcastMode: 'now' };
    expect(render(state).querySelector('.broadcast__finish [data-arg="now"]')?.getAttribute('aria-busy')).toBe('true');
  });

  it('names where each variable sits', () => {
    const state = wizard();
    state.live.whatsappTemplates = { status: 'ready', loadedAt: 1, value: [{ ...TEMPLATE, components: [
      { type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' },
      { type: 'BODY', text: 'Hello' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Open', url: 'https://x.example/{{1}}' }] },
    ] }] };
    state.dialogForm = { broadcastStep: '3', campaignTemplate: 'wa-1', campaignParam_button_0_1_value: 'abc' };
    expect(review(state)[3]).toBe('VariablesHeader {{1}}: name, Button {{1}}: fixed text');
  });

  it('schedules for a time in the operator’s zone', () => {
    const state = wizard();
    state.dialogForm = { broadcastStep: '3', campaignWhen: 'later', campaignScheduleAt: '2026-10-01T17:00' };
    state.formErrors = { campaignScheduleAt: 'Choose a time in the future.' };
    const root = render(state);
    expect((root.querySelector('#campaign-schedule-at') as HTMLInputElement).value).toBe('2026-10-01T17:00');
    expect(text(root.querySelector('.broadcast__schedule .field__error'))).toBe('Choose a time in the future.');
    expect(text(root.querySelector('.broadcast__finish [data-arg="schedule"]'))).toBe('Schedule broadcast');
    expect(review(state).at(-1)).not.toBe('When—');
    expect(review(state)[2]).toBe('Template—');
    expect(review(state)[3]).toBe('VariablesNone');
    state.dialogForm = { broadcastStep: '3', campaignWhen: 'later' };
    expect(review(state).at(-1)).toBe('When—');
    // A number that is no longer listed is shown as unknown rather than guessed.
    state.dialogForm = { broadcastStep: '3', campaignConnection: 'cn-gone' };
    expect(review(state)[1]).toBe('From—');
  });

  it('submits for approval when the operator cannot approve and launch, in Arabic too', () => {
    const state = wizard(['campaign.read', 'campaign.draft'], 'ar');
    state.dialogForm = { broadcastStep: '3', campaignTemplate: 'wa-1', campaignParam_body_1_source: 'phone', campaignParam_body_2_source: 'field', campaignParam_body_2_field: 'f-1' };
    const root = render(state);
    expect(text(root.querySelector('.broadcast__finish [data-arg="now"]'))).toBe('إرسال للاعتماد');
    expect(review(state)[3]).toBe('المتغيراتالنص {{1}}: الرقم، النص {{2}}: حقل');
    expect(review(state)[5]).toBe('الموعدالآن');
    state.dialogForm = { broadcastStep: '9' };
    expect(render(state).querySelector('.broadcast__step.is-current .broadcast__step-button')?.getAttribute('data-arg')).toBe('0');
  });
});
