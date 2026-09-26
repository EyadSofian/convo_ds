/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import type { AutomationsApi } from '../api/automations.js';
import type { AudiencePreview, Campaign, CampaignsApi } from '../api/campaigns.js';
import type { ApiError, ApiResult } from '../api/client.js';
import type { ContactsApi } from '../api/contacts.js';
import type { MetadataApi } from '../api/metadata.js';
import type { SavedAudience, SavedViewsApi } from '../api/saved-views.js';
import { createState } from '../state.js';
import { renderDialog } from '../ui/dialogs.js';
import type { LiveContext } from './actions.js';
import { chooseAudienceSource, loadAudiences, openAudienceDialog, openCampaignEditor, previewCampaignAudience, retireAudience, saveCampaignAudience, showCampaignView } from './audience-actions.js';
import { conditionsFromFilter } from './audience.js';
import { LIVE_ACTIONS } from './dispatch.js';

const NOW = new Date('2026-09-26T09:00:00.000Z');
const LABEL = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const ERROR: ApiError = { code: 'refused', message: 'Server refused', requestId: 'req-1', status: 409, details: [] };
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = <T>(): ApiResult<T> => ({ ok: false, error: ERROR });
const PREVIEW: AudiencePreview = { total: 3, eligible: 2, excluded: 1, reasons: { suppressed: 0, no_consent: 1, identity_inactive: 0 }, sample: ['Mona', 'Sara'] };
const SAVED: SavedAudience = { id: 'aud-1', name: 'Interested', description: null, conditions: conditionsFromFilter({ labelIds: [LABEL] }) as never, state: 'active', version: 1 };

function setup(options: { tenant?: string | null; lang?: 'ar' | 'en' } = {}) {
  const state = createState(NOW);
  state.lang = options.lang ?? 'en';
  state.live.session = { status: 'signed_in', email: 'owner@example.com', memberships: [], tenantId: options.tenant === undefined ? 'tenant-1' : options.tenant };
  state.live.connections = { status: 'ready', loadedAt: 1, value: [{ id: 'channel-1', kind: 'whatsapp', status: 'healthy', display_name: 'WhatsApp', disconnected_at: null }] as never };
  const campaigns = { previewAudience: vi.fn().mockResolvedValue(ok(PREVIEW)), list: vi.fn().mockResolvedValue(ok([])) } as unknown as CampaignsApi;
  const views = {
    audiences: vi.fn().mockResolvedValue(ok([SAVED])),
    createAudience: vi.fn().mockResolvedValue(ok({ ...SAVED, id: 'aud-2', name: 'Picked' })),
  } as unknown as SavedViewsApi;
  const metadata = { labels: vi.fn().mockResolvedValue(ok([{ id: LABEL, name: 'VIP', color: '#2563eb', state: 'active', version: 1 }])), fields: vi.fn().mockResolvedValue(ok([])) } as unknown as MetadataApi;
  const contacts = { list: vi.fn().mockResolvedValue(ok([{ id: CONTACT, displayName: 'Mona', identities: [], labels: [], customFields: [], attributes: {}, version: 1, createdAt: NOW.toISOString() }])) } as unknown as ContactsApi;
  Object.defineProperty(state.live, 'campaignsApi', { value: campaigns });
  Object.defineProperty(state.live, 'savedViewsApi', { value: views });
  Object.defineProperty(state.live, 'metadataApi', { value: metadata });
  Object.defineProperty(state.live, 'contactsApi', { value: contacts });
  const automations = { whatsappTemplates: vi.fn().mockResolvedValue(ok([])) } as unknown as AutomationsApi;
  Object.defineProperty(state.live, 'automationsApi', { value: automations });
  const context: LiveContext = {
    state, live: state.live, refresh: vi.fn(), now: () => NOW.getTime(), newKey: () => 'key-1', endSession: vi.fn(), switchWorkspace: vi.fn(),
  };
  return { state, context, campaigns, views, metadata, contacts, automations };
}

describe('the campaign editor’s audience', () => {
  it('opens a fresh editor and fetches labels and saved audiences once', async () => {
    const { state, context, views, metadata, contacts } = setup();
    state.live.audiencePreview = { key: 'old', result: { status: 'ready', value: PREVIEW, loadedAt: 1 } };
    expect(await openCampaignEditor(context, '')).toBe(true);
    expect(state.dialog).toEqual({ kind: 'campaign', arg: '' });
    expect(state.live.audiencePreview).toBeNull();
    expect(views.audiences).toHaveBeenCalledTimes(1);
    expect(metadata.labels).toHaveBeenCalledTimes(1);
    expect(contacts.list).not.toHaveBeenCalled();
    await loadAudiences(context);
    expect(views.audiences).toHaveBeenCalledTimes(1);
  });

  it('opens an existing draft on its own source, fetching the directory for a hand-picked list', async () => {
    const { state, context, contacts } = setup();
    state.live.campaigns = { status: 'ready', loadedAt: 1, value: [{ id: 'c-1', audience_filter: { contactIds: [CONTACT] } } as unknown as Campaign] };
    expect(await openCampaignEditor(context, 'c-1')).toBe(true);
    expect(state.dialog).toEqual({ kind: 'campaign-edit', arg: 'c-1' });
    expect(contacts.list).toHaveBeenCalledTimes(1);
    // An id that is no longer listed still opens the editor, which reports it missing.
    expect(await openCampaignEditor(context, 'gone')).toBe(true);
    expect(state.dialog).toEqual({ kind: 'campaign-edit', arg: 'gone' });
  });

  it('switches the source and refuses one it does not know', async () => {
    const { state, context, contacts } = setup();
    state.formErrors = { campaignAudience: 'old' };
    expect(await chooseAudienceSource(context, 'picked')).toBe(true);
    expect(state.dialogForm['campaignAudienceSource']).toBe('picked');
    expect(state.formErrors).toEqual({});
    expect(contacts.list).toHaveBeenCalledTimes(1);
    expect(await chooseAudienceSource(context, 'everyone')).toBe(false);
    expect(await LIVE_ACTIONS['live-campaign-audience-source']?.(context, 'labels')).toBe(true);
  });

  it('counts the audience on screen, and says why it cannot', async () => {
    const { state, context, campaigns } = setup();
    state.dialog = { kind: 'campaign', arg: '' };
    state.dialogForm = { campaignAudienceSource: 'labels' };
    expect(await previewCampaignAudience(context)).toBe(false);
    expect(state.formErrors['campaignAudience']).toBe('Choose at least one label.');
    for (const [source, message] of [['conversations', 'conversation label'], ['picked', 'Pick at least one'], ['saved', 'saved audience']] as const) {
      state.dialogForm = { campaignAudienceSource: source };
      expect(await previewCampaignAudience(context)).toBe(false);
      expect(state.formErrors['campaignAudience']).toContain(message);
    }
    state.dialogForm = {};
    state.live.connections = { status: 'idle' };
    expect(await previewCampaignAudience(context)).toBe(false);
    expect(state.formErrors['campaignAudience']).toBe('Choose a channel first.');
    expect(campaigns.previewAudience).not.toHaveBeenCalled();

    state.dialogForm = { campaignConnection: 'channel-1', campaignAudienceSource: 'labels', campaignLabelIds: LABEL, campaignSearch: ' Mo ' };
    expect(await previewCampaignAudience(context)).toBe(true);
    expect(campaigns.previewAudience).toHaveBeenCalledWith('tenant-1', 'channel-1', { search: 'Mo', labelIds: [LABEL] });
    expect(state.live.audiencePreview).toMatchObject({ key: `channel-1|${JSON.stringify({ search: 'Mo', labelIds: [LABEL] })}`, result: { status: 'ready' } });

    vi.mocked(campaigns.previewAudience).mockResolvedValueOnce(fail());
    expect(await LIVE_ACTIONS['live-campaign-audience-preview']?.(context, '')).toBe(false);
    expect(state.live.audiencePreview?.result.status).toBe('error');
  });

  it('says what is missing in Arabic too, and does nothing without a company', async () => {
    const arabic = setup({ lang: 'ar' });
    arabic.state.dialogForm = { campaignAudienceSource: 'picked' };
    await previewCampaignAudience(arabic.context);
    expect(arabic.state.formErrors['campaignAudience']).toBe('اختر جهة اتصال واحدة على الأقل.');
    arabic.state.dialogForm = {};
    arabic.state.live.connections = { status: 'idle' };
    await previewCampaignAudience(arabic.context);
    expect(arabic.state.formErrors['campaignAudience']).toBe('اختر قناة أولًا.');

    const nobody = setup({ tenant: null });
    nobody.state.dialogForm = { campaignConnection: 'channel-1' };
    expect(await previewCampaignAudience(nobody.context)).toBe(false);
    nobody.state.dialogForm = { campaignAudienceName: 'X', campaignAudienceSource: 'labels', campaignLabelIds: LABEL };
    expect(await saveCampaignAudience(nobody.context)).toBe(false);
    await loadAudiences(nobody.context);
    expect(nobody.views.audiences).not.toHaveBeenCalled();
  });

  it('saves the audience on screen and selects it', async () => {
    const { state, context, views } = setup();
    state.dialogForm = { campaignAudienceSource: 'labels', campaignLabelIds: LABEL };
    expect(await saveCampaignAudience(context)).toBe(false);
    expect(state.formErrors['campaignAudienceName']).toBe('Name the audience before saving it.');
    state.dialogForm = { campaignAudienceName: 'Everyone' };
    expect(await saveCampaignAudience(context)).toBe(false);
    expect(state.formErrors['campaignAudienceName']).toContain('Narrow the audience first');
    state.dialogForm = { campaignAudienceName: 'Empty labels', campaignAudienceSource: 'labels' };
    expect(await saveCampaignAudience(context)).toBe(false);
    state.dialogForm = { campaignAudienceName: 'Nothing chosen', campaignAudienceSource: 'saved' };
    expect(await saveCampaignAudience(context)).toBe(false);

    // Saved before the list was ever read: the list becomes just this one.
    state.dialogForm = { campaignAudienceName: ' Picked ', campaignAudienceSource: 'labels', campaignLabelIds: LABEL };
    expect(await LIVE_ACTIONS['live-campaign-audience-save']?.(context, '')).toBe(true);
    expect(views.createAudience).toHaveBeenCalledWith('tenant-1', { name: 'Picked', description: null, conditions: conditionsFromFilter({ labelIds: [LABEL] }) });
    expect(state.live.audiences).toMatchObject({ status: 'ready', value: [{ id: 'aud-2' }] });
    expect(state.dialogForm).toMatchObject({ campaignAudienceSource: 'saved', campaignSavedAudience: 'aud-2', campaignAudienceName: '' });
    expect(state.toasts.at(-1)?.text).toBe('Audience “Picked” saved.');

    // Saved onto a list already read: appended.
    state.dialogForm = { campaignAudienceName: 'Again', campaignAudienceSource: 'labels', campaignLabelIds: LABEL };
    expect(await saveCampaignAudience(context)).toBe(true);
    expect(state.live.audiences).toMatchObject({ value: [{ id: 'aud-2' }, { id: 'aud-2' }] });

    vi.mocked(views.createAudience).mockResolvedValueOnce(fail());
    state.dialogForm = { campaignAudienceName: 'Taken', campaignAudienceSource: 'labels', campaignLabelIds: LABEL };
    expect(await saveCampaignAudience(context)).toBe(false);
    expect(state.formErrors['campaignAudienceName']).toBe('Server refused');

    const arabic = setup({ lang: 'ar' });
    arabic.state.dialogForm = {};
    await saveCampaignAudience(arabic.context);
    expect(arabic.state.formErrors['campaignAudienceName']).toBe('سمِّ الجمهور قبل حفظه.');
    arabic.state.dialogForm = { campaignAudienceName: 'الكل' };
    await saveCampaignAudience(arabic.context);
    expect(arabic.state.formErrors['campaignAudienceName']).toContain('ضيّق الجمهور');
    arabic.state.dialogForm = { campaignAudienceName: 'م', campaignAudienceSource: 'labels', campaignLabelIds: LABEL };
    await saveCampaignAudience(arabic.context);
    expect(arabic.state.toasts.at(-1)?.text).toBe('حُفظ الجمهور «م».');
  });

  it('searches the directory for the hand-picked list through the server', async () => {
    const { state, context, contacts } = setup();
    state.dialogForm = { campaignContactQuery: ' Mona ' };
    await LIVE_ACTIONS['live-campaign-contact-search']?.(context, '');
    expect(state.live.contactQuery).toBe('Mona');
    expect(contacts.list).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ query: 'Mona' }));
    expect(await LIVE_ACTIONS['live-campaign-editor']?.(context, '')).toBe(true);
    expect(renderDialog(state)).not.toBeNull();
  });
});

describe('the broadcast editor’s catalogues', () => {
  it('fetches the approved templates once, and reports a refusal', async () => {
    const { state, context, automations } = setup();
    await openCampaignEditor(context, '');
    expect(automations.whatsappTemplates).toHaveBeenCalledWith('tenant-1');
    expect(state.live.whatsappTemplates).toMatchObject({ status: 'ready', value: [] });
    await openCampaignEditor(context, '');
    expect(automations.whatsappTemplates).toHaveBeenCalledTimes(1);
    const refused = setup();
    vi.mocked(refused.automations.whatsappTemplates).mockResolvedValueOnce(fail());
    await openCampaignEditor(refused.context, '');
    expect(refused.state.live.whatsappTemplates).toEqual({ status: 'error', error: ERROR });
  });
});

describe('saved audiences on their own', () => {
  it('opens a new audience on labels, with the catalogues it picks from', async () => {
    const { state, context, views } = setup();
    state.live.audiencePreview = { key: 'old', result: { status: 'ready', value: PREVIEW, loadedAt: 1 } };
    expect(await openAudienceDialog(context)).toBe(true);
    expect(state.dialog).toEqual({ kind: 'audience-new', arg: '' });
    expect(state.dialogForm).toEqual({ campaignAudienceSource: 'labels' });
    expect(state.live.audiencePreview).toBeNull();
    expect(views.audiences).toHaveBeenCalledTimes(1);
    expect(await LIVE_ACTIONS['live-audience-new']?.(context, '')).toBe(true);
    // Saved on its own, the dialog closes: there is nothing more to do in it.
    state.dialogForm = { campaignAudienceSource: 'labels', campaignLabelIds: LABEL, campaignAudienceName: 'VIPs' };
    expect(await saveCampaignAudience(context)).toBe(true);
    expect(state.dialog).toBeNull();
    expect(state.dialogForm).toEqual({});
  });

  it('switches the campaign list between buckets and the audiences', async () => {
    const { state, context, views } = setup();
    expect(await showCampaignView(context, 'sideways')).toBe(false);
    expect(await LIVE_ACTIONS['live-campaign-view']?.(context, 'scheduled')).toBe(true);
    expect(state.live.campaignView).toBe('scheduled');
    expect(views.audiences).not.toHaveBeenCalled();
    expect(await showCampaignView(context, 'audiences')).toBe(true);
    expect(views.audiences).toHaveBeenCalledTimes(1);
  });

  it('retires an audience, and keeps it when the server refuses', async () => {
    const { state, context, views } = setup();
    Object.assign(views, { retireAudience: vi.fn().mockResolvedValueOnce(fail()).mockResolvedValueOnce(ok(undefined)) });
    state.live.audiences = { status: 'ready', loadedAt: 1, value: [SAVED] };
    expect(await retireAudience(context, 'missing')).toBe(false);
    expect(await LIVE_ACTIONS['live-audience-retire']?.(context, 'aud-1')).toBe(false);
    expect(state.toasts.at(-1)).toMatchObject({ text: 'Server refused', tone: 'danger' });
    expect(state.live.audiences).toMatchObject({ value: [SAVED] });
    expect(await retireAudience(context, 'aud-1')).toBe(true);
    expect(views.retireAudience).toHaveBeenLastCalledWith('tenant-1', 'aud-1', 1);
    expect(state.live.audiences).toMatchObject({ value: [] });
    expect(state.toasts.at(-1)?.text).toBe('Audience “Interested” removed.');
    expect(state.live.busy).toBeNull();
    const arabic = setup({ lang: 'ar' });
    Object.assign(arabic.views, { retireAudience: vi.fn().mockResolvedValue(ok(undefined)) });
    arabic.state.live.audiences = { status: 'ready', loadedAt: 1, value: [SAVED] };
    await retireAudience(arabic.context, 'aud-1');
    expect(arabic.state.toasts.at(-1)?.text).toBe('أُزيل الجمهور «Interested».');
  });
});
