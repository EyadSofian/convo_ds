/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { Campaign } from '../api/campaigns';
import type { ChannelConnection } from '../api/channels';
import type { WhatsAppTemplateCatalogueItem } from '../api/conversations';
import { createState } from '../state';
import { ready } from '../live/store';
import type { AppState } from '../state';
import { renderDialog } from './dialogs';

const NOW = new Date('2026-09-09T09:30:00.000Z');

function base(): AppState {
  const state = createState(NOW);
  state.lang = 'en';
  state.live.session = { status: 'signed_in', email: 'a@b.c', memberships: [], tenantId: 't' };
  return state;
}

function open(state: AppState, kind: string, arg = ''): HTMLElement {
  state.dialog = { kind, arg };
  return renderDialog(state) as HTMLElement;
}

const CAMPAIGN: Campaign = {
  id: 'c-1', name: 'Autumn intake', objective: 'Enrolment', connection_id: 'cn-1', state: 'ready', version: 3,
  revision_id: 'rev', revision: 1, revision_hash: 'a'.repeat(64), content: { text: 'Hello {{display_name}}' },
  variables: {}, audience_filter: { search: 'student' }, timezone: 'UTC', expires_at: null, budget_amount_minor: '0',
  budget_currency: 'USD', approved: true, audience: null, execution: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
};

function healthy(id = 'cn-1', status: ChannelConnection['status'] = 'healthy'): ChannelConnection {
  return { id, display_name: `Line ${id}`, status } as ChannelConnection;
}

describe('renderDialog', () => {
  it('draws nothing when no dialog is open, and says so for an unknown kind', () => {
    const state = base();
    expect(renderDialog(state)).toBeNull();
    expect(open(state, 'nonsense').textContent).toContain('There is nothing to show here.');
  });
});

describe('WhatsApp template picker', () => {
  it('shows the canonical approved catalogue, live parameter field, localized controls and language direction', () => {
    const state = base();
    const item: WhatsAppTemplateCatalogueItem = {
      id: 'template-1', providerTemplateId: 'meta-1', name: 'welcome', language: 'ar', category: 'utility', status: 'approved',
      components: [{ type: 'header', text: 'أهلًا {{1}}', format: 'TEXT', buttons: [] }, { type: 'body', text: 'مرحبًا {{1}}', format: null, buttons: [] }, { type: 'footer', text: 'مدرسة بيرلتز', format: null, buttons: [] }, { type: 'buttons', text: null, format: null, buttons: [{ type: 'url', text: 'التفاصيل' }] }],
      parameters: [{ key: 'header:1', component: 'header', index: null, position: 1, example: 'Ahmed' }, { key: 'body:1', component: 'body', index: null, position: 1, example: 'Sara' }],
      sendSupported: true, unsupportedReason: null, lastSyncedAt: NOW.toISOString(),
    };
    state.live.conversationTemplates = ready([item], NOW.getTime());
    state.dialogForm = { whatsappTemplateId: item.id, whatsappTemplateParameter_header_1: 'Ahmed', whatsappTemplateParameter_body_1: 'Sara' };
    const picker = open(state, 'whatsapp-template', 'conversation-1');
    expect(picker.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    expect(picker.querySelector('.wa-template-preview')?.getAttribute('dir')).toBe('rtl');
    expect(picker.textContent).toContain('مرحبًا Sara');
    expect(picker.textContent).toContain('welcome');
    expect(picker.querySelector('[data-act="live-whatsapp-template-send"]')?.hasAttribute('disabled')).toBe(false);
  });

  it('marks unsupported media and stale statuses non-sendable, with English content remaining LTR', () => {
    const state = base();
    const media: WhatsAppTemplateCatalogueItem = {
      id: 'template-media', providerTemplateId: 'meta-media', name: 'receipt', language: 'en', category: 'utility', status: 'paused',
      components: [{ type: 'header', text: null, format: 'IMAGE', buttons: [] }, { type: 'body', text: 'Your receipt', format: null, buttons: [] }],
      parameters: [], sendSupported: false, unsupportedReason: 'Media upload is required.', lastSyncedAt: NOW.toISOString(),
    };
    state.live.conversationTemplates = ready([media], NOW.getTime());
    state.dialogForm = { whatsappTemplateId: media.id };
    const picker = open(state, 'whatsapp-template', 'conversation-1');
    expect(picker.querySelector('.wa-template-preview')?.getAttribute('dir')).toBe('ltr');
    expect(picker.textContent).toContain('Media header is not supported yet');
    expect((picker.querySelector('[data-act="live-whatsapp-template-send"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders loading, error, empty, pagination, missing-preview and invalid-variable states', () => {
    const state = base();
    state.live.conversationTemplates = { status: 'loading' };
    expect(open(state, 'whatsapp-template').textContent).toContain('Loading approved templates');
    state.live.conversationTemplates = { status: 'error', error: { code: 'unavailable', message: 'Could not fetch.', status: 503, requestId: null, details: [] } };
    expect(open(state, 'whatsapp-template').textContent).toContain('Could not load the catalogue');
    state.live.conversationTemplates = ready([], 1);
    expect(open(state, 'whatsapp-template').textContent).toContain('No templates are in the local catalogue yet');

    const options: WhatsAppTemplateCatalogueItem[] = [
      { id: 'pending', providerTemplateId: 'meta-pending', name: 'pending', language: 'fr', category: 'marketing', status: 'pending', components: [], parameters: [], sendSupported: false, unsupportedReason: null, lastSyncedAt: NOW.toISOString() },
      { id: 'disabled', providerTemplateId: 'meta-disabled', name: 'no-body', language: 'en', category: 'utility', status: 'disabled', components: [{ type: 'header', text: null, format: null, buttons: [] }], parameters: [{ key: 'button:0:1', component: 'button', index: 0, position: 1, example: null }], sendSupported: false, unsupportedReason: null, lastSyncedAt: NOW.toISOString() },
      { id: 'unknown', providerTemplateId: 'meta-unknown', name: 'unknown-status', language: 'en', category: 'utility', status: 'provider-new-state' as never, components: [{ type: 'body', text: 'Start {{1}}', format: null, buttons: [] }], parameters: [{ key: 'body:1', component: 'body', index: null, position: 1, example: null }], sendSupported: false, unsupportedReason: null, lastSyncedAt: NOW.toISOString() },
    ];
    state.live.conversationTemplates = ready(options, 1);
    state.live.conversationTemplateCursor = '50';
    state.live.busy = 'send-template';
    state.dialogForm = { whatsappTemplateId: 'disabled', whatsappTemplateParameter_button_0_1: '' };
    const picker = open(state, 'whatsapp-template');
    expect(picker.textContent).toContain('Load more');
    expect(picker.textContent).toContain('Template without text');
    expect(picker.textContent).toContain('This template is not supported for sending.');
    expect((picker.querySelector('[data-act="live-whatsapp-template-send"]') as HTMLButtonElement).disabled).toBe(true);
    expect(picker.querySelector('.wa-template-option.is-selected')).not.toBeNull();
    state.dialogForm.whatsappTemplateId = 'unknown';
    state.live.error = { code: 'template_parameters_invalid', message: 'Fill in every value.', requestId: null, status: 422, details: [] };
    expect(open(state, 'whatsapp-template').textContent).toContain('Fill in every value.');
    expect(open(state, 'whatsapp-template').textContent).toContain('provider-new-state');
  });

  it('keeps empty placeholders visible and marks all template components in provider order', () => {
    const state = base();
    const item: WhatsAppTemplateCatalogueItem = {
      id: 'template-order', providerTemplateId: 'meta-order', name: 'ordered', language: 'en', category: 'utility', status: 'approved',
      components: [
        { type: 'header', text: 'For {{1}}', format: 'TEXT', buttons: [] },
        { type: 'body', text: '{{1}}Hello!', format: null, buttons: [] },
        { type: 'footer', text: 'Footer', format: null, buttons: [] },
        { type: 'buttons', text: null, format: null, buttons: [{ type: 'quick_reply', text: 'Okay' }] },
      ],
      parameters: [{ key: 'header:1', component: 'header', index: null, position: 1, example: null }, { key: 'body:1', component: 'body', index: null, position: 1, example: null }],
      sendSupported: true, unsupportedReason: null, lastSyncedAt: NOW.toISOString(),
    };
    state.live.conversationTemplates = ready([item], 1);
    state.live.conversationTemplateCursor = null;
    state.dialogForm = { whatsappTemplateId: item.id, whatsappTemplateParameter_body_1: 'Sara' };
    const picker = open(state, 'whatsapp-template');
    expect(picker.querySelectorAll('.wa-template-preview__variable')).toHaveLength(2);
    expect(picker.querySelector('[data-template-preview-key="header:1"]')?.textContent).toBe('{{1}}');
    expect(picker.textContent).toContain('SaraHello!');
    expect(picker.querySelector('.wa-template-preview__button')?.textContent).toBe('Okay');
  });
});

describe('label safety dialogs', () => {
  it('confirms retirement and gives an inline creation path a HEX preview', () => {
    const state = base();
    state.live.workspaceLabels = ready([{ id: 'label-1', name: 'VIP', color: '#EF4444', state: 'active', version: 1 }], 0);
    const retire = open(state, 'retire-label', 'label-1');
    expect(retire.textContent).toContain('will no longer be available for new assignments');
    expect(retire.querySelector('[data-act="live-workspace-label-retire-confirm"]')?.getAttribute('data-arg')).toBe('label-1');
    const inline = open(state, 'inline-label', 'conversation|conversation-1');
    expect(inline.querySelector('[data-act="live-inline-label-create"]')).not.toBeNull();
    expect(inline.querySelector('input[pattern="^#[0-9A-Fa-f]{6}$"]')).not.toBeNull();
    expect(inline.textContent).toContain('Label preview');
  });

  it('renders create/edit label forms and refuses invalid inline targets', () => {
    const state = base();
    state.live.workspaceLabels = ready([{ id: 'label-1', name: 'VIP', color: '#abcdef', state: 'active', version: 2 }], 0);
    const create = open(state, 'workspace-label');
    expect(create.querySelector('form')?.getAttribute('data-submit')).toBe('live-workspace-label-create');
    expect(create.querySelectorAll('.label-color-choice')).toHaveLength(8);
    state.dialogForm = { labelName: 'VIP 2', labelColor: '#123456' };
    const edit = open(state, 'workspace-label', 'label-1');
    expect(edit.querySelector('form')?.getAttribute('data-submit')).toBe('live-workspace-label-update');
    expect((edit.querySelector('input[pattern]') as HTMLInputElement).value).toBe('#123456');
    expect(open(state, 'inline-label', 'bad').querySelector('.notice--warning')).not.toBeNull();
    state.dialogForm = {};
    const entityFallback = open(state, 'workspace-label', 'label-1');
    expect((entityFallback.querySelector('input[data-form="labelName"]') as HTMLInputElement).value).toBe('VIP');
    expect((entityFallback.querySelector('input[type="color"]') as HTMLInputElement).value).toBe('#ABCDEF');
    const missingLabel = open(state, 'workspace-label', 'gone');
    expect(missingLabel.querySelector('form')?.getAttribute('data-submit')).toBe('live-workspace-label-create');
    state.dialogForm = { labelColor: 'not-a-hex' };
    expect((open(state, 'workspace-label').querySelector('input[type="color"]') as HTMLInputElement).value).toBe('#3B82F6');
  });

  it('renders saved-view visibility and safe automation delete states', () => {
    const state = base();
    state.live.teams = ready([{ id: 'team-1', name: 'Support', member_count: 1, archived: false, members: [] }], 0);
    state.live.savedViews = ready([{ id: 'view-1', ownerMembershipId: 'm-1', name: 'Mine', visibility: 'team', teamId: 'team-1', resource: 'conversations', conditions: { version: 1, root: { kind: 'group', match: 'all', conditions: [] } }, version: 1 }], 0);
    state.live.selectedSavedViewId = 'view-1';
    const update = open(state, 'saved-inbox-view', 'update');
    expect(update.querySelector('[data-submit="live-inbox-saved-view-update"]')).not.toBeNull();
    expect(update.querySelector('[data-form="savedViewTeamId"]')).not.toBeNull();
    const create = open(state, 'saved-inbox-view', 'create');
    expect(create.querySelector('[data-submit="live-inbox-saved-view-create"]')).not.toBeNull();
    state.live.selectedSavedViewId = 'missing';
    state.dialogForm = {};
    const privateDefault = open(state, 'saved-inbox-view', 'create');
    expect((privateDefault.querySelector('[data-form="savedViewVisibility"]') as HTMLSelectElement).value).toBe('private');
    state.live.selectedSavedViewId = 'view-1';
    state.dialogForm = { savedViewVisibility: 'workspace' };
    expect(open(state, 'saved-inbox-view', 'create').querySelector('[data-form="savedViewTeamId"]')).toBeNull();
    state.dialogForm = { savedViewVisibility: 'team' };
    expect(open(state, 'saved-inbox-view', 'create').querySelector('[data-form="savedViewTeamId"]')).not.toBeNull();
    const missingUpdate = open(state, 'saved-inbox-view', 'update');
    state.live.selectedSavedViewId = 'gone';
    expect(renderDialog(state)?.querySelector('[data-act="live-inbox-saved-view-update"]')?.hasAttribute('disabled')).toBe(true);
    state.live.automations = ready([{ id: 'a-1', name: 'Draft', state: 'draft' } as never], 0);
    expect(open(state, 'automation-delete', 'a-1').textContent).toContain('has never run');
    expect(open(state, 'automation-delete', 'gone').querySelector('.notice--warning')).not.toBeNull();
    expect(missingUpdate).not.toBeNull();
    state.live.savedViews = { status: 'idle' };
    expect(open(state, 'saved-inbox-view', 'update').querySelector('[data-act="live-inbox-saved-view-update"]')?.hasAttribute('disabled')).toBe(true);
    state.live.workspaceLabels = ready([{ id: 'label-1', name: 'VIP', color: '#EF4444', state: 'retired', version: 1 }], 1);
    expect(open(state, 'retire-label', 'label-1').querySelector('.notice--warning')).not.toBeNull();
  });
});

describe('changing the password', () => {
  it('asks for the current and confirmed replacement without exposing a value', () => {
    const state = base();
    const dialog = open(state, 'change-password');
    expect(dialog.querySelector('form')?.getAttribute('data-submit')).toBe('live-change-password');
    expect(dialog.querySelectorAll('input[type="password"]')).toHaveLength(3);
    expect(dialog.textContent).toContain('Every other session will be signed out.');
    expect(dialog.querySelector('[data-act="live-change-password"]')).not.toBeNull();

    state.passwordVisible = true;
    const visible = renderDialog(state) as HTMLElement;
    expect(visible.querySelectorAll('input[type="text"]')).toHaveLength(3);
    expect(visible.querySelector('[data-act="password-visibility"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows validation and server errors, and disables the submit while changing', () => {
    const state = base();
    state.dialog = { kind: 'change-password', arg: '' };
    state.formErrors = { newPassword: 'Use at least 12 characters.' };
    state.live.error = { code: 'current_password_invalid', message: 'No', requestId: 'r-pw', status: 400, details: [] };
    state.live.busy = 'change-password';
    const dialog = renderDialog(state) as HTMLElement;
    expect(dialog.querySelector('.field__error')?.textContent).toContain('12 characters');
    expect(dialog.textContent).toContain('r-pw');
    expect((dialog.querySelector('[data-act="live-change-password"]') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('connecting a channel', () => {
  it('asks a Meta channel for the configured app, the asset, a name and the token', () => {
    const state = base();
    const dialog = open(state, 'connect-channel', 'whatsapp');
    expect(dialog.querySelector('.dialog__title')?.textContent).toBe('Connect WhatsApp Business');
    expect(dialog.querySelector('label[for="channel-app"]')?.textContent).toBe('Meta App ID');
    expect(dialog.querySelector('label[for="channel-asset"]')?.textContent).toBe('Phone Number ID');
    expect(dialog.querySelector('#channel-token')?.getAttribute('type')).toBe('password');
    expect(dialog.querySelector('form')?.getAttribute('data-submit')).toBe('live-connect-channel');
    expect(open(state, 'connect-channel', 'messenger').querySelector('label[for="channel-asset"]')?.textContent).toBe('Page ID');
    expect(open(state, 'connect-channel', 'instagram').querySelector('label[for="channel-asset"]')?.textContent).toBe('Instagram Account ID');
  });

  it('asks a first-party channel for a signing key and no Meta app', () => {
    const state = base();
    const dialog = open(state, 'connect-channel', 'web_chat');
    expect(dialog.querySelector('#channel-app')).toBeNull();
    expect(dialog.querySelector('label[for="channel-token"]')?.textContent).toBe('Signing key');
    expect(open(state, 'connect-channel', 'custom').querySelector('label[for="channel-asset"]')?.textContent).toBe('Channel ID');
  });

  it('shows field problems, the server’s refusal and the attempt in flight', () => {
    const state = base();
    state.dialog = { kind: 'connect-channel', arg: 'whatsapp' };
    state.formErrors = { channelProviderApp: 'Enter the Meta App ID.', channelAsset: 'Enter the asset ID.', channelName: 'Enter a display name.', channelToken: 'Enter at least 8 characters.' };
    state.live.error = { code: 'provider_app_not_configured', message: 'That Meta app is not configured.', requestId: 'r-3', status: 422, details: [] };
    state.live.busy = 'connect-channel';
    const dialog = renderDialog(state) as HTMLElement;
    expect(dialog.querySelectorAll('.field__error')).toHaveLength(4);
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('r-3');
    expect((dialog.querySelector('.dialog__footer [data-act="live-connect-channel"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses to offer Telegram or a kind the product does not list', () => {
    const state = base();
    for (const kind of ['telegram', 'pigeon']) {
      const dialog = open(state, 'connect-channel', kind);
      expect(dialog.querySelector('form')).toBeNull();
      expect(dialog.textContent).toContain('not supported in this version');
    }
  });
});

describe('inviting a member', () => {
  it('offers the server’s roles and the errors from the last attempt', () => {
    const state = base();
    state.live.roles = { status: 'ready', loadedAt: 1, value: [{ id: 'r-1', key: 'agent', name: 'Agent', is_builtin: true, description: '', updated_at: '2026-09-01T00:00:00.000Z', grants: [] }] };
    state.formErrors = { inviteEmail: 'Enter a valid email address.', inviteRole: 'Choose a role.' };
    state.live.busy = 'invite';
    const dialog = open(state, 'invite');
    expect(Array.from(dialog.querySelectorAll('#invite-role option')).map((option) => option.textContent)).toEqual(['Choose a role', 'Agent']);
    expect(dialog.querySelectorAll('.field__error')).toHaveLength(2);
    expect((dialog.querySelector('.dialog__footer [data-act="live-invite"]') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('offering ownership', () => {
  it('confirms in plain words before sending the offer', () => {
    const state = base();
    state.live.people = { status: 'ready', loadedAt: 1, value: [{ membership_id: 'm-2', email: 'sara@school.example', status: 'active', role: { id: 'r', key: 'admin', name: 'Admin' }, scopes: [] }] };
    const dialog = open(state, 'ownership-offer', 'm-2');
    expect(dialog.textContent).toContain('sara@school.example');
    expect(dialog.textContent).toContain('they become the Owner');
    expect(dialog.querySelector('[data-act="live-offer-ownership"]')?.getAttribute('data-arg')).toBe('m-2');
    expect(open(state, 'ownership-offer', 'm-gone').textContent).toContain('no longer exists');
  });
});

describe('campaign dialogs', () => {
  it('says so when the campaign has gone, for every campaign dialog', () => {
    const state = base();
    state.live.campaigns = { status: 'ready', loadedAt: 1, value: [] };
    for (const kind of ['campaign-test-send', 'campaign-schedule', 'campaign-edit']) {
      expect(open(state, kind, 'c-gone').textContent).toContain('no longer exists');
    }
  });

  it('creates a draft only against a healthy channel', () => {
    const state = base();
    state.live.connections = { status: 'ready', loadedAt: 1, value: [healthy('cn-1'), healthy('cn-2', 'degraded')] };
    const dialog = open(state, 'campaign');
    expect(dialog.querySelector('.dialog__title')?.textContent).toBe('New campaign');
    expect(Array.from(dialog.querySelectorAll('#campaign-channel option')).map((option) => option.getAttribute('value'))).toEqual(['cn-1']);
    expect((dialog.querySelector('.dialog__footer [data-act="live-campaign-create"]') as HTMLButtonElement).disabled).toBe(false);

    state.live.connections = { status: 'ready', loadedAt: 1, value: [] };
    const blocked = renderDialog(state) as HTMLElement;
    expect(blocked.textContent).toContain('Connect a healthy channel');
    expect((blocked.querySelector('.dialog__footer [data-act="live-campaign-create"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('edits from the saved revision, keeping its own channel even if it is not healthy now', () => {
    const state = base();
    state.live.campaigns = { status: 'ready', loadedAt: 1, value: [CAMPAIGN] };
    state.live.connections = { status: 'ready', loadedAt: 1, value: [healthy('cn-1', 'degraded')] };
    state.formErrors = { campaignName: 'Enter a campaign name.', campaignMessage: 'Write the message.' };
    state.live.busy = 'campaign-update:c-1';
    const dialog = open(state, 'campaign-edit', 'c-1');
    expect(dialog.querySelector('.dialog__title')?.textContent).toBe('Edit campaign');
    expect((dialog.querySelector('#campaign-name') as HTMLInputElement).value).toBe('Autumn intake');
    expect(dialog.querySelector('#campaign-message')?.textContent).toBe('Hello {{display_name}}');
    expect((dialog.querySelector('#campaign-search') as HTMLInputElement).value).toBe('student');
    expect(dialog.querySelector('form')?.getAttribute('data-arg')).toBe('c-1');
    expect((dialog.querySelector('.dialog__footer [data-act="live-campaign-update"]') as HTMLButtonElement).disabled).toBe(true);

    state.formErrors = {};
    state.dialogForm = { campaignName: 'Renamed', campaignMessage: 'New text', campaignObjective: '', campaignSearch: '' };
    const typed = renderDialog(state) as HTMLElement;
    expect((typed.querySelector('#campaign-name') as HTMLInputElement).value).toBe('Renamed');
    expect(typed.querySelector('#campaign-message')?.textContent).toBe('New text');
  });

  it('edits a campaign whose saved content has no text or search', () => {
    const state = base();
    state.live.campaigns = { status: 'ready', loadedAt: 1, value: [{ ...CAMPAIGN, content: { template: 'x' }, audience_filter: {}, objective: null }] };
    state.live.connections = { status: 'ready', loadedAt: 1, value: [healthy()] };
    const dialog = open(state, 'campaign-edit', 'c-1');
    expect(dialog.querySelector('#campaign-message')?.textContent).toBe('');
    expect((dialog.querySelector('#campaign-search') as HTMLInputElement).value).toBe('');
    expect((dialog.querySelector('#campaign-objective') as HTMLInputElement).value).toBe('');
  });

  it('sends a test only to a recipient authorized on the campaign’s own channel', () => {
    const state = base();
    state.live.campaigns = { status: 'ready', loadedAt: 1, value: [CAMPAIGN] };
    state.live.testRecipients = { status: 'loading' };
    expect(open(state, 'campaign-test-send', 'c-1').textContent).toContain('Loading authorized recipients');
    state.live.testRecipients = { status: 'idle' };
    expect(renderDialog(state)?.textContent).toContain('Loading authorized recipients');
    state.live.testRecipients = { status: 'error', error: { code: 'x', message: 'Denied.', requestId: 'r', status: 403, details: [] } };
    expect(renderDialog(state)?.querySelector('[role="alert"]')).not.toBeNull();
    state.live.testRecipients = { status: 'ready', loadedAt: 1, value: [
      { id: 'tr-other', connection_id: 'cn-9', identity_id: 'i', peer_identity: '1', display_name: 'X', label: 'Elsewhere', authorized_at: '' },
    ] };
    const none = renderDialog(state) as HTMLElement;
    expect(none.textContent).toContain('No test recipient is authorized on this channel');
    expect((none.querySelector('[data-act="live-campaign-test-send"]') as HTMLButtonElement).disabled).toBe(true);

    state.live.testRecipients = { status: 'ready', loadedAt: 1, value: [
      { id: 'tr-1', connection_id: 'cn-1', identity_id: 'i', peer_identity: '201000000000', display_name: 'Owner', label: 'Owner phone', authorized_at: '' },
    ] };
    const ready = renderDialog(state) as HTMLElement;
    expect((ready.querySelector('select') as HTMLSelectElement).value).toBe('tr-1');
    expect((ready.querySelector('[data-act="live-campaign-test-send"]') as HTMLButtonElement).disabled).toBe(false);
    state.dialogForm = { campaignTestRecipient: 'tr-1' };
    state.live.error = { code: 'x', message: 'Window closed.', requestId: 'r-5', status: 409, details: [] };
    expect(renderDialog(state)?.textContent).toContain('r-5');
  });

  it('schedules for a time typed in the operator’s own zone', () => {
    const state = base();
    state.live.campaigns = { status: 'ready', loadedAt: 1, value: [CAMPAIGN] };
    state.formErrors = { campaignScheduleAt: 'Choose a time in the future.' };
    state.dialogForm = { campaignScheduleAt: '2026-09-10T09:00' };
    const filled = open(state, 'campaign-schedule', 'c-1');
    expect(filled.querySelector('#campaign-schedule')?.getAttribute('type')).toBe('datetime-local');
    expect((filled.querySelector('#campaign-schedule') as HTMLInputElement).value).toBe('2026-09-10T09:00');
    expect(filled.querySelector('.field__error')?.textContent).toBe('Choose a time in the future.');
    expect(filled.querySelector('[data-act="live-campaign-schedule"]')?.getAttribute('data-arg')).toBe('c-1');
    state.dialogForm = {};
    state.formErrors = {};
    const blank = open(state, 'campaign-schedule', 'c-1');
    expect((blank.querySelector('#campaign-schedule') as HTMLInputElement).value).toBe('');
    expect(blank.querySelector('.field__error')).toBeNull();
  });
});
