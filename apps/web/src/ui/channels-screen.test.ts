/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { CapabilityMatrix, ChannelCatalogueEntry, ChannelConnection } from '../api/channels';
import { createState } from '../state';
import type { AppState } from '../state';
import { CATALOGUE, catalogueItem, renderChannels, summarize } from './channels-screen';

/**
 * The integration catalogue. The claims under test are the truthful ones: a
 * card says "Connected" only for a healthy connection the server returned,
 * Telegram is never connectable, and capabilities come from the server's matrix.
 */

const NOW = new Date('2026-09-09T09:30:00.000Z');

function matrix(kind: string, overrides: Partial<CapabilityMatrix> = {}): CapabilityMatrix {
  return {
    kind: kind as CapabilityMatrix['kind'], version: 'v21.0', host: 'graph.facebook.com',
    inboundEvents: ['messages'], outboundTypes: ['text', 'template'], attachmentTypes: ['image'],
    textLimit: { characters: 4096, bytes: 4096 }, windowHours: 24, businessInitiated: true,
    templates: true, deliveryReceipts: true, readReceipts: true, ...overrides,
  };
}

function connection(overrides: Partial<ChannelConnection> = {}): ChannelConnection {
  return {
    id: 'cn-1', kind: 'whatsapp', provider: 'meta', display_name: 'Admissions', external_asset_id: '109876543210',
    provider_app_id: '123456789012345', status: 'healthy', capabilities: matrix('whatsapp'),
    evidence: [
      { kind: 'asset_verified', satisfied: true, observed_at: '2026-09-09T08:00:00.000Z' },
      { kind: 'credential_verified', satisfied: true, observed_at: '2026-09-09T08:30:00.000Z' },
      { kind: 'first_inbound', satisfied: false, observed_at: null },
    ],
    missing_evidence: ['first_inbound'], last_error_code: null, last_error_at: null,
    created_at: '2026-09-01T08:00:00.000Z', disconnected_at: null, credential_held: true,
    credential_fingerprint: 'f'.repeat(64), ...overrides,
  };
}

function catalogue(): readonly ChannelCatalogueEntry[] {
  return [
    { kind: 'whatsapp', provider: 'meta', implemented: true, capabilities: matrix('whatsapp') },
    { kind: 'messenger', provider: 'meta', implemented: true, capabilities: matrix('messenger', { templates: false, attachmentTypes: [], deliveryReceipts: false, readReceipts: false, inboundEvents: [] }) },
    { kind: 'instagram', provider: 'meta', implemented: true, capabilities: matrix('instagram') },
    { kind: 'web_chat', provider: 'web_chat', implemented: false, capabilities: matrix('web_chat') },
  ];
}

function screen(connections: readonly ChannelConnection[], lang: 'ar' | 'en' = 'en'): { state: AppState; element: () => HTMLElement } {
  const state = createState(NOW);
  state.lang = lang;
  state.live.session = { status: 'signed_in', email: 'a@b.c', memberships: [], tenantId: 't' };
  state.live.catalogue = { status: 'ready', loadedAt: 1, value: catalogue() };
  state.live.connections = { status: 'ready', loadedAt: 1, value: connections };
  state.live.testRecipients = { status: 'ready', loadedAt: 1, value: [] };
  return { state, element: () => renderChannels(state) };
}

function card(root: HTMLElement, kind: string): HTMLElement {
  return root.querySelector(`[data-channel-kind="${kind}"]`) as HTMLElement;
}

describe('summarize', () => {
  it('says what the server says about a kind, and nothing more', () => {
    const healthy = connection();
    const pending = connection({ id: 'cn-2', status: 'authorization_needed' });
    const gone = connection({ id: 'cn-3', disconnected_at: NOW.toISOString(), status: 'disconnected' });
    expect(summarize('whatsapp', false, [healthy]).status).toBe('unavailable');
    expect(summarize('whatsapp', true, [healthy]).status).toBe('connected');
    // A configuration still gathering evidence is connecting, not failed.
    expect(summarize('whatsapp', true, [healthy, pending]).status).toBe('connecting');
    expect(summarize('whatsapp', true, [gone]).status).toBe('disconnected');
    expect(summarize('whatsapp', true, []).status).toBe('not_connected');
    expect(summarize('whatsapp', true, [healthy]).lastVerified).toBe('2026-09-09T08:30:00.000Z');
    expect(summarize('instagram', true, [healthy]).lastVerified).toBeNull();
    expect(summarize('whatsapp', true, [connection({ last_error_code: 'credential_rejected', status: 'degraded' })]).status).toBe('permission_expired');
    expect(summarize('whatsapp', true, [healthy]).assetNames).toEqual(['Admissions']);
  });

  it('lists the six integrations the product offers', () => {
    expect(CATALOGUE.map((item) => item.kind)).toEqual(['whatsapp', 'messenger', 'instagram', 'web_chat', 'telegram', 'custom']);
    expect(catalogueItem('telegram')?.meta).toBe(false);
    expect(catalogueItem('pigeon')).toBeUndefined();
  });
});

describe('the catalogue', () => {
  it('shows Telegram as coming soon, with no way to connect it', () => {
    const root = screen([]).element();
    const telegram = card(root, 'telegram');
    expect(telegram.className).toContain('integration--unavailable');
    expect(telegram.textContent).toContain('Coming soon');
    expect(telegram.querySelector('[data-arg^="connect-channel"]')).toBeNull();
    expect((telegram.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    // A kind the server does not implement is the same story.
    expect(card(root, 'web_chat').textContent).toContain('Not supported in this version yet.');
  });

  it('offers Connect for a kind with no connection, and only the capabilities the server lists', () => {
    const root = screen([]).element();
    const whatsapp = card(root, 'whatsapp');
    expect(whatsapp.querySelector('[data-act="dialog"]')?.getAttribute('data-arg')).toBe('connect-channel:whatsapp');
    expect(whatsapp.textContent).toContain('Not connected');
    const capabilities = Array.from(whatsapp.querySelectorAll('.capability')).map((item) => item.textContent);
    expect(capabilities).toEqual(['Messages', 'Templates', 'Media', 'Receipts', 'Webhooks']);
    expect(card(root, 'messenger').querySelectorAll('.capability')).toHaveLength(1);
  });

  it('offers Manage and Add for a connected kind, with its count and last verification', () => {
    const root = screen([connection()]).element();
    const whatsapp = card(root, 'whatsapp');
    expect(whatsapp.textContent).toContain('Connected');
    expect(whatsapp.querySelector('[data-act="channel-manage"]')?.getAttribute('data-arg')).toBe('whatsapp:');
    expect(whatsapp.querySelector('[data-arg="connect-channel:whatsapp"]')).not.toBeNull();
    expect(whatsapp.querySelector('.integration__facts')?.textContent).toContain('1');
    expect(whatsapp.querySelector('.integration__facts')?.textContent).toContain('1h');
  });

  it('asks to complete setup on the connection that needs it', () => {
    const root = screen([connection(), connection({ id: 'cn-2', status: 'webhook_pending' })]).element();
    const whatsapp = card(root, 'whatsapp');
    expect(whatsapp.className).toContain('integration--connecting');
    expect(whatsapp.querySelector('[data-act="channel-manage"]')?.getAttribute('data-arg')).toBe('whatsapp:cn-2');
  });

  it('shows a disconnected kind as disconnected, offering to connect again', () => {
    const root = screen([connection({ disconnected_at: NOW.toISOString() })]).element();
    expect(card(root, 'whatsapp').textContent).toContain('Disconnected');
    expect(card(root, 'whatsapp').querySelector('[data-arg="connect-channel:whatsapp"]')).not.toBeNull();
  });

  it('speaks Arabic by default', () => {
    const root = screen([], 'ar').element();
    expect(card(root, 'telegram').textContent).toContain('غير متاح حاليًا');
    expect(root.textContent).toContain('التكاملات المتاحة');
  });
});

describe('before and instead of an answer', () => {
  it('draws placeholders while either list loads', () => {
    const { state, element } = screen([]);
    state.live.connections = { status: 'loading' };
    expect(element().querySelectorAll('.integration--loading')).toHaveLength(6);
    state.live.connections = { status: 'idle' };
    expect(element().querySelectorAll('.integration--loading')).toHaveLength(6);
    state.live.connections = { status: 'ready', loadedAt: 1, value: [] };
    state.live.catalogue = { status: 'loading' };
    expect(element().querySelectorAll('.integration--loading')).toHaveLength(6);
  });

  it('refuses to guess the catalogue when either list failed', () => {
    const { state, element } = screen([]);
    state.live.catalogue = { status: 'error', error: { code: 'permission_denied', message: 'No', requestId: 'r-1', status: 403, details: [] } };
    expect(element().querySelector('.integration')).toBeNull();
    expect(element().textContent).toContain('You don’t have permission');
    state.live.catalogue = { status: 'ready', loadedAt: 1, value: catalogue() };
    state.live.connections = { status: 'error', error: { code: 'network', message: 'down', requestId: null, status: null, details: [] } };
    expect(element().textContent).toContain('Can’t reach the server');
    expect(element().querySelector('[data-act="live-channels-reload"]')).not.toBeNull();
  });
});

describe('connected integrations', () => {
  it('leads an empty workspace to a real connection', () => {
    const root = screen([]).element();
    expect(root.querySelector('.connections')?.textContent).toContain('No channels connected yet');
    expect(root.querySelector('.connections [data-arg="connect-channel:whatsapp"]')).not.toBeNull();
  });

  it('lists each connection with its status and checks, narrowed by kind when asked', () => {
    const { state, element } = screen([connection(), connection({ id: 'cn-ig', kind: 'instagram', status: 'authorization_needed', display_name: 'Instagram' })]);
    const all = element();
    expect(all.querySelectorAll('[data-connection]')).toHaveLength(2);
    expect(all.querySelector('[data-connection="cn-1"]')?.textContent).toContain('2 of 3 checks');
    expect(all.querySelector('.connections .segmented')).not.toBeNull();
    state.channelKind = 'instagram';
    const narrowed = element();
    expect(narrowed.querySelectorAll('[data-connection]')).toHaveLength(1);
    expect(narrowed.querySelector('[data-connection]')?.textContent).toContain('Verification needed');
  });

  it('opens a connection’s checks, credential and test recipients', () => {
    const { state, element } = screen([connection({ last_error_code: 'provider_not_connected' })]);
    state.expandedConnection = 'cn-1';
    state.dialogForm = { channelToken_cn_1: '' };
    state.live.testRecipients = { status: 'ready', loadedAt: 1, value: [
      { id: 'tr-1', connection_id: 'cn-1', identity_id: 'i', peer_identity: '201000000000', display_name: 'Owner', label: 'Owner phone', authorized_at: NOW.toISOString() },
      { id: 'tr-2', connection_id: 'cn-other', identity_id: 'i', peer_identity: '1', display_name: 'X', label: 'Other', authorized_at: NOW.toISOString() },
    ] };
    const root = element();
    const details = root.querySelector('.connection__details') as HTMLElement;
    expect(details.querySelectorAll('.checklist__item--done')).toHaveLength(2);
    expect(details.textContent).toContain('Pending');
    expect(details.textContent).toContain('provider_not_connected');
    expect(details.textContent).toContain('Meta app');
    expect(details.querySelector('[data-act="live-test-channel"]')).not.toBeNull();
    expect((details.querySelector('[data-act="live-rotate-channel"]') as HTMLButtonElement).disabled).toBe(true);
    expect(details.querySelectorAll('.recipient')).toHaveLength(1);
    expect((details.querySelector('[data-act="live-authorize-test-recipient"]') as HTMLButtonElement).disabled).toBe(true);
    // The credential goes out as a password and is never shown back.
    expect(details.querySelector('input[type="password"]')?.getAttribute('autocomplete')).toBe('off');
  });

  it('enables the credential and recipient controls once they have something to send', () => {
    const { state, element } = screen([connection({ provider_app_id: null, capabilities: matrix('web_chat', { windowHours: null }), kind: 'web_chat', credential_held: false })]);
    state.expandedConnection = 'cn-1';
    state.dialogForm = { 'channelToken_cn-1': 'new-token', 'channelTestIdentity_cn-1': '2010', 'channelTestLabel_cn-1': 'Me' };
    const details = element().querySelector('.connection__details') as HTMLElement;
    expect((details.querySelector('[data-act="live-rotate-channel"]') as HTMLButtonElement).disabled).toBe(false);
    expect((details.querySelector('[data-act="live-authorize-test-recipient"]') as HTMLButtonElement).disabled).toBe(false);
    expect(details.textContent).not.toContain('Meta app');
    expect(details.textContent).toContain('None');
    expect(details.textContent).toContain('Not stored');
    expect(details.querySelector('.recipient-list')).toBeNull();
  });

  it('keeps a disconnected connection’s history without offering to manage it', () => {
    const { state, element } = screen([connection({ disconnected_at: NOW.toISOString(), status: 'disconnected' })]);
    state.expandedConnection = 'cn-1';
    const details = element().querySelector('.connection__details') as HTMLElement;
    expect(details.textContent).toContain('This connection is disconnected');
    expect(details.querySelector('[data-act="live-disconnect-channel"]')).toBeNull();
  });

  it('shows the last refusal beside the list, unless a dialog is showing it', () => {
    const { state, element } = screen([connection()]);
    state.live.error = { code: 'provider_not_connected', message: 'Not connected.', requestId: 'r-2', status: 409, details: [] };
    expect(element().querySelector('.connections [role="alert"]')?.textContent).toContain('r-2');
    state.dialog = { kind: 'connect-channel', arg: 'whatsapp' };
    expect(element().querySelector('.connections [role="alert"]')).toBeNull();
  });

  it('marks a connection of a status this build has no tone for as neutral', () => {
    const { element } = screen([connection({ status: 'quarantined' as ChannelConnection['status'] })]);
    expect(element().querySelector('[data-connection] .badge')?.className).toContain('badge--neutral');
  });
});
