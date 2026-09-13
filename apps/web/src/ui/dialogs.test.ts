/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { Campaign } from '../api/campaigns';
import type { ChannelConnection } from '../api/channels';
import { createState } from '../state';
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
    state.live.roles = { status: 'ready', loadedAt: 1, value: [{ id: 'r-1', key: 'agent', name: 'Agent', is_builtin: true, grants: [] }] };
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
