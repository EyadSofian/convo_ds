import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SendCommand } from '@convo/domain';
import type { ChannelTransportPort } from './channel-transport.js';
import { unconfiguredTransport } from './channel-transport.js';
import { CustomChannelTransport, withOwnChannels } from './custom-channel.transport.js';

const NOW = new Date('2026-09-26T09:00:00.000Z');
const KEY = 'gateway-signing-key-00000000000001';
const URL_OUT = 'https://crm.school.example/convo';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function transport(answer: () => Promise<Response>): { readonly own: CustomChannelTransport; readonly calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  }) as unknown as typeof fetch;
  return { own: new CustomChannelTransport({ fetchImpl, now: () => NOW, timeoutMs: 50 }), calls };
}

const reply = (status: number, body?: unknown): Promise<Response> =>
  Promise.resolve(new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status }));

function command(overrides: Partial<SendCommand> = {}): SendCommand {
  return {
    assetIdentity: 'gateway-1',
    peerIdentity: 'crm-4411',
    messageType: 'text',
    text: 'أهلًا',
    template: null,
    attachments: [],
    idempotencyKey: 'attempt-1',
    endpoint: URL_OUT,
    ...overrides,
  };
}

describe('sending a reply to the operator’s own system', () => {
  it('posts a signed text reply and folds receipts onto the id they return', async () => {
    const { own, calls } = transport(() => reply(200, { message_id: 'crm-msg-9' }));
    expect(await own.send(KEY, command())).toEqual({ status: 'accepted', providerMessageId: 'crm-msg-9', raw: { message_id: 'crm-msg-9' } });
    const sent = calls[0]!;
    expect(sent.url).toBe(URL_OUT);
    const headers = sent.init.headers as Record<string, string>;
    const stamp = String(NOW.getTime() / 1000);
    expect(headers['x-convo-timestamp']).toBe(stamp);
    // The same scheme they verify our deliveries with, over the exact body.
    expect(headers['x-convo-signature']).toBe(`v1=${createHmac('sha256', KEY).update(`${stamp}.${String(sent.init.body)}`).digest('hex')}`);
    expect(JSON.parse(String(sent.init.body))).toEqual({
      object: 'convo_custom',
      version: '1',
      asset_id: 'gateway-1',
      messages: [{ id: 'attempt-1', to: 'crm-4411', type: 'text', text: 'أهلًا' }],
    });
    expect(sent.init.redirect).toBe('manual');
  });

  it('uses its own id when their answer carries none', async () => {
    for (const body of [undefined, 'not json', [1], { message_id: '' }]) {
      const { own } = transport(() => reply(202, body));
      expect(await own.send(KEY, command())).toMatchObject({ status: 'accepted', providerMessageId: 'attempt-1' });
    }
  });

  it('refuses before sending when there is nowhere to send, or nothing it can carry', async () => {
    const { own, calls } = transport(() => reply(200));
    expect(await own.send(KEY, command({ endpoint: null }))).toMatchObject({ status: 'definitely_rejected', code: 'custom_endpoint_missing', retryable: true });
    const { endpoint: _endpoint, ...unset } = command();
    void _endpoint;
    expect(await own.send(KEY, unset)).toMatchObject({ code: 'custom_endpoint_missing' });
    expect(await own.send(KEY, command({ messageType: 'template', text: null }))).toMatchObject({ code: 'unsupported_message_type', retryable: false });
    expect(await own.send(KEY, command({ text: null }))).toMatchObject({ code: 'unsupported_message_type' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [429, 'rate_limited', true],
    [503, 'provider_unavailable', true],
    [401, 'credential_rejected', true],
    [403, 'credential_rejected', true],
    [400, 'provider_error_400', false],
  ])('classifies a %i answer', async (status, code, retryable) => {
    const { own } = transport(() => reply(status));
    expect(await own.send(KEY, command())).toMatchObject({ status: 'definitely_rejected', code, retryable });
  });

  it('never claims to know what happened when nothing came back', async () => {
    const timeout = transport(() => Promise.reject(Object.assign(new Error('late'), { name: 'TimeoutError' })));
    expect(await timeout.own.send(KEY, command())).toMatchObject({ status: 'outcome_unknown', code: 'provider_timeout' });
    const aborted = transport(() => Promise.reject(Object.assign(new Error('gone'), { name: 'AbortError' })));
    expect(await aborted.own.send(KEY, command())).toMatchObject({ code: 'provider_timeout' });
    const refused = transport(() => Promise.reject(new TypeError('fetch failed')));
    expect(await refused.own.send(KEY, command())).toMatchObject({ status: 'outcome_unknown', code: 'provider_unreachable' });
    const odd = transport(() => Promise.reject('odd'));
    expect(await odd.own.send(KEY, command())).toMatchObject({ code: 'provider_unreachable' });
  });

  it('uses the real clock and fetch by default', async () => {
    expect(new CustomChannelTransport()).toBeInstanceOf(CustomChannelTransport);
    let stamp = '';
    const fetchImpl = ((_url: string, init: RequestInit) => {
      stamp = (init.headers as Record<string, string>)['x-convo-timestamp']!;
      return reply(200);
    }) as unknown as typeof fetch;
    await new CustomChannelTransport({ fetchImpl }).send(KEY, command());
    expect(Math.abs(Number(stamp) - Date.now() / 1000)).toBeLessThan(5);
  });
});

describe('verifying the reply URL', () => {
  it('pings it signed, and answers what it said', async () => {
    const ok = transport(() => reply(204));
    expect(await ok.own.validate(KEY, 'gateway-1', URL_OUT)).toEqual({ ok: true, assetIdentity: 'gateway-1', code: null, message: null });
    expect(JSON.parse(String(ok.calls[0]!.init.body))).toEqual({ object: 'convo_custom', version: '1', asset_id: 'gateway-1', type: 'ping' });
    const refused = transport(() => reply(404));
    expect(await refused.own.validate(KEY, 'gateway-1', URL_OUT)).toMatchObject({ ok: false, code: 'endpoint_error_404' });
    const down = transport(() => Promise.reject(new TypeError('fetch failed')));
    expect(await down.own.validate(KEY, 'gateway-1', URL_OUT)).toMatchObject({ ok: false, code: 'provider_unreachable' });
    expect(await down.own.validate(KEY, 'gateway-1', null)).toMatchObject({ ok: false, code: 'custom_endpoint_missing' });
  });
});

describe('the installation transport with our own channels in front', () => {
  it('routes custom to its own half and everything else to the provider', async () => {
    const { own, calls } = transport(() => reply(200));
    const routed = withOwnChannels(unconfiguredTransport, own);
    expect(routed.name).toBe('unconfigured');
    expect(await routed.send('custom', KEY, command())).toMatchObject({ status: 'accepted' });
    expect(await routed.send('whatsapp', 'token', command())).toMatchObject({ status: 'definitely_rejected' });
    expect(await routed.validateConnection('custom', KEY, 'gateway-1', null, URL_OUT)).toMatchObject({ ok: true });
    expect(await routed.validateConnection('custom', KEY, 'gateway-1')).toMatchObject({ code: 'custom_endpoint_missing' });
    expect(await routed.validateConnection('whatsapp', 'token', 'phone-1')).toMatchObject({ ok: false });
    expect(calls).toHaveLength(2);
    expect(routed.fetchTemplates).toBeUndefined();
    expect(routed.fetchPeerProfile).toBeUndefined();
    expect(withOwnChannels(unconfiguredTransport).name).toBe('unconfigured');
  });

  it('keeps the provider’s optional abilities, bound to it', async () => {
    const base: ChannelTransportPort = {
      ...unconfiguredTransport,
      name: 'provider',
      fetchPeerProfile(this: ChannelTransportPort) {
        return Promise.resolve(this.name);
      },
      fetchTemplates(this: ChannelTransportPort) {
        return Promise.resolve({ ok: true, templates: [] });
      },
    };
    const routed = withOwnChannels(base);
    expect(await routed.fetchPeerProfile!('messenger', 't', 'p')).toBe('provider');
    expect(await routed.fetchTemplates!('whatsapp', 't', 'a')).toEqual({ ok: true, templates: [] });
  });
});
