/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { AudiencePreview } from '../api/campaigns.js';
import type { ApiError } from '../api/client.js';
import { conditionsFromFilter, previewKey } from '../live/audience.js';
import { createState } from '../state.js';
import type { AppState } from '../state.js';
import { audienceSection } from './campaign-audience.js';

const NOW = new Date('2026-09-26T09:00:00.000Z');
const LABEL = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const ERROR: ApiError = { code: 'down', message: 'Catalogue down', requestId: 'r', status: 503, details: [] };
const PREVIEW: AudiencePreview = { total: 3, eligible: 2, excluded: 1, reasons: { suppressed: 1, no_consent: 0, identity_inactive: 0 }, sample: ['Mona', 'Sara'] };

function editor(lang: 'ar' | 'en' = 'en'): AppState {
  const state = createState(NOW);
  state.lang = lang;
  state.dialog = { kind: 'campaign', arg: '' };
  state.live.connections = { status: 'ready', loadedAt: 1, value: [{ id: 'channel-1', status: 'healthy' }] as never };
  return state;
}

const text = (element: Element | null): string => element?.textContent ?? '';

describe('the audience block', () => {
  it('offers five sources, marks the chosen one, and states who can receive a campaign', () => {
    const state = editor();
    const block = audienceSection(state);
    const sources = [...block.querySelectorAll('.audience-source')];
    expect(sources.map((source) => source.getAttribute('data-arg'))).toEqual(['all', 'labels', 'conversations', 'picked', 'saved']);
    expect(sources[0]?.getAttribute('aria-checked')).toBe('true');
    expect(text(block)).toContain('marketing consent');
    // Everyone: no picker, no saving, but a name narrowing and a count.
    expect(block.querySelector('.audience__panel')).toBeNull();
    expect(block.querySelector('.audience__save')).toBeNull();
    expect(block.querySelector('[data-form="campaignSearch"]')).not.toBeNull();
    expect(text(block.querySelector('.audience__preview'))).toContain('See how many people');
    expect(text(audienceSection(editor('ar')))).toContain('من سيستلم الحملة');
  });

  it('picks labels as toggling chips, and says when there are none or they failed', () => {
    const state = editor();
    state.dialogForm = { campaignAudienceSource: 'labels', campaignLabelIds: LABEL };
    expect(text(audienceSection(state).querySelector('.audience__panel'))).toBe('Loading labels…');
    state.live.labels = { status: 'error', error: ERROR };
    expect(text(audienceSection(state).querySelector('.audience__panel'))).toBe('Catalogue down');
    state.live.labels = { status: 'ready', loadedAt: 1, value: [{ id: 'old', name: 'Old', color: '#000000', state: 'retired', version: 1 }] };
    expect(text(audienceSection(state).querySelector('.audience__panel'))).toContain('No labels yet');
    state.live.labels = { status: 'ready', loadedAt: 1, value: [
      { id: LABEL, name: 'VIP', color: '#2563eb', state: 'active', version: 1 },
      { id: 'other', name: 'Late', color: '#dc2626', state: 'active', version: 1 },
    ] };
    const chips = [...audienceSection(state).querySelectorAll('.audience-chip')];
    expect(chips.map((chip) => chip.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    expect(chips[0]?.getAttribute('data-arg')).toBe('campaignLabelIds:');
    expect(chips[1]?.getAttribute('data-arg')).toBe(`campaignLabelIds:${LABEL},other`);
    state.dialogForm = { campaignAudienceSource: 'conversations' };
    expect(audienceSection(state).querySelector('.audience-chip')?.getAttribute('data-arg')).toBe(`campaignConversationLabelIds:${LABEL}`);
    expect(audienceSection(state).querySelector('.audience__save')).not.toBeNull();
  });

  it('hand-picks contacts from the directory with a running count', () => {
    const state = editor();
    state.dialogForm = { campaignAudienceSource: 'picked', campaignContactIds: CONTACT };
    expect(text(audienceSection(state))).toContain('Loading contacts…');
    state.live.contacts = { status: 'error', error: ERROR };
    expect(text(audienceSection(state))).toContain('Catalogue down');
    state.live.contacts = { status: 'ready', loadedAt: 1, value: [] };
    expect(text(audienceSection(state))).toContain('No matches.');
    state.live.contacts = { status: 'ready', loadedAt: 1, value: [
      { id: CONTACT, displayName: 'Mona', identities: [{ id: 'i', kind: 'whatsapp', scopeId: 's', externalId: '2010', validFrom: NOW.toISOString(), validTo: null }], labels: [], customFields: [], attributes: {}, version: 1, createdAt: NOW.toISOString() },
      { id: 'c-2', displayName: 'Sara', identities: [], labels: [], customFields: [], attributes: {}, version: 1, createdAt: NOW.toISOString() },
    ] };
    const block = audienceSection(state);
    const people = [...block.querySelectorAll('.audience-person')];
    expect(people.map((person) => person.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    expect(text(people[0] ?? null)).toContain('WhatsApp');
    expect(text(people[1] ?? null)).toContain('No live identity');
    expect(text(block.querySelector('.audience__count'))).toBe('1 picked');
    expect(text(audienceSection(Object.assign(state, { lang: 'ar' })).querySelector('.audience__count'))).toBe('1 مختار');
  });

  it('chooses a saved audience, marking ones a campaign cannot apply', () => {
    const state = editor();
    state.dialogForm = { campaignAudienceSource: 'saved' };
    expect(text(audienceSection(state))).toContain('Loading saved audiences…');
    state.live.audiences = { status: 'error', error: ERROR };
    expect(text(audienceSection(state))).toContain('Catalogue down');
    state.live.audiences = { status: 'ready', loadedAt: 1, value: [] };
    expect(text(audienceSection(state))).toContain('No saved audiences yet');
    state.live.audiences = { status: 'ready', loadedAt: 1, value: [
      { id: 'a-1', name: 'VIPs', description: null, conditions: conditionsFromFilter({ labelIds: [LABEL] }) as never, state: 'active', version: 1 },
      { id: 'a-2', name: 'Odd', description: null, conditions: { version: 1, root: { kind: 'group', match: 'any', conditions: [] } }, state: 'active', version: 1 },
    ] };
    const block = audienceSection(state);
    const options = [...block.querySelectorAll('#campaign-saved-audience option')].map((option) => option.textContent);
    expect(options).toEqual(['Choose an audience', 'VIPs', 'Odd (not usable in campaigns)']);
    // A saved audience carries its own name narrowing, and is already saved.
    expect(block.querySelector('[data-form="campaignSearch"]')).toBeNull();
    expect(block.querySelector('.audience__save')).toBeNull();
    state.lang = 'ar';
    expect([...audienceSection(state).querySelectorAll('#campaign-saved-audience option')].map((option) => option.textContent)).toContain('Odd (غير صالح للحملات)');
  });

  it('shows a count only for the filter it was taken for', () => {
    const state = editor();
    const key = previewKey('channel-1', {});
    state.live.audiencePreview = { key: 'another', result: { status: 'ready', value: PREVIEW, loadedAt: 1 } };
    expect(text(audienceSection(state).querySelector('.audience__preview'))).toContain('changed since the last count');
    state.live.audiencePreview = { key, result: { status: 'loading' } };
    expect(audienceSection(state).querySelector('[data-act="live-campaign-audience-preview"]')?.getAttribute('aria-busy')).toBe('true');
    state.live.audiencePreview = { key, result: { status: 'error', error: ERROR } };
    expect(text(audienceSection(state).querySelector('.audience__preview [role="alert"]'))).toBe('Catalogue down');
    state.live.audiencePreview = { key, result: { status: 'ready', value: PREVIEW, loadedAt: 1 } };
    const result = audienceSection(state).querySelector('.audience-result') as HTMLElement;
    expect(text(result.querySelector('.audience-result__eligible strong'))).toBe('2');
    expect(result.querySelector('.audience-result__eligible--none')).toBeNull();
    expect(text(result)).toContain('Opted out1');
    expect(text(result.querySelector('.audience-result__sample'))).toBe('For example: Mona, Sara');
    state.live.audiencePreview = { key, result: { status: 'ready', value: { ...PREVIEW, eligible: 0, sample: [] }, loadedAt: 1 } };
    const none = audienceSection(state).querySelector('.audience-result') as HTMLElement;
    expect(none.querySelector('.audience-result__eligible--none')).not.toBeNull();
    expect(none.querySelector('.audience-result__sample')).toBeNull();
    // A saved audience not chosen yet names no filter, so no count describes it.
    state.dialogForm = { campaignAudienceSource: 'saved' };
    expect(text(audienceSection(state).querySelector('.audience__preview'))).toContain('changed since the last count');
    state.lang = 'ar';
    state.dialogForm = {};
    state.live.audiencePreview = { key, result: { status: 'ready', value: PREVIEW, loadedAt: 1 } };
    expect(text(audienceSection(state).querySelector('.audience-result__sample'))).toBe('مثل: Mona، Sara');
  });

  it('shows the problems on the fields they belong to', () => {
    const state = editor();
    state.dialogForm = { campaignAudienceSource: 'labels' };
    state.formErrors = { campaignAudience: 'Choose at least one label.', campaignAudienceName: 'Name it.' };
    const block = audienceSection(state);
    expect([...block.querySelectorAll('.field__error')].map((error) => error.textContent)).toEqual(['Choose at least one label.', 'Name it.']);
  });
});
