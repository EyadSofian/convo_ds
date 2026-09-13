import { describe, expect, it, vi } from 'vitest';
import { ChannelsApi, type ChannelConnection, type ChannelTestRecipient } from '../api/channels.js';
import { ApiClient, type ApiError, type ApiResult, type FetchLike } from '../api/client.js';
import { createState } from '../state.js';
import { authorizeTestRecipient, loadChannelsScreen, revokeTestRecipient, type LiveContext } from './actions.js';
import { channelTestIdentityField, channelTestLabelField, LIVE_ACTIONS } from './dispatch.js';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const ERROR: ApiError = { code: 'refused', message: 'Server refused', requestId: 'req-1', status: 409, details: [] };
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = <T>(): ApiResult<T> => ({ ok: false, error: ERROR });
const CONNECTION: ChannelConnection = {
  id: 'channel-1', kind: 'whatsapp', provider: 'meta', display_name: 'Courses', external_asset_id: 'phone-1',
  provider_app_id: 'app-1', status: 'healthy', capabilities: {
    kind: 'whatsapp', version: 'v21.0', host: 'graph.facebook.com', inboundEvents: [], outboundTypes: ['text','template'],
    attachmentTypes: [], textLimit: { characters: 4096, bytes: 4096 }, windowHours: 24,
    businessInitiated: true, templates: true, deliveryReceipts: true, readReceipts: true,
  }, evidence: [], missing_evidence: [], last_error_code: null, last_error_at: null, created_at: NOW.toISOString(),
  disconnected_at: null, credential_held: true, credential_fingerprint: 'f'.repeat(64),
};
const RECIPIENT: ChannelTestRecipient = {
  id: 'recipient-1', connection_id: 'channel-1', identity_id: 'identity-1', peer_identity: '201000000000',
  display_name: 'Owner', label: 'Owner phone', authorized_at: NOW.toISOString(),
};

function setup() {
  const state = createState(NOW);
  state.lang = 'en';
  state.live.session = { status: 'signed_in', email: 'owner@test.local', memberships: [], tenantId: 'tenant-1' };
  const channels = {
    connections: vi.fn().mockResolvedValue(ok([CONNECTION])),
    catalogue: vi.fn().mockResolvedValue(ok([])),
    testRecipients: vi.fn().mockResolvedValue(ok([RECIPIENT])),
    authorizeTestRecipient: vi.fn().mockResolvedValue(ok(RECIPIENT)),
    revokeTestRecipient: vi.fn().mockResolvedValue(ok(undefined)),
  } as unknown as ChannelsApi;
  Object.defineProperty(state.live, 'channels', { value: channels });
  const context: LiveContext = { state, live: state.live, refresh: vi.fn(), now: () => NOW.getTime(), newKey: () => 'key', endSession: vi.fn(), switchWorkspace: vi.fn() };
  return { state, context, channels };
}

describe('channel test recipients', () => {
  it('maps allowlist intents to the documented channel routes', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const fetch: FetchLike = (path, init) => {
      calls.push({ path, init });
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    };
    const api = new ChannelsApi(new ApiClient({ baseUrl: '/api/v1', fetch, readCsrfToken: () => 'csrf' }));
    await api.testRecipients('tenant-1', 'channel-1');
    await api.authorizeTestRecipient('tenant-1', 'channel-1', '201000000000', 'Owner phone');
    await api.revokeTestRecipient('tenant-1', 'channel-1', 'recipient-1');
    expect(calls.map(({ path, init }) => [init.method, path])).toEqual([
      ['GET', '/api/v1/tenants/tenant-1/channels/channel-1/test-recipients'],
      ['POST', '/api/v1/tenants/tenant-1/channels/channel-1/test-recipients'],
      ['DELETE', '/api/v1/tenants/tenant-1/channels/channel-1/test-recipients/recipient-1'],
    ]);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ peerIdentity: '201000000000', label: 'Owner phone' });
  });

  it('loads the allowlist for every connection and preserves each refusal', async () => {
    const ready = setup();
    await loadChannelsScreen(ready.context);
    expect(ready.state.live.testRecipients).toMatchObject({ status: 'ready', value: [RECIPIENT] });

    const connectionFailure = setup();
    vi.mocked(connectionFailure.channels.connections).mockResolvedValueOnce(fail());
    await loadChannelsScreen(connectionFailure.context);
    expect(connectionFailure.state.live.testRecipients).toEqual({ status: 'error', error: ERROR });

    const recipientFailure = setup();
    vi.mocked(recipientFailure.channels.testRecipients).mockResolvedValueOnce(fail());
    await loadChannelsScreen(recipientFailure.context);
    expect(recipientFailure.state.live.testRecipients).toEqual({ status: 'error', error: ERROR });

    const noTenant = setup();
    noTenant.state.live.session = { status: 'signed_in', email: 'owner@test.local', memberships: [], tenantId: null };
    await loadChannelsScreen(noTenant.context);
    expect(noTenant.channels.connections).not.toHaveBeenCalled();
  });

  it('authorizes and revokes only after committed server responses', async () => {
    const app = setup();
    expect(await authorizeTestRecipient(app.context, 'channel-1', '201000000000', 'Owner phone')).toBe(true);
    expect(app.channels.authorizeTestRecipient).toHaveBeenCalledWith('tenant-1', 'channel-1', '201000000000', 'Owner phone');
    expect(app.state.toasts.at(-1)?.text).toContain('authorized');
    expect(await revokeTestRecipient(app.context, 'channel-1', 'recipient-1')).toBe(true);
    expect(app.channels.revokeTestRecipient).toHaveBeenCalledWith('tenant-1', 'channel-1', 'recipient-1');

    vi.mocked(app.channels.authorizeTestRecipient).mockResolvedValueOnce(fail());
    expect(await authorizeTestRecipient(app.context, 'channel-1', '201000000000', 'Owner phone')).toBe(false);
    expect(app.state.live.error).toEqual(ERROR);
  });

  it('collects the screen fields and refuses incomplete or malformed controls', async () => {
    const app = setup();
    expect(await LIVE_ACTIONS['live-authorize-test-recipient']?.(app.context, 'channel-1')).toBe(false);
    app.state.dialogForm[channelTestIdentityField('channel-1')] = '201000000000';
    app.state.dialogForm[channelTestLabelField('channel-1')] = 'Owner phone';
    expect(await LIVE_ACTIONS['live-authorize-test-recipient']?.(app.context, 'channel-1')).toBe(true);
    expect(app.state.dialogForm).toEqual({});
    expect(await LIVE_ACTIONS['live-revoke-test-recipient']?.(app.context, ':')).toBe(false);
    expect(await LIVE_ACTIONS['live-revoke-test-recipient']?.(app.context, 'channel-1:recipient-1')).toBe(true);
  });
});
