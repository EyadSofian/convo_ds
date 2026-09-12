/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import type { ChannelConnection } from '../api/channels.js';
import { createState } from '../state.js';
import { channelTestIdentityField, channelTestLabelField } from '../live/dispatch.js';
import { renderChannels } from './channels-screen.js';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const CONNECTION: ChannelConnection = {
  id: 'channel-1', kind: 'whatsapp', provider: 'meta', display_name: 'Courses', external_asset_id: 'phone-1',
  provider_app_id: 'app-1', status: 'healthy', capabilities: {
    kind: 'whatsapp', version: 'v21.0', host: 'graph.facebook.com', inboundEvents: [], outboundTypes: ['text','template'],
    attachmentTypes: [], textLimit: { characters: 4096, bytes: 4096 }, windowHours: 24,
    businessInitiated: true, templates: true, deliveryReceipts: true, readReceipts: true,
  }, evidence: [], missing_evidence: [], last_error_code: null, last_error_at: null, created_at: NOW.toISOString(),
  disconnected_at: null, credential_held: true, credential_fingerprint: 'f'.repeat(64),
};

describe('Channels test-recipient controls', () => {
  it('shows the explicit allowlist, its input gate and revocation control', () => {
    const state = createState(NOW);
    state.lang = 'en';
    state.live.session = { status: 'signed_in', email: 'owner@test.local', memberships: [], tenantId: 'tenant-1' };
    state.live.connections = { status: 'ready', loadedAt: 1, value: [CONNECTION] };
    state.live.catalogue = { status: 'ready', loadedAt: 1, value: [] };
    state.live.testRecipients = { status: 'ready', loadedAt: 1, value: [{
      id: 'recipient-1', connection_id: 'channel-1', identity_id: 'identity-1', peer_identity: '201000000000',
      display_name: 'Owner', label: 'Owner phone', authorized_at: NOW.toISOString(),
    }] };
    let screen = renderChannels(state);
    expect((screen.querySelector('[data-act="live-authorize-test-recipient"]') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.querySelector('[data-act="live-revoke-test-recipient"][data-arg="channel-1:recipient-1"]')).not.toBeNull();
    expect(screen.textContent).toContain('Owner phone');

    state.dialogForm[channelTestIdentityField('channel-1')] = '201000000001';
    state.dialogForm[channelTestLabelField('channel-1')] = 'Backup';
    screen = renderChannels(state);
    expect((screen.querySelector('[data-act="live-authorize-test-recipient"]') as HTMLButtonElement).disabled).toBe(false);

    state.live.testRecipients = { status: 'ready', loadedAt: 2, value: [] };
    expect(renderChannels(state).textContent).toContain('No test recipient is currently authorized');
    state.live.busy = 'authorize-test-recipient:channel-1';
    expect((renderChannels(state).querySelector('[data-act="live-authorize-test-recipient"]') as HTMLButtonElement).disabled).toBe(true);
  });
});
