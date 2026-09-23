import type { SendCommand } from '@convo/domain';
import { describe, expect, it } from 'vitest';
import { MetaWhatsAppTransport } from './meta-whatsapp.transport.js';

/**
 * The classification, from both failure directions.
 *
 * `outcome_unknown` is never retried automatically (ADR-0006), so returning it
 * for a failure we could have attributed strands a real message. Returning
 * anything else for a request that genuinely vanished sends a school's parents
 * the same message twice. Every test below names which of those it defends.
 */

const GRAPH = 'https://graph.example/v21.0';
const TOKEN = 'EAAG-access-token';

const TEXT: SendCommand = {
  assetIdentity: '15550001111',
  peerIdentity: '201234567890',
  messageType: 'text',
  text: 'مرحبا، تم تأكيد تسجيلك.',
  template: null,
  attachments: [],
  idempotencyKey: 'attempt-1',
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown> | null;
}

function transport(responder: (call: Call) => Response | Error) {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body === undefined ? null : (JSON.parse(String(init.body)) as Record<string, unknown>),
    };
    calls.push(call);
    const answer = responder(call);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }) as unknown as typeof fetch;
  return { calls, adapter: new MetaWhatsAppTransport({ graphBase: GRAPH, fetchImpl }) };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function graphError(status: number, code: number, message = 'Graph said no'): Response {
  return json(status, { error: { message, type: 'OAuthException', code, fbtrace_id: 'A1' } });
}

const ACCEPTED = json(200, {
  messaging_product: 'whatsapp',
  contacts: [{ input: '201234567890', wa_id: '201234567890' }],
  messages: [{ id: 'wamid.ABC123' }],
});

describe('sending a text message', () => {
  it('accepts, and reports the provider message id', async () => {
    const { adapter } = transport(() => ACCEPTED);
    expect(await adapter.send('whatsapp', TOKEN, TEXT)).toMatchObject({
      status: 'accepted',
      providerMessageId: 'wamid.ABC123',
    });
  });

  it('posts to the pinned Graph version and the configured phone number', async () => {
    const { adapter, calls } = transport(() => ACCEPTED);
    await adapter.send('whatsapp', TOKEN, TEXT);
    expect(calls[0]?.url).toBe(`${GRAPH}/15550001111/messages`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('builds the Cloud API text envelope, with link previews off', async () => {
    const { adapter, calls } = transport(() => ACCEPTED);
    await adapter.send('whatsapp', TOKEN, TEXT);
    expect(calls[0]?.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '201234567890',
      type: 'text',
      text: { preview_url: false, body: 'مرحبا، تم تأكيد تسجيلك.' },
    });
  });

  it('sends a template when one is chosen', async () => {
    const { adapter, calls } = transport(() => ACCEPTED);
    await adapter.send('whatsapp', TOKEN, {
      ...TEXT,
      messageType: 'template',
      text: null,
      template: { name: 'enrollment_confirmation', language: 'ar' },
    });
    expect(calls[0]?.body).toMatchObject({
      type: 'template',
      template: { name: 'enrollment_confirmation', language: { code: 'ar' } },
    });
  });

  it('sends the canonical template component parameters without converting them to free text', async () => {
    const { adapter, calls } = transport(() => ACCEPTED);
    await adapter.send('whatsapp', TOKEN, {
      ...TEXT,
      messageType: 'template',
      text: null,
      template: { name: 'hello', language: 'ar', components: [
        { type: 'body', parameters: [{ type: 'text', text: 'Ahmed' }, { type: 'text', text: 'Monday' }] },
        { type: 'button', subType: 'url', index: '0', parameters: [{ type: 'text', text: 'order-7' }] },
      ] },
    });
    expect(calls[0]?.body).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '201234567890', type: 'template',
      template: { name: 'hello', language: { code: 'ar' }, components: [
        { type: 'body', parameters: [{ type: 'text', text: 'Ahmed' }, { type: 'text', text: 'Monday' }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'order-7' }] },
      ] },
    });
  });

  it('refuses a message type it cannot actually send, rather than dropping content', async () => {
    const { adapter, calls } = transport(() => ACCEPTED);
    const outcome = await adapter.send('whatsapp', TOKEN, {
      ...TEXT,
      messageType: 'image',
      text: null,
    });
    expect(outcome).toMatchObject({
      status: 'definitely_rejected',
      code: 'unsupported_message_type',
      retryable: false,
    });
    // Nothing was sent, so nothing can have been half-sent.
    expect(calls).toHaveLength(0);
  });
});

describe('Messenger and Instagram Graph contracts', () => {
  it('sends Messenger replies through the Page endpoint and preserves Meta message ids', async () => {
    const { adapter, calls } = transport(() => json(200, { recipient_id: 'psid-1', message_id: 'mid.page.1' }));
    const outcome = await adapter.send('messenger', TOKEN, { ...TEXT, assetIdentity: 'page-1', peerIdentity: 'psid-1' });
    expect(outcome).toMatchObject({ status: 'accepted', providerMessageId: 'mid.page.1' });
    expect(calls[0]).toMatchObject({
      url: `${GRAPH}/page-1/messages`,
      body: { recipient: { id: 'psid-1' }, messaging_type: 'RESPONSE', message: { text: TEXT.text } },
    });
  });

  it('sends Instagram replies through the professional-account endpoint', async () => {
    const { adapter, calls } = transport(() => json(200, { recipient_id: 'igsid-1', message_id: 'mid.ig.1' }));
    const outcome = await adapter.send('instagram', TOKEN, { ...TEXT, assetIdentity: 'ig-account-1', peerIdentity: 'igsid-1' });
    expect(outcome).toMatchObject({ status: 'accepted', providerMessageId: 'mid.ig.1' });
    expect(calls[0]).toMatchObject({
      url: `${GRAPH}/ig-account-1/messages`,
      body: { recipient: { id: 'igsid-1' }, message: { text: TEXT.text } },
    });
    expect(calls[0]?.body).not.toHaveProperty('messaging_type');
  });

  it('validates the configured Page and Instagram assets before the channel is considered connected', async () => {
    const { adapter, calls } = transport((call) => {
      if (call.url.includes('page-1')) return json(200, { id: 'page-1', name: 'I BOTS' });
      return json(200, { id: 'ig-account-1', username: 'ibots' });
    });
    await expect(adapter.validateConnection('messenger', TOKEN, 'page-1')).resolves.toMatchObject({ ok: true, assetIdentity: 'page-1' });
    await expect(adapter.validateConnection('instagram', TOKEN, 'ig-account-1')).resolves.toMatchObject({ ok: true, assetIdentity: 'ig-account-1' });
    expect(calls.map((call) => call.url)).toEqual([
      `${GRAPH}/page-1?fields=id,name`,
      `${GRAPH}/ig-account-1?fields=id,username`,
    ]);
  });

  it('refuses unsupported attachment commands without making a partial provider call', async () => {
    const { adapter, calls } = transport(() => ACCEPTED);
    await expect(adapter.send('messenger', TOKEN, { ...TEXT, messageType: 'image', text: null })).resolves.toMatchObject({
      status: 'definitely_rejected', code: 'unsupported_message_type', retryable: false,
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects incomplete Messenger and Instagram text commands before they reach Graph', async () => {
    const { adapter, calls } = transport(() => ACCEPTED);
    await expect(adapter.send('messenger', TOKEN, { ...TEXT, text: null })).resolves.toMatchObject({
      status: 'definitely_rejected', code: 'unsupported_message_type', retryable: false,
    });
    await expect(adapter.send('instagram', TOKEN, { ...TEXT, text: '' })).resolves.toMatchObject({
      status: 'definitely_rejected', code: 'unsupported_message_type', retryable: false,
    });
    expect(calls).toHaveLength(0);
  });

  it('falls back to the message collection when a direct Meta message id is blank', async () => {
    const { adapter } = transport(() => json(200, {
      message_id: '',
      messages: [{ id: 'mid.page.fallback' }],
    }));
    await expect(adapter.send('messenger', TOKEN, { ...TEXT, assetIdentity: 'page-1', peerIdentity: 'psid-1' }))
      .resolves.toMatchObject({ status: 'accepted', providerMessageId: 'mid.page.fallback' });
  });
});

describe('a request that vanished', () => {
  it('is outcome_unknown on a timeout, because Meta may hold the message', async () => {
    const { adapter } = transport(() => {
      const error = new Error('aborted');
      error.name = 'TimeoutError';
      return error;
    });
    expect(await adapter.send('whatsapp', TOKEN, TEXT)).toMatchObject({
      status: 'outcome_unknown',
      code: 'provider_timeout',
    });
  });

  it('is outcome_unknown when the network failed', async () => {
    const { adapter } = transport(() => new TypeError('fetch failed'));
    expect(await adapter.send('whatsapp', TOKEN, TEXT)).toMatchObject({
      status: 'outcome_unknown',
      code: 'provider_unreachable',
    });
  });

  it('is outcome_unknown on a 200 with no message id', async () => {
    // Accepting it would leave a message no delivery receipt could ever be
    // folded onto; rejecting it would claim a failure we did not observe.
    const { adapter } = transport(() => json(200, { messaging_product: 'whatsapp' }));
    expect(await adapter.send('whatsapp', TOKEN, TEXT)).toMatchObject({
      status: 'outcome_unknown',
      code: 'provider_response_unusable',
    });
  });
});

describe('failures time can fix', () => {
  it.each([
    ['a 429', 429, 0],
    ['throughput code 4', 400, 4],
    ['throughput code 80007', 400, 80007],
    ['throughput code 130429', 400, 130429],
  ])('retries %s', async (_label, status, code) => {
    const { adapter } = transport(() => graphError(status, code));
    expect(await adapter.send('whatsapp', TOKEN, TEXT)).toMatchObject({
      status: 'definitely_rejected',
      code: 'rate_limited',
      retryable: true,
    });
  });

  it('retries a Graph outage', async () => {
    const { adapter } = transport(() => graphError(503, 2));
    expect(await adapter.send('whatsapp', TOKEN, TEXT)).toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    });
  });

  it('retries an expired access token, because reconnecting fixes it', async () => {
    // The message is still worth sending once an operator reconnects the
    // channel. The outbox's bounded attempts stop this becoming a loop.
    const { adapter } = transport(() => graphError(401, 190, 'Session has expired'));
    expect(await adapter.send('whatsapp', TOKEN, TEXT)).toMatchObject({
      code: 'credential_rejected',
      retryable: true,
    });
  });
});

describe('failures time cannot fix', () => {
  it('does not retry a message outside the 24-hour service window', async () => {
    // Only a template can help, and choosing one is the sender's decision.
    const { adapter } = transport(() => graphError(400, 131047));
    expect(await adapter.send('whatsapp', TOKEN, TEXT)).toMatchObject({
      code: 'outside_service_window',
      retryable: false,
    });
  });

  it('does not retry an undeliverable recipient', async () => {
    const { adapter } = transport(() => graphError(400, 131026));
    expect(await adapter.send('whatsapp', TOKEN, TEXT)).toMatchObject({
      code: 'recipient_undeliverable',
      retryable: false,
    });
  });

  it('does not retry a malformed request', async () => {
    const { adapter } = transport(() => graphError(400, 100));
    expect(await adapter.send('whatsapp', TOKEN, TEXT)).toMatchObject({
      code: 'invalid_request',
      retryable: false,
    });
  });

  it('treats an unrecognised refusal as permanent', async () => {
    // Retrying an unrecognised refusal five times is how a rate limit becomes
    // a ban.
    const { adapter } = transport(() => graphError(400, 999999));
    expect(await adapter.send('whatsapp', TOKEN, TEXT)).toMatchObject({
      code: 'provider_error_999999',
      retryable: false,
    });
  });

  it('survives an error body that is not JSON', async () => {
    const { adapter } = transport(() => new Response('<html>bad gateway</html>', { status: 502 }));
    expect(await adapter.send('whatsapp', TOKEN, TEXT)).toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    });
  });
});

describe('channels this transport does not serve', () => {
  it.each(['web_chat', 'custom'] as const)('refuses %s by name', async (kind) => {
    const { adapter, calls } = transport(() => ACCEPTED);
    expect(await adapter.send(kind, TOKEN, TEXT)).toMatchObject({
      status: 'definitely_rejected',
      code: 'channel_not_supported',
      retryable: false,
    });
    expect(calls).toHaveLength(0);
  });
});

describe('the connection test', () => {
  it('passes when the token reads back the configured number', async () => {
    const { adapter, calls } = transport(() =>
      json(200, { id: '15550001111', display_phone_number: '+1 555 000 1111', verified_name: 'Digital School' }),
    );
    expect(await adapter.validateConnection('whatsapp', TOKEN, '15550001111')).toEqual({
      ok: true,
      assetIdentity: '15550001111',
      code: null,
      message: null,
    });
    expect(calls[0]?.url).toContain(`${GRAPH}/15550001111?fields=`);
  });

  it('fails when the token reads a different number', async () => {
    // A token valid for somebody else's asset is the most common way a
    // connection is configured wrongly, and reporting ok would let it go live.
    const { adapter } = transport(() => json(200, { id: '15559998888' }));
    expect(await adapter.validateConnection('whatsapp', TOKEN, '15550001111')).toMatchObject({
      ok: false,
      code: 'asset_mismatch',
    });
  });

  it('fails with a typed reason when the token is rejected', async () => {
    const { adapter } = transport(() => graphError(401, 190));
    expect(await adapter.validateConnection('whatsapp', TOKEN, '15550001111')).toMatchObject({
      ok: false,
      code: 'credential_rejected',
    });
  });

  it('fails without claiming a verdict when Graph is unreachable', async () => {
    const { adapter } = transport(() => new TypeError('fetch failed'));
    expect(await adapter.validateConnection('whatsapp', TOKEN, '15550001111')).toMatchObject({
      ok: false,
      code: 'provider_unreachable',
    });
  });

  it('refuses to validate a non-Meta channel', async () => {
    const { adapter } = transport(() => ACCEPTED);
    expect(await adapter.validateConnection('web_chat', TOKEN, 'x')).toMatchObject({
      ok: false,
      code: 'channel_not_supported',
    });
  });
});

describe('template synchronization', () => {
  it('resolves the WABA, follows cursors, normalizes statuses and variables', async () => {
    const { adapter, calls } = transport((call) => {
      if (call.url.includes('whatsapp_business_account')) return json(200, { whatsapp_business_account: { id: 'waba-1' } });
      if (call.url.includes('after=page-2')) return json(200, { data: [
        { id: 't-3', name: 'paused', language: 'en', category: 'MARKETING', status: 'PAUSED', components: [] },
        { id: 't-4', name: 'unknown', language: 'en', category: 'UTILITY', status: 'DISABLED_BY_META', components: [] },
        { id: 't-5', name: 'rejected', language: 'en', category: 'UTILITY', status: 'REJECTED', components: [] },
        null,
      ] });
      return json(200, { data: [
        { id: 't-1', name: 'welcome', language: 'ar', category: 'UTILITY', status: 'APPROVED', components: [{ text: 'Hi {{2}} {{1}} {{2}}' }] },
        { id: 't-2', name: 'pending', language: 'en', category: 'AUTHENTICATION', status: 'IN_APPEAL', components: [] },
      ], paging: { cursors: { after: 'page-2' } } });
    });
    const result = await adapter.fetchTemplates('whatsapp', TOKEN, 'phone-1');
    expect(result).toMatchObject({ ok: true, templates: [
      { providerId: 't-1', status: 'approved', category: 'utility', variables: ['{{1}}', '{{2}}'] },
      { providerId: 't-2', status: 'pending' },
      { providerId: 't-3', status: 'paused' },
      { providerId: 't-4', status: 'disabled' },
      { providerId: 't-5', status: 'rejected' },
    ] });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('fails safely for unsupported channels, missing WABAs, bad pages and Graph failures', async () => {
    const unsupported = transport(() => json(200, {})).adapter;
    expect(await unsupported.fetchTemplates('instagram', TOKEN, 'x')).toMatchObject({ ok: false, code: 'channel_not_supported' });
    expect(await transport(() => json(200, {})).adapter.fetchTemplates('whatsapp', TOKEN, 'x')).toMatchObject({ ok: false, code: 'waba_not_found' });
    const malformed = transport((call) => call.url.includes('whatsapp_business_account')
      ? json(200, { whatsapp_business_account: { id: 'w' } }) : json(200, { data: null })).adapter;
    expect(await malformed.fetchTemplates('whatsapp', TOKEN, 'x')).toMatchObject({ ok: false, code: 'provider_response_unusable' });
    expect(await transport(() => graphError(401, 190)).adapter.fetchTemplates('whatsapp', TOKEN, 'x')).toMatchObject({ ok: false, code: 'credential_rejected' });
    expect(await transport(() => new TypeError('offline')).adapter.fetchTemplates('whatsapp', TOKEN, 'x')).toMatchObject({ ok: false, code: 'provider_unreachable' });
    expect(await transport(() => new DOMException('late', 'TimeoutError')).adapter.fetchTemplates('whatsapp', TOKEN, 'x')).toMatchObject({ ok: false, code: 'provider_timeout' });
    const pageFailure = transport((call) => call.url.includes('whatsapp_business_account')
      ? json(200, { whatsapp_business_account: { id: 'w' } }) : graphError(503, 2)).adapter;
    expect(await pageFailure.fetchTemplates('whatsapp', TOKEN, 'x')).toMatchObject({ ok: false, retryable: true });
  });

  it('caps pagination rather than looping forever', async () => {
    const { adapter, calls } = transport((call) => call.url.includes('whatsapp_business_account')
      ? json(200, { whatsapp_business_account: { id: 'w' } })
      : json(200, { data: [], paging: { cursors: { after: 'again' } } }));
    expect(await adapter.fetchTemplates('whatsapp', TOKEN, 'x')).toMatchObject({ ok: false, code: 'provider_pagination_limit' });
    expect(calls).toHaveLength(21);
  });
});
