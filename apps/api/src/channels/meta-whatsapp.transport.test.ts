import type { SendCommand } from '@convo/domain';
import { describe, expect, it, vi } from 'vitest';
import { ProfileLookupError } from './channel-transport.js';
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

describe('fetching what a customer sent', () => {
  const media = (body: string, headers: Record<string, string> = { 'content-type': 'audio/ogg' }) => new Response(body, { status: 200, headers });

  it('resolves a WhatsApp media id, then downloads it with the token', async () => {
    const { adapter, calls } = transport((call) => call.url === `${GRAPH}/987`
      ? json(200, { url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=987' })
      : media('voice'));
    const fetched = await adapter.fetchInboundMedia('whatsapp', TOKEN, '987');
    expect(fetched).toMatchObject({ ok: true, mimeType: 'audio/ogg' });
    expect(fetched.ok && fetched.data.toString()).toBe('voice');
    expect(calls[1]?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('downloads a Messenger or Instagram link without giving it the token', async () => {
    for (const kind of ['messenger', 'instagram'] as const) {
      const { adapter, calls } = transport(() => new Response(new Uint8Array([1])));
      expect(await adapter.fetchInboundMedia(kind, TOKEN, 'https://cdn.fbsbx.com/v/clip.mp4')).toMatchObject({ ok: true, mimeType: null });
      expect(calls[0]?.headers['authorization']).toBeUndefined();
    }
  });

  it('refuses anything that is not Meta\'s own, without calling it', async () => {
    const { adapter, calls } = transport(() => media('x'));
    for (const link of [
      'https://fbcdn.net.attacker.example/a', 'http://cdn.fbsbx.com/a', 'https://user@cdn.fbsbx.com/a',
      'https://:secret@cdn.fbsbx.com/a', 'https://cdn.fbsbx.com:444/a', 'not a link',
    ]) expect(await adapter.fetchInboundMedia('messenger', TOKEN, link)).toMatchObject({ code: 'media_not_available' });
    expect(await adapter.fetchInboundMedia('whatsapp', TOKEN, '../me')).toMatchObject({ code: 'media_not_available' });
    expect(await adapter.fetchInboundMedia('custom', TOKEN, 'https://cdn.fbsbx.com/a')).toMatchObject({ code: 'media_not_available' });
    expect(calls).toHaveLength(0);
  });

  it('will not follow Graph to a host that is not Meta\'s, or answer without a link', async () => {
    const away = transport((call) => call.url === `${GRAPH}/1` ? json(200, { url: 'https://attacker.example/a' }) : media('x'));
    expect(await away.adapter.fetchInboundMedia('whatsapp', TOKEN, '1')).toMatchObject({ code: 'media_not_available' });
    expect(away.calls).toHaveLength(1);
    const blank = transport(() => json(200, {}));
    expect(await blank.adapter.fetchInboundMedia('whatsapp', TOKEN, '1')).toMatchObject({ code: 'media_not_available' });
  });

  it('refuses a redirect that lands away from Meta', async () => {
    const redirected = new Response('x', { status: 200 });
    Object.defineProperty(redirected, 'url', { value: 'https://attacker.example/landed' });
    const { adapter } = transport(() => redirected);
    expect(await adapter.fetchInboundMedia('messenger', TOKEN, 'https://cdn.fbsbx.com/a')).toMatchObject({ code: 'media_not_available' });
    const staying = new Response('x', { status: 200 });
    Object.defineProperty(staying, 'url', { value: 'https://scontent.xx.fbcdn.net/landed' });
    const kept = transport(() => staying);
    expect(await kept.adapter.fetchInboundMedia('messenger', TOKEN, 'https://cdn.fbsbx.com/a')).toMatchObject({ ok: true });
  });

  it('reports what went wrong in terms an operator can act on', async () => {
    const expired = transport(() => new Response('', { status: 403 }));
    expect(await expired.adapter.fetchInboundMedia('messenger', TOKEN, 'https://cdn.fbsbx.com/a')).toMatchObject({ code: 'media_not_available', retryable: false });
    const denied = transport(() => graphError(401, 190, 'Token expired'));
    expect(await denied.adapter.fetchInboundMedia('whatsapp', TOKEN, '1')).toMatchObject({ code: 'credential_rejected', message: 'Token expired' });
    const down = transport(() => new Error('offline'));
    expect(await down.adapter.fetchInboundMedia('messenger', TOKEN, 'https://cdn.fbsbx.com/a')).toMatchObject({ code: 'provider_unreachable', retryable: true });
    const slow = transport(() => { const timeout = new Error('slow'); timeout.name = 'AbortError'; return timeout; });
    expect(await slow.adapter.fetchInboundMedia('messenger', TOKEN, 'https://cdn.fbsbx.com/a')).toMatchObject({ code: 'provider_timeout', retryable: true });
  });

  it('refuses media beyond the limit, by its declared size and by its real one', async () => {
    const declared = transport(() => media('x', { 'content-length': String(101 * 1024 * 1024) }));
    expect(await declared.adapter.fetchInboundMedia('messenger', TOKEN, 'https://cdn.fbsbx.com/a')).toMatchObject({ code: 'media_too_large' });
    const huge = new Response('x', { status: 200 });
    Object.defineProperty(huge, 'arrayBuffer', { value: () => Promise.resolve(new ArrayBuffer(101 * 1024 * 1024)) });
    const silent = transport(() => huge);
    expect(await silent.adapter.fetchInboundMedia('messenger', TOKEN, 'https://cdn.fbsbx.com/a')).toMatchObject({ code: 'media_too_large' });
  });
});

describe('syncing a Meta Page', () => {
  const SINCE = new Date('2026-10-01T00:00:00Z');
  const conversation = (updated: string, ...ids: string[]) => ({
    updated_time: updated,
    messages: { data: ids.map((id) => ({ id })) },
  });
  const subscribed = () => json(200, { success: true });

  it('subscribes every field the product reads, then reads recent conversations', async () => {
    const { adapter, calls } = transport((call) => call.method === 'POST'
      ? subscribed()
      : json(200, { data: [conversation('2026-11-01T00:00:00+0000', 'm1', 'm2')] }));
    expect(await adapter.syncMetaPage('messenger', TOKEN, '123', SINCE)).toEqual({
      ok: true, subscriptionError: null, conversations: 1, messages: [{ id: 'm1' }, { id: 'm2' }],
    });
    const [subscribe, read] = calls;
    expect(subscribe?.url).toBe(`${GRAPH}/123/subscribed_apps?subscribed_fields=messages,message_echoes,message_deliveries,message_reads,message_reactions,messaging_postbacks,messaging_handovers,standby`);
    expect(subscribe?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    const url = decodeURIComponent(read?.url ?? '');
    expect(url).toContain(`${GRAPH}/123/conversations?platform=messenger&limit=25&fields=updated_time,messages.limit(20){id,created_time,from,to,message,attachments{`);
    expect(url).not.toContain('after=');
  });

  it('follows the cursor while conversations are recent, within its bound', async () => {
    const pages: unknown[] = [];
    const { adapter, calls } = transport((call) => {
      if (call.method === 'POST') return subscribed();
      pages.push(call.url);
      return json(200, {
        data: [conversation('2026-11-01T00:00:00+0000', `m${String(pages.length)}`)],
        paging: { next: 'https://graph/next', cursors: { after: `cursor ${String(pages.length)}` } },
      });
    });
    const synced = await adapter.syncMetaPage('messenger', TOKEN, '123', SINCE);
    expect(synced).toMatchObject({ ok: true, conversations: 4 });
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(4);
    expect(String(pages[1])).toContain('platform=messenger&limit=25');
    expect(String(pages[1])).toContain('&after=cursor%201');
  });

  it('reads the Instagram list bare, then each thread on its own', async () => {
    const { adapter, calls } = transport((call) => {
      if (call.method === 'POST') return subscribed();
      const url = new URL(call.url);
      if (url.pathname.endsWith('/conversations')) return json(200, {
        data: [
          { id: 'ig/one', updated_time: '2026-11-01T00:00:00Z' },
          { id: 'ig-slow', updated_time: '2026-11-01T00:00:00Z' },
          { id: 'ig-odd', updated_time: '2026-11-01T00:00:00Z' },
        ],
      });
      if (url.pathname.endsWith('ig-slow')) return new DOMException('late', 'TimeoutError');
      if (url.pathname.endsWith('ig-odd')) return json(200, []);
      return json(200, { messages: { data: [{ id: 'first' }, { id: 'second' }] } });
    });
    // The slow thread is skipped and the sync says it was partial; the others stand.
    expect(await adapter.syncMetaPage('instagram', TOKEN, '123', SINCE)).toEqual({
      ok: true, subscriptionError: null, conversations: 3, historyIncomplete: true, messages: [{ id: 'first' }, { id: 'second' }],
    });
    const reads = calls.filter((call) => call.method === 'GET').map((call) => decodeURIComponent(call.url));
    expect(reads[0]).toContain(`${GRAPH}/123/conversations?platform=instagram&limit=25&fields=id,updated_time`);
    expect(reads[0]).not.toContain('messages');
    // A Graph id is a path segment, so it is encoded rather than trusted.
    expect(calls[2]?.url).toContain(`${GRAPH}/ig%2Fone?fields=`);
    expect(reads[1]).toContain('fields=messages.limit(20){id,created_time,from,to,message,attachments{');
  });

  it('keeps earlier messages if the remaining history exceeds the time budget', async () => {
    const time = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(40_000);
    try {
      const { adapter, calls } = transport((call) => call.method === 'POST' ? subscribed() : json(200, {
        data: [conversation('2026-11-01T00:00:00Z', 'first')],
        paging: { next: 'more', cursors: { after: 'cursor' } },
      }));
      expect(await adapter.syncMetaPage('messenger', TOKEN, '123', SINCE)).toMatchObject({
        ok: true, conversations: 1, historyIncomplete: true, messages: [{ id: 'first' }],
      });
      expect(calls.filter((call) => call.method === 'GET')).toHaveLength(1);
    } finally {
      time.mockRestore();
    }
  });

  it('reports a history timeout when even the conversation list cannot be read', async () => {
    const { adapter, calls } = transport((call) => call.method === 'POST' ? subscribed() : new DOMException('late', 'TimeoutError'));
    expect(await adapter.syncMetaPage('instagram', TOKEN, '123', SINCE)).toMatchObject({
      ok: false, code: 'provider_timeout', message: 'Meta took too long to return the message history.',
    });
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(1);
  });

  it('stops at the first conversation older than the window', async () => {
    const { adapter, calls } = transport((call) => call.method === 'POST' ? subscribed() : json(200, {
      data: [conversation('2026-11-01T00:00:00+0000', 'recent'), conversation('2020-01-01T00:00:00+0000', 'old')],
      paging: { next: 'https://graph/next', cursors: { after: 'more' } },
    }));
    expect(await adapter.syncMetaPage('messenger', TOKEN, '123', SINCE)).toMatchObject({ conversations: 1, messages: [{ id: 'recent' }] });
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(1);
  });

  it('survives shapes Graph should not send but might', async () => {
    const { adapter } = transport((call) => call.method === 'POST' ? subscribed() : json(200, {
      data: ['junk', { updated_time: '2026-11-01T00:00:00+0000' }],
      paging: { cursors: { after: 'more' } },
    }));
    expect(await adapter.syncMetaPage('messenger', TOKEN, '123', SINCE)).toEqual({ ok: true, subscriptionError: null, conversations: 1, messages: [] });
    const empty = transport((call) => call.method === 'POST' ? subscribed() : json(200, {}));
    expect(await empty.adapter.syncMetaPage('messenger', TOKEN, '123', SINCE)).toMatchObject({ ok: true, conversations: 0 });
    const noCursor = transport((call) => call.method === 'POST' ? subscribed() : json(200, { data: [conversation('2026-11-01T00:00:00+0000')], paging: { next: 'x', cursors: {} } }));
    expect(await noCursor.adapter.syncMetaPage('messenger', TOKEN, '123', SINCE)).toMatchObject({ ok: true, conversations: 1 });
  });

  it('reports a refused subscription next to the messages it could still read', async () => {
    const denied = transport((call) => call.method === 'POST'
      ? graphError(403, 200, 'Needs pages_manage_metadata')
      : json(200, { data: [conversation('2026-11-01T00:00:00+0000', 'm1')] }));
    expect(await denied.adapter.syncMetaPage('messenger', TOKEN, '123', SINCE)).toMatchObject({
      ok: true, subscriptionError: 'Needs pages_manage_metadata', messages: [{ id: 'm1' }],
    });
    const silent = transport((call) => call.method === 'POST' ? json(200, { success: false }) : json(200, { data: [] }));
    expect(await silent.adapter.syncMetaPage('messenger', TOKEN, '123', SINCE)).toMatchObject({ subscriptionError: 'Meta did not confirm the Page subscription.' });
    const down = transport((call) => call.method === 'POST' ? new Error('offline') : json(200, { data: [] }));
    expect(await down.adapter.syncMetaPage('messenger', TOKEN, '123', SINCE)).toMatchObject({ subscriptionError: 'The Meta Graph API could not be reached.' });
    const slow = transport((call) => {
      if (call.method !== 'POST') return json(200, { data: [] });
      const timeout = new Error('slow'); timeout.name = 'TimeoutError'; return timeout;
    });
    expect(await slow.adapter.syncMetaPage('messenger', TOKEN, '123', SINCE)).toMatchObject({ subscriptionError: 'The Meta Graph API could not be reached.' });
  });

  it('says why when Meta will not let it read', async () => {
    const { adapter } = transport((call) => call.method === 'POST' ? subscribed() : graphError(403, 10, 'Advanced Access required'));
    expect(await adapter.syncMetaPage('messenger', TOKEN, '123', SINCE)).toEqual({
      ok: false, code: 'provider_error_10', message: 'Advanced Access required', retryable: false,
    });
  });

  it('refuses a Page id that could not be one, without calling anybody', async () => {
    const { adapter, calls } = transport(() => json(200, {}));
    expect(await adapter.syncMetaPage('messenger', TOKEN, '../me', SINCE)).toMatchObject({ ok: false, code: 'page_not_configured' });
    expect(calls).toHaveLength(0);
  });
});

describe('WhatsApp voice upload and send', () => {
  const command: SendCommand = { ...TEXT, messageType: 'audio', text: '', media: { data: new Uint8Array([79, 103, 103, 83]), filename: 'voice.ogg', mimeType: 'audio/ogg; codecs=opus', isVoice: true } };
  it('uploads Opus as multipart then sends a voice message by media ID', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return String(url).endsWith('/media') ? json(200, { id: '12345' }) : ACCEPTED.clone();
    }) as typeof fetch;
    const adapter = new MetaWhatsAppTransport({ graphBase: GRAPH, fetchImpl });
    expect(await adapter.send('whatsapp', TOKEN, command)).toMatchObject({ status: 'accepted' });
    const form = calls[0]!.init.body as FormData;
    expect(form.get('messaging_product')).toBe('whatsapp');
    expect(form.get('type')).toBe('audio/ogg');
    expect(await (form.get('file') as Blob).arrayBuffer()).toEqual(command.media!.data.buffer);
    expect(calls[0]!.init.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({ type: 'audio', audio: { id: '12345', voice: true } });
  });
  it.each([
    { kind: 'whatsapp', messageType: 'document', mimeType: 'application/pdf', filename: 'guide.pdf', asset: '15550001111' },
    { kind: 'messenger', messageType: 'file', mimeType: 'application/pdf', filename: 'guide.pdf', asset: '15550001111' },
    { kind: 'instagram', messageType: 'image', mimeType: 'image/png', filename: 'photo.png', asset: '76543' },
  ] as const)('uploads and sends a $messageType attachment via $kind', async ({ kind, messageType, mimeType, filename, asset }) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url, init) => {
      calls.push({ url: String(url), init: init! });
      if (calls.length === 1) return json(200, kind === 'whatsapp' ? { id: '12345' } : { attachment_id: '12345' });
      return kind === 'whatsapp' ? ACCEPTED.clone() : json(200, { message_id: 'm_123' });
    }) as typeof fetch;
    const adapter = new MetaWhatsAppTransport({ graphBase: GRAPH, fetchImpl });
    const file = { ...command.media!, filename, mimeType, isVoice: false };
    expect(await adapter.send(kind, TOKEN, { ...command, facebookPageId: '76543', messageType, media: file })).toMatchObject({ status: 'accepted' });
    expect(calls.map((call) => call.url)).toEqual([`${GRAPH}/${asset}/${kind === 'whatsapp' ? 'media' : 'message_attachments'}`, `${GRAPH}/${asset}/messages`]);
    const form = calls[0]!.init.body as FormData;
    expect((form.get(kind === 'whatsapp' ? 'file' : 'filedata') as File).name).toBe(filename);
    expect(form.get('platform')).toBe(kind === 'instagram' ? 'instagram' : null);
    const payload = JSON.parse(String(calls[1]!.init.body));
    expect(payload).toMatchObject(kind === 'whatsapp'
      ? { type: 'document', document: { id: '12345', filename } }
      : { message: { attachment: { type: messageType, payload: { attachment_id: '12345' } } } });
  });

  it.each([null, {}, { id: 123 }, { id: 'bad' }])('never sends when upload has no media ID: %j', async (answer) => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, answer));
    const adapter = new MetaWhatsAppTransport({ graphBase: GRAPH, fetchImpl });
    expect(await adapter.send('whatsapp', TOKEN, command)).toMatchObject({ status: 'definitely_rejected', code: 'media_upload_invalid', retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('distinguishes safely retryable upload failure from uncertain delivery after upload', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(graphError(401, 190))
      .mockResolvedValueOnce(json(500, null)).mockResolvedValueOnce(json(200, { id: '123' })).mockRejectedValueOnce(new Error('send lost'));
    const adapter = new MetaWhatsAppTransport({ graphBase: GRAPH, fetchImpl });
    expect(await adapter.send('whatsapp', TOKEN, command)).toMatchObject({ status: 'definitely_rejected', code: 'media_upload_unreachable' });
    expect(await adapter.send('whatsapp', TOKEN, command)).toMatchObject({ status: 'definitely_rejected', retryable: true });
    expect(await adapter.send('whatsapp', TOKEN, command)).toMatchObject({ status: 'definitely_rejected', retryable: true });
    expect(await adapter.send('whatsapp', TOKEN, command)).toMatchObject({ status: 'outcome_unknown' });
  });
});

describe('WhatsApp WABA webhook subscription', () => {
  it('subscribes only the supplied WABA using the stored credential', async () => {
    const { adapter, calls } = transport(() => json(200, { success: true }));
    expect(await adapter.subscribeWhatsAppWaba(TOKEN, '12345')).toEqual({ ok: true });
    expect(calls).toEqual([expect.objectContaining({
      url: `${GRAPH}/12345/subscribed_apps`,
      method: 'POST',
      headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
      body: null,
    })]);
  });

  it('does not claim success without Meta confirmation', async () => {
    const { adapter } = transport(() => json(200, {}));
    expect(await adapter.subscribeWhatsAppWaba(TOKEN, '12345')).toMatchObject({ ok: false, code: 'provider_response_unusable' });
  });

  it('rejects missing WABA and classifies provider refusal', async () => {
    const { adapter, calls } = transport(() => graphError(403, 200));
    expect(await adapter.subscribeWhatsAppWaba(TOKEN, '')).toMatchObject({ ok: false, code: 'waba_not_configured' });
    expect(calls).toHaveLength(0);
    expect(await adapter.subscribeWhatsAppWaba(TOKEN, '12345')).toMatchObject({ ok: false });
  });

  it('reports a network failure without claiming webhook subscription', async () => {
    const { adapter } = transport(() => new Error('network down'));
    expect(await adapter.subscribeWhatsAppWaba(TOKEN, '12345')).toMatchObject({ ok: false, code: 'provider_unreachable' });
    const timedOut = transport(() => new DOMException('late', 'TimeoutError'));
    expect(await timedOut.adapter.subscribeWhatsAppWaba(TOKEN, '12345')).toMatchObject({ ok: false, code: 'provider_timeout' });
  });
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

  it('preserves a media header object when sending an approved media template', async () => {
    const { adapter, calls } = transport(() => ACCEPTED);
    await adapter.send('whatsapp', TOKEN, {
      ...TEXT, messageType: 'template', text: null,
      template: { name: 'image_update', language: 'ar', components: [
        { type: 'header', parameters: [{ type: 'image', image: { link: 'https://example.com/class.jpg' } }] },
        { type: 'body', parameters: [{ type: 'text', text: 'Eyad' }] },
      ] },
    });
    expect(calls[0]?.body).toMatchObject({ template: { components: [
      { type: 'header', parameters: [{ type: 'image', image: { link: 'https://example.com/class.jpg' } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Eyad' }] },
    ] } });
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
  it('resolves only the exact Page-scoped sender and never exposes an error body', async () => {
    const { adapter, calls } = transport(() => json(200, { id: '4528904674043162', name: 'Eyad', username: 'eyad_sofian' }));
    expect(await adapter.fetchPeerProfile('instagram', TOKEN, '4528904674043162')).toBe('Eyad');
    expect(calls[0]).toMatchObject({ url: `${GRAPH}/4528904674043162?fields=id,name,username`, method: 'GET' });
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(await adapter.fetchPeerProfile('instagram', TOKEN, '../../invalid')).toBeNull();
    const mismatch = transport(() => json(200, { id: 'different', name: 'Wrong person' }));
    expect(await mismatch.adapter.fetchPeerProfile('messenger', TOKEN, '123')).toBeNull();
    const denied = transport(() => graphError(403, 10, 'private provider detail'));
    await expect(denied.adapter.fetchPeerProfile('messenger', TOKEN, '123'))
      .rejects.toMatchObject({ code: 'profile_permission_denied' });
  });

  it('uses a Messenger name, first/last name, or Instagram username without trusting malformed profiles', async () => {
    const full = transport(() => json(200, { id: '123', first_name: '  Eyad ', last_name: ' Sofian  ' }));
    expect(await full.adapter.fetchPeerProfile('messenger', TOKEN, '123')).toBe('Eyad Sofian');
    expect(full.calls[0]?.url).toBe(`${GRAPH}/123?fields=id,first_name,last_name`);
    const handle = transport(() => json(200, { id: '123', username: ' eyad_sofian ' }));
    expect(await handle.adapter.fetchPeerProfile('instagram', TOKEN, '123')).toBe('eyad_sofian');
    const empty = transport(() => json(200, { id: '123', name: null, username: null, first_name: null, last_name: null }));
    await expect(empty.adapter.fetchPeerProfile('messenger', TOKEN, '123'))
      .rejects.toMatchObject({ code: 'profile_withheld' });
    // No Page to ask, so the participants fallback is never attempted.
    expect(empty.calls).toHaveLength(1);
    const long = transport(() => json(200, { id: '123', name: 'x'.repeat(201) }));
    expect(await long.adapter.fetchPeerProfile('messenger', TOKEN, '123')).toBeNull();
    const down = transport(() => new Error('credential must never reach caller'));
    await expect(down.adapter.fetchPeerProfile('instagram', TOKEN, '123'))
      .rejects.toBeInstanceOf(ProfileLookupError);
    expect(await full.adapter.fetchPeerProfile('whatsapp', TOKEN, '123')).toBeNull();
    expect(await full.adapter.validateConnection('custom', TOKEN, '123')).toMatchObject({ ok: false, code: 'channel_not_supported' });
  });

  it.each([
    [429, 4, 'profile_rate_limited'],
    [400, 4, 'profile_rate_limited'],
    [400, 80007, 'profile_rate_limited'],
    [401, 190, 'profile_credential_rejected'],
    [400, 190, 'profile_credential_rejected'],
    [403, 10, 'profile_permission_denied'],
    [400, 10, 'profile_permission_denied'],
    [400, 200, 'profile_permission_denied'],
    [503, 1, 'profile_provider_unavailable'],
    [400, 100, 'profile_invalid_request'],
    [400, 1, 'profile_unavailable'],
  ] as const)('classifies profile failure status %i and Graph code %i without leaking details', async (status, code, expected) => {
    const { adapter } = transport(() => graphError(status, code, 'sensitive provider message'));
    await expect(adapter.fetchPeerProfile('messenger', TOKEN, '123'))
      .rejects.toMatchObject({ code: expected, message: expected });
  });

  it('classifies provider errors without a Graph error body', async () => {
    const { adapter } = transport(() => json(400, {}));
    await expect(adapter.fetchPeerProfile('messenger', TOKEN, '123'))
      .rejects.toMatchObject({ code: 'profile_unavailable' });
  });

  it('falls back to the Instagram username if Graph rejects an optional profile field', async () => {
    const { adapter, calls } = transport((call) => call.url.includes('fields=id,name,username')
      ? graphError(400, 100, 'Unsupported field')
      : json(200, { id: '123', username: 'eyad_sofian' }));
    expect(await adapter.fetchPeerProfile('instagram', TOKEN, '123')).toBe('eyad_sofian');
    expect(calls.map((call) => call.url)).toEqual([
      `${GRAPH}/123?fields=id,name,username`,
      `${GRAPH}/123?fields=id,username`,
    ]);
  });

  it('names a Messenger sender from the Page conversation when Graph withholds the profile', async () => {
    const PAGE = '483612954841071';
    const { adapter, calls } = transport((call) => call.url.includes('/conversations?')
      ? json(200, { data: [{ id: 't_1', participants: { data: [
        { id: PAGE, name: 'I BOTS test Page', email: `${PAGE}@facebook.com` },
        { id: '4528904674043162', name: '  Eyad Sofian ', email: '4528904674043162@facebook.com' },
      ] } }] })
      // The answer Graph gives without Business Asset User Profile Access.
      : json(200, {}));
    expect(await adapter.fetchPeerProfile('messenger', TOKEN, '4528904674043162', PAGE)).toBe('Eyad Sofian');
    expect(calls.map((call) => call.url)).toEqual([
      `${GRAPH}/4528904674043162?fields=id,first_name,last_name`,
      `${GRAPH}/${PAGE}/conversations?platform=messenger&user_id=4528904674043162&fields=participants`,
    ]);
    expect(calls[1]?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    [403, 10],
    [400, 100],
    [400, 1],
  ] as const)('asks the Page conversation after a %i/%i profile refusal', async (status, code) => {
    const { adapter } = transport((call) => call.url.includes('/conversations?')
      ? json(200, { data: [{ participants: { data: [{ id: '123', name: 'Mona Adel' }] } }] })
      : graphError(status, code));
    expect(await adapter.fetchPeerProfile('messenger', TOKEN, '123', '999')).toBe('Mona Adel');
  });

  it.each([
    [429, 4, 'profile_rate_limited'],
    [401, 190, 'profile_credential_rejected'],
    [503, 1, 'profile_provider_unavailable'],
  ] as const)('does not spend a second call after a %i/%i refusal the Page conversation would share', async (status, code, expected) => {
    const { adapter, calls } = transport(() => graphError(status, code));
    await expect(adapter.fetchPeerProfile('messenger', TOKEN, '123', '999')).rejects.toMatchObject({ code: expected });
    expect(calls).toHaveLength(1);
  });

  it('uses the Instagram username from the linked Page conversation', async () => {
    const { adapter, calls } = transport((call) => call.url.includes('/conversations?')
      ? json(200, { data: [{ participants: { data: [{ id: '17841400000000001', username: 'school_ig' }, { id: '123', username: ' eyad_sofian ' }] } }] })
      : json(200, { id: '123' }));
    expect(await adapter.fetchPeerProfile('instagram', TOKEN, '123', '999')).toBe('eyad_sofian');
    expect(calls[1]?.url).toBe(`${GRAPH}/999/conversations?platform=instagram&user_id=123&fields=participants`);
  });

  it.each([
    ['no Page id', null, () => json(200, {})],
    ['a malformed Page id', '../me', () => json(200, {})],
  ] as const)('reports the withheld profile when there is %s to ask', async (_label, pageId, responder) => {
    const { adapter, calls } = transport(responder);
    await expect(adapter.fetchPeerProfile('messenger', TOKEN, '123', pageId)).rejects.toMatchObject({ code: 'profile_withheld' });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['the request fails', () => new Error('socket hang up')],
    ['Graph refuses it', () => graphError(403, 10)],
    ['the body is not an object', () => json(200, ['not', 'a', 'page'])],
    ['data is not a list', () => json(200, { data: 'none' })],
    ['participants are malformed', () => json(200, { data: [null, { participants: { data: 'none' } }, { participants: null }] })],
    ['the sender is not a participant', () => json(200, { data: [{ participants: { data: [null, { id: '999', name: 'The Page' }] } }] })],
    ['the participant has no name', () => json(200, { data: [{ participants: { data: [{ id: '123', name: '   ' }] } }] })],
    ['the participant name is not text', () => json(200, { data: [{ participants: { data: [{ id: '123', name: 42 }] } }] })],
    ['the participant name is too long', () => json(200, { data: [{ participants: { data: [{ id: '123', name: 'x'.repeat(201) }] } }] })],
  ] as const)('keeps the profile reason when %s on the Page conversation', async (_label, participants) => {
    const { adapter } = transport((call) => call.url.includes('/conversations?') ? participants() : json(200, {}));
    await expect(adapter.fetchPeerProfile('messenger', TOKEN, '123', '999')).rejects.toMatchObject({ code: 'profile_withheld' });
  });

  it('treats a non-JSON profile answer as withheld and still asks the Page conversation', async () => {
    const { adapter } = transport((call) => call.url.includes('/conversations?')
      ? json(200, { data: [{ participants: { data: [{ id: '123', name: 'Nour' }] } }] })
      : new Response('ok', { status: 200 }));
    expect(await adapter.fetchPeerProfile('messenger', TOKEN, '123', '999')).toBe('Nour');
  });

  it('sends Messenger replies through the Page endpoint and preserves Meta message ids', async () => {
    const { adapter, calls } = transport(() => json(200, { recipient_id: 'psid-1', message_id: 'mid.page.1' }));
    const outcome = await adapter.send('messenger', TOKEN, { ...TEXT, assetIdentity: 'page-1', peerIdentity: 'psid-1' });
    expect(outcome).toMatchObject({ status: 'accepted', providerMessageId: 'mid.page.1' });
    expect(calls[0]).toMatchObject({
      url: `${GRAPH}/page-1/messages`,
      body: { recipient: { id: 'psid-1' }, messaging_type: 'RESPONSE', message: { text: TEXT.text } },
    });
  });

  it('sends Instagram replies through the verified linked Page endpoint', async () => {
    const { adapter, calls } = transport(() => json(200, { recipient_id: 'igsid-1', message_id: 'mid.ig.1' }));
    const outcome = await adapter.send('instagram', TOKEN, { ...TEXT, assetIdentity: 'ig-account-1', facebookPageId: 'page-1', peerIdentity: 'igsid-1' });
    expect(outcome).toMatchObject({ status: 'accepted', providerMessageId: 'mid.ig.1' });
    expect(calls[0]).toMatchObject({
      url: `${GRAPH}/page-1/messages`,
      body: { recipient: { id: 'igsid-1' }, message: { text: TEXT.text } },
    });
    expect(calls[0]?.body).not.toHaveProperty('messaging_type');
  });

  it('preserves emoji-only text in Messenger and Instagram Graph payloads', async () => {
    const { adapter, calls } = transport(() => json(200, { recipient_id: 'test-peer', message_id: 'mid.emoji' }));
    await adapter.send('messenger', TOKEN, { ...TEXT, assetIdentity: 'page-1', peerIdentity: 'test-peer', text: '❤️😀' });
    await adapter.send('instagram', TOKEN, { ...TEXT, assetIdentity: 'ig-1', facebookPageId: 'page-1', peerIdentity: 'test-peer', text: '❤️😀' });
    expect(calls.map((call) => (call.body as { message: { text: string } }).message.text)).toEqual(['❤️😀', '❤️😀']);
  });

  it('validates the configured Page and Instagram assets before the channel is considered connected', async () => {
    const { adapter, calls } = transport((call) => {
      if (call.url.includes('page-1')) return json(200, { id: 'page-1', name: 'I BOTS' });
      return json(200, { id: 'page-1', instagram_business_account: { id: 'ig-account-1' } });
    });
    await expect(adapter.validateConnection('messenger', TOKEN, 'page-1')).resolves.toMatchObject({ ok: true, assetIdentity: 'page-1' });
    await expect(adapter.validateConnection('instagram', TOKEN, 'ig-account-1', 'page-1')).resolves.toMatchObject({ ok: true, assetIdentity: 'ig-account-1' });
    expect(calls.map((call) => call.url)).toEqual([
      `${GRAPH}/me?fields=id`,
      `${GRAPH}/me?fields=id,instagram_business_account{id}`,
    ]);
  });

  it('does not accept a User token that can read the Page but is not Page-scoped', async () => {
    const { adapter, calls } = transport(() => json(200, { id: 'user-1' }));
    await expect(adapter.validateConnection('messenger', TOKEN, 'page-1'))
      .resolves.toMatchObject({ ok: false, code: 'asset_mismatch' });
    expect(calls[0]?.url).toBe(`${GRAPH}/me?fields=id`);
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
    await expect(adapter.send('instagram', TOKEN, { ...TEXT, facebookPageId: 'page-1', text: '' })).resolves.toMatchObject({
      status: 'definitely_rejected', code: 'unsupported_message_type', retryable: false,
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses missing or mismatched linked Pages before marking Instagram ready', async () => {
    const { adapter, calls } = transport(() => json(200, { id: 'page-2', instagram_business_account: { id: 'ig-account-1' } }));
    await expect(adapter.validateConnection('instagram', TOKEN, 'ig-account-1')).resolves.toMatchObject({ ok: false, code: 'instagram_page_required' });
    expect(calls).toHaveLength(0);
    await expect(adapter.validateConnection('instagram', TOKEN, 'ig-account-1', 'page-1')).resolves.toMatchObject({ ok: false, code: 'asset_mismatch' });
    await expect(adapter.send('instagram', TOKEN, { ...TEXT, assetIdentity: 'ig-account-1' })).resolves.toMatchObject({ status: 'definitely_rejected', code: 'instagram_page_required' });
    expect(calls).toHaveLength(1);
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
  it('uses the configured WABA, follows cursors, normalizes statuses and variables', async () => {
    const { adapter, calls } = transport((call) => {
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
    const result = await adapter.fetchTemplates('whatsapp', TOKEN, '12345');
    expect(result).toMatchObject({ ok: true, templates: [
      { providerId: 't-1', status: 'approved', category: 'utility', variables: ['{{1}}', '{{2}}'] },
      { providerId: 't-2', status: 'pending' },
      { providerId: 't-3', status: 'paused' },
      { providerId: 't-4', status: 'disabled' },
      { providerId: 't-5', status: 'rejected' },
    ] });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.url.includes('/12345/message_templates?'))).toBe(true);
    expect(calls.every((call) => call.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('fails safely for unsupported channels, missing WABA IDs, bad pages and Graph failures', async () => {
    const unsupported = transport(() => json(200, {})).adapter;
    expect(await unsupported.fetchTemplates('instagram', TOKEN, 'x')).toMatchObject({ ok: false, code: 'channel_not_supported' });
    expect(await transport(() => json(200, {})).adapter.fetchTemplates('whatsapp', TOKEN, 'x')).toMatchObject({ ok: false, code: 'waba_not_configured' });
    const malformed = transport(() => json(200, { data: null })).adapter;
    expect(await malformed.fetchTemplates('whatsapp', TOKEN, '12345')).toMatchObject({ ok: false, code: 'provider_response_unusable' });
    expect(await transport(() => graphError(401, 190)).adapter.fetchTemplates('whatsapp', TOKEN, '12345')).toMatchObject({ ok: false, code: 'credential_rejected' });
    expect(await transport(() => new TypeError('offline')).adapter.fetchTemplates('whatsapp', TOKEN, '12345')).toMatchObject({ ok: false, code: 'provider_unreachable' });
    expect(await transport(() => new DOMException('late', 'TimeoutError')).adapter.fetchTemplates('whatsapp', TOKEN, '12345')).toMatchObject({ ok: false, code: 'provider_timeout' });
    const pageFailure = transport(() => graphError(503, 2)).adapter;
    expect(await pageFailure.fetchTemplates('whatsapp', TOKEN, '12345')).toMatchObject({ ok: false, retryable: true });
  });

  it('caps pagination rather than looping forever', async () => {
    const { adapter, calls } = transport(() => json(200, { data: [], paging: { cursors: { after: 'again' } } }));
    expect(await adapter.fetchTemplates('whatsapp', TOKEN, '12345')).toMatchObject({ ok: false, code: 'provider_pagination_limit' });
    expect(calls).toHaveLength(20);
  });
});
