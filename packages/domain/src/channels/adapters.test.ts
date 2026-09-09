import { describe, expect, it } from 'vitest';
import { CAPABILITY_MATRICES, capabilitiesFor } from './capabilities.js';
import type { ChannelCrypto } from './crypto.js';
import {
  CUSTOM_SIGNATURE_HEADER,
  CUSTOM_TIMESTAMP_HEADER,
  CustomChannelAdapter,
  negotiateCustomTypes,
} from './custom-channel.js';
import { InstagramAdapter } from './instagram.js';
import { CHANNEL_KINDS } from './kinds.js';
import { MessengerAdapter } from './messenger.js';
import { permitSend } from './policy.js';
import type { ChannelAdapter } from './port.js';
import {
  originAllowed,
  WEB_CHAT_SIGNATURE_HEADER,
  WEB_CHAT_TIMESTAMP_HEADER,
  WebChatAdapter,
} from './web-chat.js';
import { WhatsAppAdapter } from './whatsapp.js';

/**
 * The four adapters added after WhatsApp, and the contract every adapter obeys.
 *
 * The most valuable assertions in this file are the ones about what channels do
 * **not** share. A capability matrix copied between two products is how an
 * Instagram conversation ends up judged by WhatsApp's rules, and no amount of
 * per-adapter unit testing catches that if both adapters were built from the
 * same defaults.
 */

const NOW = new Date('2026-09-09T12:00:00.000Z');

function fakeCrypto(): ChannelCrypto {
  return {
    hmacSha256Hex: (secret, message) =>
      simpleHash(`${secret}|${new TextDecoder().decode(message)}`),
    sha256Hex: (value) => simpleHash(value),
    timingSafeEqualHex: (left, right) => left.length === right.length && left === right,
  };
}

function simpleHash(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < value.length; index += 1) {
    a = Math.imul(a ^ value.charCodeAt(index), 0x01000193) >>> 0;
    b = Math.imul(b + value.charCodeAt(index) * (index + 1), 0x85ebca6b) >>> 0;
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).repeat(4);
}

const crypto = fakeCrypto();

const ADAPTERS: readonly ChannelAdapter[] = [
  new WhatsAppAdapter(crypto),
  new MessengerAdapter(crypto),
  new InstagramAdapter(crypto),
  new WebChatAdapter(crypto),
  new CustomChannelAdapter(crypto),
];

/* ------------------------------------------------------- the port contract -- */

describe('the adapter contract', () => {
  it('is implemented for every channel kind', () => {
    expect(ADAPTERS.map((adapter) => adapter.kind).sort()).toEqual([...CHANNEL_KINDS].sort());
  });

  it('reports one port version, so a widened port is a visible change', () => {
    expect(new Set(ADAPTERS.map((adapter) => adapter.portVersion)).size).toBe(1);
  });

  it('gives each adapter its own matrix, keyed to itself', () => {
    for (const adapter of ADAPTERS) {
      expect(adapter.capabilities().kind).toBe(adapter.kind);
    }
  });

  it('claims exactly one envelope each, and nothing another channel claims', () => {
    const envelopes = [
      { object: 'whatsapp_business_account' },
      { object: 'page' },
      { object: 'instagram' },
      { object: 'web_chat' },
      { object: 'convo_custom' },
    ];
    for (const envelope of envelopes) {
      const claiming = ADAPTERS.filter((adapter) => adapter.claims(envelope));
      // Exactly one, because Meta multiplexes three products over one webhook
      // and two adapters claiming the same body would route by luck.
      expect(claiming).toHaveLength(1);
    }
  });

  it('claims nothing it does not recognise', () => {
    for (const payload of [null, 'nope', {}, { object: 'telegram' }, []]) {
      expect(ADAPTERS.filter((adapter) => adapter.claims(payload))).toHaveLength(0);
    }
  });

  it('answers normalize totally, however broken the payload', () => {
    for (const adapter of ADAPTERS) {
      for (const payload of [null, 'nope', 42, [], {}]) {
        const batch = adapter.normalize(payload, NOW);
        // Never throws, and never silently produces nothing at all: an
        // unreadable delivery is quarantined evidence.
        expect(batch.events).toEqual([]);
        expect(batch.quarantined.length).toBeGreaterThan(0);
      }
    }
  });

  it('never lets two channels produce the same dedupe key for the same id', () => {
    // Ids are provider-scoped, so `m1` on Messenger and `m1` on Instagram are
    // different messages. A shared key prefix would make the second look like a
    // duplicate of the first and drop a real customer message.
    const keys = new Set<string>();
    const messenger = new MessengerAdapter(crypto).normalize(messengerMessage('m1', 'hi'), NOW);
    const instagram = new InstagramAdapter(crypto).normalize(instagramMessage('m1', 'hi'), NOW);
    for (const event of [...messenger.events, ...instagram.events]) {
      keys.add(event.dedupeKey);
    }
    expect(keys.size).toBe(2);
  });
});

/* --------------------------------------------------- cross-channel policy -- */

describe('channel policies do not leak into one another', () => {
  const base = {
    messageType: 'text',
    isPrivateNote: false,
    text: 'hello',
    lastInboundAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    now: NOW,
    consentWithdrawn: false,
  } as const;

  it('refuses a WhatsApp template on every other channel', () => {
    for (const kind of ['messenger', 'instagram', 'web_chat', 'custom'] as const) {
      expect(
        permitSend({
          ...base,
          kind,
          capabilities: capabilitiesFor(kind),
          template: { name: 'order_update', kind: 'whatsapp' },
        }),
      ).toMatchObject({ allowed: false, reason: 'template_not_applicable' });
    }
  });

  it('keeps the reply window a per-channel fact', () => {
    const stale = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    // WhatsApp offers a template path out of a closed window; Instagram does
    // not; our own channels have no window at all.
    expect(
      permitSend({ ...base, kind: 'whatsapp', capabilities: capabilitiesFor('whatsapp'), lastInboundAt: stale, template: null }),
    ).toMatchObject({ reason: 'template_required' });
    expect(
      permitSend({ ...base, kind: 'instagram', capabilities: capabilitiesFor('instagram'), lastInboundAt: stale, template: null }),
    ).toMatchObject({ reason: 'window_expired' });
    expect(
      permitSend({ ...base, kind: 'web_chat', capabilities: capabilitiesFor('web_chat'), lastInboundAt: null, template: null }),
    ).toMatchObject({ allowed: true });
  });

  it('keeps text limits per channel, in both units', () => {
    // 600 Arabic characters is 1200 bytes: inside Messenger's 2000 and outside
    // Instagram's 1000, from the same string.
    const arabic = 'م'.repeat(600);
    expect(
      permitSend({ ...base, kind: 'messenger', capabilities: capabilitiesFor('messenger'), text: arabic, template: null }),
    ).toMatchObject({ allowed: true });
    expect(
      permitSend({ ...base, kind: 'instagram', capabilities: capabilitiesFor('instagram'), text: arabic, template: null }),
    ).toMatchObject({ allowed: false, reason: 'text_too_long' });
  });

  it('keeps outbound types per channel', () => {
    // Instagram carries text and images; WhatsApp carries documents too.
    expect(
      permitSend({ ...base, kind: 'instagram', capabilities: capabilitiesFor('instagram'), messageType: 'document', template: null }),
    ).toMatchObject({ allowed: false, reason: 'not_supported' });
    expect(
      permitSend({ ...base, kind: 'whatsapp', capabilities: capabilitiesFor('whatsapp'), messageType: 'document', template: null }),
    ).toMatchObject({ allowed: true });
  });

  it('declares read receipts as unavailable rather than false where unsupported', () => {
    // ADR-0009: absent support renders `not_available`, never `0%`.
    expect(CAPABILITY_MATRICES.instagram.readReceipts).toBe(false);
    expect(CAPABILITY_MATRICES.custom.deliveryReceipts).toBe(false);
    expect(CAPABILITY_MATRICES.whatsapp.readReceipts).toBe(true);
  });
});

/* ---------------------------------------------------------------- fixtures -- */

function messengerMessage(mid: string, text: string): Record<string, unknown> {
  return {
    object: 'page',
    entry: [
      {
        id: 'page-1',
        time: 1789000000000,
        messaging: [
          {
            sender: { id: 'psid-1' },
            recipient: { id: 'page-1' },
            timestamp: 1789000000000,
            message: { mid, text },
          },
        ],
      },
    ],
  };
}

function instagramMessage(mid: string, text: string): Record<string, unknown> {
  return {
    object: 'instagram',
    entry: [
      {
        id: 'ig-1',
        time: 1789000000000,
        messaging: [
          {
            sender: { id: 'igsid-1' },
            recipient: { id: 'ig-1' },
            timestamp: 1789000000000,
            message: { mid, text },
          },
        ],
      },
    ],
  };
}

function messengerItem(item: Record<string, unknown>): Record<string, unknown> {
  return {
    object: 'page',
    entry: [
      {
        id: 'page-1',
        messaging: [
          { sender: { id: 'psid-1' }, recipient: { id: 'page-1' }, timestamp: 1789000000000, ...item },
        ],
      },
    ],
  };
}

/* --------------------------------------------------------------- messenger -- */

describe('MessengerAdapter', () => {
  const adapter = new MessengerAdapter(crypto);

  it('normalizes a text message and reads the Page as the asset', () => {
    const batch = adapter.normalize(messengerMessage('mid.1', 'مرحبا'), NOW);
    expect(batch.assetId).toBe('page-1');
    expect(batch.events[0]).toMatchObject({
      kind: 'message',
      dedupeKey: 'mg:msg:mid.1',
      providerMessageId: 'mid.1',
      peerIdentity: 'psid-1',
      assetIdentity: 'page-1',
      text: 'مرحبا',
    });
    // Meta's messaging products send milliseconds, unlike WhatsApp's seconds.
    expect(batch.events[0]?.occurredAt.toISOString()).toBe('2026-09-10T00:26:40.000Z');
  });

  it('turns one delivery receipt naming several ids into several facts', () => {
    const batch = adapter.normalize(
      messengerItem({ delivery: { mids: ['mid.a', 'mid.b'], watermark: 1789000000000 } }),
      NOW,
    );
    // Flattening it to one would silently drop every receipt but the first.
    expect(batch.events.map((event) => event.providerMessageId)).toEqual(['mid.a', 'mid.b']);
    expect(batch.events.every((event) => event.kind === 'delivery_status')).toBe(true);
  });

  it('keys a read receipt on its watermark, not on a message id', () => {
    const batch = adapter.normalize(messengerItem({ read: { watermark: 1789000000000 } }), NOW);
    expect(batch.events[0]).toMatchObject({
      kind: 'read_status',
      // A watermark says "everything before this"; pretending it names one
      // message would attach it to the wrong one.
      providerMessageId: null,
      dedupeKey: 'mg:read:psid-1:1789000000000',
    });
  });

  it('normalizes a postback as a message an agent can read', () => {
    const batch = adapter.normalize(
      messengerItem({ postback: { mid: 'mid.p', title: 'Track my order', payload: 'TRACK' } }),
      NOW,
    );
    expect(batch.events[0]).toMatchObject({
      kind: 'message',
      contentType: 'postback',
      text: 'Track my order',
      detail: { payload: 'TRACK' },
    });
  });

  it('keys a postback with no id on its sender and moment', () => {
    const batch = adapter.normalize(messengerItem({ postback: { payload: 'TRACK' } }), NOW);
    expect(batch.events[0]?.dedupeKey).toBe('mg:postback:psid-1:1789000000000');
  });

  it('marks an echo of our own message as not an inbound message', () => {
    const batch = adapter.normalize(
      messengerItem({ message: { mid: 'mid.e', text: 'our reply', is_echo: true } }),
      NOW,
    );
    // A real event, and not one to show as something the customer typed.
    expect(batch.events[0]).toMatchObject({ kind: 'unsupported', eventType: 'messaging.echo' });
  });

  it('normalizes an attachment into its handle', () => {
    const batch = adapter.normalize(
      messengerItem({
        message: {
          mid: 'mid.a',
          attachments: [{ type: 'image', payload: { url: 'https://cdn.example/x.jpg' } }],
        },
      }),
      NOW,
    );
    expect(batch.events[0]?.attachments).toEqual([
      { type: 'image', providerId: 'https://cdn.example/x.jpg', mimeType: null, caption: null },
    ]);
  });

  it('skips an attachment with no type and keeps one with no url', () => {
    const batch = adapter.normalize(
      messengerItem({
        message: {
          mid: 'mid.b',
          attachments: [{ payload: { url: 'https://cdn.example/y.jpg' } }, { type: 'file' }, 'nope'],
        },
      }),
      NOW,
    );
    expect(batch.events[0]?.attachments).toEqual([
      { type: 'file', providerId: '', mimeType: null, caption: null },
    ]);
  });

  it('leaves the asset identity empty when an entry names no id', () => {
    const batch = adapter.normalize(
      {
        object: 'page',
        entry: [
          {
            messaging: [
              {
                sender: { id: 'p' },
                recipient: { id: 'page-1' },
                timestamp: 1789000000000,
                message: { mid: 'm', text: 'x' },
              },
            ],
          },
        ],
      },
      NOW,
    );
    // The batch then has no asset at all, so the ingress refuses to route it —
    // but the normalizer still answers rather than throwing.
    expect(batch.assetId).toBeNull();
    expect(batch.events[0]?.assetIdentity).toBe('');
  });

  it('records a delivery receipt with no watermark', () => {
    const batch = adapter.normalize(messengerItem({ delivery: { mids: ['mid.w'] } }), NOW);
    expect(batch.events[0]?.detail).toEqual({ watermark: null });
  });

  it('quarantines a postback carrying neither an id nor a payload', () => {
    const batch = adapter.normalize(messengerItem({ postback: { title: 'Just a title' } }), NOW);
    expect(batch.events).toEqual([]);
    expect(batch.quarantined[0]?.reason).toBe('unsupported_messaging_item');
  });

  it.each([
    ['an entry with no messaging array', { object: 'page', entry: [{ id: 'page-1' }] }, 'entry_has_no_messaging'],
    [
      'an item with no participants',
      { object: 'page', entry: [{ id: 'page-1', messaging: [{ timestamp: 1 }] }] },
      'messaging_missing_participants',
    ],
  ])('quarantines %s', (_label, payload, reason) => {
    const batch = adapter.normalize(payload, NOW);
    expect(batch.quarantined[0]?.reason).toBe(reason);
  });

  it.each([
    ['a message with no mid', { message: { text: 'x' } }],
    ['a delivery with no ids', { delivery: { mids: [] } }],
    ['a read with no watermark', { read: {} }],
    ['an item that is none of the above', { referral: { ref: 'x' } }],
  ])('quarantines %s rather than dropping it', (_label, item) => {
    const batch = adapter.normalize(messengerItem(item), NOW);
    expect(batch.events).toEqual([]);
    expect(batch.quarantined[0]?.reason).toBe('unsupported_messaging_item');
  });

  it('falls back to the receipt time when the timestamp is unusable', () => {
    const batch = adapter.normalize(
      {
        object: 'page',
        entry: [
          {
            id: 'page-1',
            messaging: [
              { sender: { id: 'p' }, recipient: { id: 'page-1' }, message: { mid: 'm', text: 'x' } },
            ],
          },
        ],
      },
      NOW,
    );
    expect(batch.events[0]?.occurredAt).toEqual(NOW);
  });

  it('records a message with neither text nor attachments as unsupported', () => {
    const batch = adapter.normalize(messengerItem({ message: { mid: 'mid.q' } }), NOW);
    expect(batch.events[0]).toMatchObject({ kind: 'unsupported', contentType: 'unknown' });
  });

  it('refuses another product’s envelope', () => {
    const batch = adapter.normalize({ object: 'instagram', entry: [] }, NOW);
    expect(batch.quarantined[0]?.reason).toBe('not_a_page_envelope');
  });

  it('answers the shared Meta challenge and signature', () => {
    const body = new TextEncoder().encode('{}');
    expect(
      adapter.verifySignature({
        rawBody: body,
        headers: { 'x-hub-signature-256': `sha256=${crypto.hmacSha256Hex('s', body)}` },
        secret: 's',
        now: NOW,
      }),
    ).toEqual({ valid: true });
    expect(
      adapter.verifyChallenge(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 't', 'hub.challenge': 'c' },
        crypto.sha256Hex('t'),
      ),
    ).toBe('c');
  });
});

/* --------------------------------------------------------------- instagram -- */

describe('InstagramAdapter', () => {
  const adapter = new InstagramAdapter(crypto);

  it('normalizes a DM and reads the professional account as the asset', () => {
    const batch = adapter.normalize(instagramMessage('ig.1', 'أهلًا'), NOW);
    expect(batch.assetId).toBe('ig-1');
    expect(batch.events[0]).toMatchObject({
      kind: 'message',
      dedupeKey: 'ig:msg:ig.1',
      peerIdentity: 'igsid-1',
      text: 'أهلًا',
    });
  });

  it('normalizes a reaction as its own kind, not as a message', () => {
    const batch = adapter.normalize(
      {
        object: 'instagram',
        entry: [
          {
            id: 'ig-1',
            messaging: [
              {
                sender: { id: 'igsid-1' },
                recipient: { id: 'ig-1' },
                timestamp: 1789000000000,
                reaction: { mid: 'ig.1', action: 'react', emoji: '❤️', reaction: 'love' },
              },
            ],
          },
        ],
      },
      NOW,
    );
    // Showing a heart as an inbound message would put it in the transcript as
    // if the customer had typed one.
    expect(batch.events[0]).toMatchObject({
      kind: 'reaction',
      eventType: 'messaging.reaction.react',
      dedupeKey: 'ig:reaction:ig.1:react:igsid-1',
      text: '❤️',
    });
  });

  it('keeps reacting and un-reacting as two facts', () => {
    const react = adapter.normalize(reactionPayload('react'), NOW).events[0];
    const unreact = adapter.normalize(reactionPayload('unreact'), NOW).events[0];
    expect(react?.dedupeKey).not.toBe(unreact?.dedupeKey);
  });

  it('defaults a reaction with no action to react', () => {
    const batch = adapter.normalize(reactionPayload(undefined), NOW);
    expect(batch.events[0]?.eventType).toBe('messaging.reaction.react');
  });

  it('quarantines a reaction with no message id', () => {
    const batch = adapter.normalize(
      {
        object: 'instagram',
        entry: [
          {
            id: 'ig-1',
            messaging: [
              { sender: { id: 's' }, recipient: { id: 'ig-1' }, reaction: { action: 'react' } },
            ],
          },
        ],
      },
      NOW,
    );
    expect(batch.quarantined[0]?.reason).toBe('unsupported_messaging_item');
  });

  it('verifies the shared Meta signature and challenge on its own account', () => {
    // Shared implementation, separately exercised: an adapter that forgot to
    // wire one of these would otherwise be caught by nothing.
    const body = new TextEncoder().encode('{}');
    expect(
      adapter.verifySignature({
        rawBody: body,
        headers: { 'x-hub-signature-256': `sha256=${crypto.hmacSha256Hex('s', body)}` },
        secret: 's',
        now: NOW,
      }),
    ).toEqual({ valid: true });
    expect(
      adapter.verifyChallenge(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 't', 'hub.challenge': 'c' },
        crypto.sha256Hex('t'),
      ),
    ).toBe('c');
  });

  it('quarantines an item that is neither a message nor a reaction', () => {
    const batch = adapter.normalize(
      {
        object: 'instagram',
        entry: [
          {
            id: 'ig-1',
            messaging: [{ sender: { id: 's' }, recipient: { id: 'ig-1' }, referral: { ref: 'x' } }],
          },
        ],
      },
      NOW,
    );
    expect(batch.quarantined[0]?.reason).toBe('unsupported_messaging_item');
  });

  it('refuses a Messenger envelope', () => {
    expect(adapter.normalize({ object: 'page', entry: [] }, NOW).quarantined[0]?.reason).toBe(
      'not_a_instagram_envelope',
    );
  });

  function reactionPayload(action: string | undefined): Record<string, unknown> {
    return {
      object: 'instagram',
      entry: [
        {
          id: 'ig-1',
          messaging: [
            {
              sender: { id: 'igsid-1' },
              recipient: { id: 'ig-1' },
              timestamp: 1789000000000,
              reaction: { mid: 'ig.9', emoji: '❤️', ...(action === undefined ? {} : { action }) },
            },
          ],
        },
      ],
    };
  }
});

/* --------------------------------------------------------------- web chat -- */

describe('WebChatAdapter', () => {
  const adapter = new WebChatAdapter(crypto);
  const secret = 'installation-signing-key';

  function signed(body: string, timestamp: string): Record<string, string> {
    return {
      [WEB_CHAT_SIGNATURE_HEADER]: `v1=${crypto.hmacSha256Hex(secret, new TextEncoder().encode(`${timestamp}.${body}`))}`,
      [WEB_CHAT_TIMESTAMP_HEADER]: timestamp,
    };
  }

  const stamp = String(Math.floor(NOW.getTime() / 1000));

  it('verifies a signature over the timestamp and the exact bytes', () => {
    const body = '{"object":"web_chat"}';
    expect(
      adapter.verifySignature({
        rawBody: new TextEncoder().encode(body),
        headers: signed(body, stamp),
        secret,
        now: NOW,
      }),
    ).toEqual({ valid: true });
  });

  it('refuses a body that was altered after signing', () => {
    const body = '{"object":"web_chat"}';
    expect(
      adapter.verifySignature({
        rawBody: new TextEncoder().encode('{"object":"web_chaT"}'),
        headers: signed(body, stamp),
        secret,
        now: NOW,
      }),
    ).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('refuses a replay outside the window, and a rewritten timestamp with it', () => {
    const body = '{"object":"web_chat"}';
    const old = String(Math.floor(NOW.getTime() / 1000) - 3600);
    expect(
      adapter.verifySignature({
        rawBody: new TextEncoder().encode(body),
        headers: signed(body, old),
        secret,
        now: NOW,
      }),
    ).toEqual({ valid: false, reason: 'stale' });
    // The timestamp is inside the signed material, so moving it forward to make
    // an old capture look fresh breaks the signature instead.
    expect(
      adapter.verifySignature({
        rawBody: new TextEncoder().encode(body),
        headers: { ...signed(body, old), [WEB_CHAT_TIMESTAMP_HEADER]: stamp },
        secret,
        now: NOW,
      }),
    ).toEqual({ valid: false, reason: 'mismatch' });
  });

  it.each([
    ['no signature', {}, 'missing_header'],
    ['an empty signature', { [WEB_CHAT_SIGNATURE_HEADER]: '' }, 'missing_header'],
    ['another scheme', { [WEB_CHAT_SIGNATURE_HEADER]: 'sha256=abc' }, 'unsupported_algorithm'],
    ['a short digest', { [WEB_CHAT_SIGNATURE_HEADER]: 'v1=abc' }, 'malformed_header'],
    [
      'no timestamp',
      { [WEB_CHAT_SIGNATURE_HEADER]: `v1=${'a'.repeat(64)}` },
      'malformed_header',
    ],
    [
      'a non-numeric timestamp',
      { [WEB_CHAT_SIGNATURE_HEADER]: `v1=${'a'.repeat(64)}`, [WEB_CHAT_TIMESTAMP_HEADER]: 'now' },
      'malformed_header',
    ],
  ])('refuses %s', (_label, headers, reason) => {
    expect(
      adapter.verifySignature({
        rawBody: new TextEncoder().encode('{}'),
        headers,
        secret,
        now: NOW,
      }),
    ).toEqual({ valid: false, reason });
  });

  it('has no subscription handshake to answer', () => {
    // Total rather than throwing: every adapter answers the same question, and
    // this one's honest answer is "not applicable".
    expect(adapter.verifyChallenge()).toBeNull();
  });

  it('normalizes a visitor message keyed on the session', () => {
    const batch = adapter.normalize(
      {
        object: 'web_chat',
        installation_id: 'inst-1',
        events: [
          {
            id: 'wc.1',
            session_id: 'sess-1',
            type: 'message',
            text: 'أحتاج مساعدة',
            occurred_at: '2026-09-09T11:00:00.000Z',
          },
        ],
      },
      NOW,
    );
    expect(batch.assetId).toBe('inst-1');
    expect(batch.events[0]).toMatchObject({
      kind: 'message',
      dedupeKey: 'wc:msg:wc.1',
      // A visitor has no account: the session is the identity.
      peerIdentity: 'sess-1',
      text: 'أحتاج مساعدة',
    });
    expect(batch.events[0]?.occurredAt.toISOString()).toBe('2026-09-09T11:00:00.000Z');
  });

  it('normalizes a session start as an identity event', () => {
    const batch = adapter.normalize(
      {
        object: 'web_chat',
        installation_id: 'inst-1',
        events: [
          {
            id: 'wc.2',
            session_id: 'sess-2',
            type: 'session_start',
            page_url: 'https://school.example/apply',
            locale: 'ar',
          },
        ],
      },
      NOW,
    );
    expect(batch.events[0]).toMatchObject({
      kind: 'identity_change',
      detail: { page: 'https://school.example/apply', locale: 'ar' },
    });
    expect(batch.events[0]?.occurredAt).toEqual(NOW);
  });

  it('records a message with no text as unsupported rather than dropping it', () => {
    const batch = adapter.normalize(
      { object: 'web_chat', installation_id: 'i', events: [{ id: 'a', session_id: 's', type: 'message' }] },
      NOW,
    );
    expect(batch.events[0]?.kind).toBe('unsupported');
  });

  it.each([
    ['an event with no id', { session_id: 's', type: 'message' }, 'event_missing_fields'],
    ['an event with no session', { id: 'a', type: 'message' }, 'event_missing_fields'],
    ['a type we do not serve', { id: 'a', session_id: 's', type: 'typing' }, 'unsupported_event_type'],
  ])('quarantines %s', (_label, event, reason) => {
    const batch = adapter.normalize(
      { object: 'web_chat', installation_id: 'i', events: [event] },
      NOW,
    );
    expect(batch.quarantined[0]?.reason).toBe(reason);
  });

  it('falls back on an unparsable occurred_at', () => {
    const batch = adapter.normalize(
      {
        object: 'web_chat',
        installation_id: 'i',
        events: [{ id: 'a', session_id: 's', type: 'message', text: 'x', occurred_at: 'soon' }],
      },
      NOW,
    );
    expect(batch.events[0]?.occurredAt).toEqual(NOW);
  });

  it('leaves the asset empty when the envelope names no installation', () => {
    const batch = adapter.normalize(
      {
        object: 'web_chat',
        events: [
          { id: 'a', session_id: 's', type: 'message', text: 'x' },
          { id: 'b', session_id: 's', type: 'session_start' },
        ],
      },
      NOW,
    );
    expect(batch.assetId).toBeNull();
    expect(batch.events.every((event) => event.assetIdentity === '')).toBe(true);
  });

  it('refuses another channel’s envelope', () => {
    expect(adapter.normalize({ object: 'page' }, NOW).quarantined[0]?.reason).toBe(
      'not_a_web_chat_envelope',
    );
  });
});

describe('originAllowed', () => {
  it('matches a declared origin exactly', () => {
    expect(originAllowed('https://school.example', ['https://school.example'])).toBe(true);
  });

  it('does not match a lookalike host', () => {
    // A `endsWith` comparison would accept this, which is the classic way an
    // allowlist becomes decoration.
    expect(originAllowed('https://evil-school.example', ['https://school.example'])).toBe(false);
    expect(originAllowed('https://school.example.evil.test', ['https://school.example'])).toBe(false);
  });

  it('refuses when nothing is declared, and when no origin is sent', () => {
    // An installation that declared no origins is not finished being
    // configured; the honest reading of that is no.
    expect(originAllowed('https://school.example', [])).toBe(false);
    expect(originAllowed(undefined, ['https://school.example'])).toBe(false);
  });
});

/* ---------------------------------------------------------- custom channel -- */

describe('CustomChannelAdapter', () => {
  const adapter = new CustomChannelAdapter(crypto);
  const secret = 'operator-signing-key';
  const stamp = String(Math.floor(NOW.getTime() / 1000));

  function signed(body: string): Record<string, string> {
    return {
      [CUSTOM_SIGNATURE_HEADER]: `v1=${crypto.hmacSha256Hex(secret, new TextEncoder().encode(`${stamp}.${body}`))}`,
      [CUSTOM_TIMESTAMP_HEADER]: stamp,
    };
  }

  it('verifies its own signature scheme', () => {
    const body = '{"object":"convo_custom"}';
    expect(
      adapter.verifySignature({
        rawBody: new TextEncoder().encode(body),
        headers: signed(body),
        secret,
        now: NOW,
      }),
    ).toEqual({ valid: true });
  });

  it.each([
    ['no signature', {}, 'missing_header'],
    ['another scheme', { [CUSTOM_SIGNATURE_HEADER]: 'sha256=x' }, 'unsupported_algorithm'],
    ['a short digest', { [CUSTOM_SIGNATURE_HEADER]: 'v1=abc' }, 'malformed_header'],
    ['no timestamp', { [CUSTOM_SIGNATURE_HEADER]: `v1=${'a'.repeat(64)}` }, 'malformed_header'],
  ])('refuses %s', (_label, headers, reason) => {
    expect(
      adapter.verifySignature({
        rawBody: new TextEncoder().encode('{}'),
        headers,
        secret,
        now: NOW,
      }),
    ).toEqual({ valid: false, reason });
  });

  it('refuses a stale delivery and a wrong key', () => {
    const body = '{}';
    const old = String(Math.floor(NOW.getTime() / 1000) - 3600);
    expect(
      adapter.verifySignature({
        rawBody: new TextEncoder().encode(body),
        headers: {
          [CUSTOM_SIGNATURE_HEADER]: `v1=${crypto.hmacSha256Hex(secret, new TextEncoder().encode(`${old}.${body}`))}`,
          [CUSTOM_TIMESTAMP_HEADER]: old,
        },
        secret,
        now: NOW,
      }),
    ).toEqual({ valid: false, reason: 'stale' });
    expect(
      adapter.verifySignature({
        rawBody: new TextEncoder().encode(body),
        headers: signed(body),
        secret: 'somebody-elses-key',
        now: NOW,
      }),
    ).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('has no handshake', () => {
    expect(adapter.verifyChallenge()).toBeNull();
  });

  it('normalizes a message from a documented version', () => {
    const batch = adapter.normalize(
      {
        object: 'convo_custom',
        version: '1',
        asset_id: 'gateway-1',
        events: [
          {
            id: 'cc.1',
            from: '+201000000000',
            type: 'message',
            text: 'رسالة',
            content_type: 'text',
            occurred_at: '2026-09-09T10:00:00.000Z',
          },
        ],
      },
      NOW,
    );
    expect(batch.assetId).toBe('gateway-1');
    expect(batch.events[0]).toMatchObject({
      kind: 'message',
      dedupeKey: 'cc:msg:cc.1',
      peerIdentity: '+201000000000',
      text: 'رسالة',
    });
  });

  it('normalizes the operator’s own delivery and read reports', () => {
    const batch = adapter.normalize(
      {
        object: 'convo_custom',
        version: '1',
        asset_id: 'gateway-1',
        events: [
          { id: 'cc.2', from: '+2010', type: 'delivery_status', message_id: 'out.1' },
          { id: 'cc.3', from: '+2010', type: 'read_status', message_id: 'out.1' },
        ],
      },
      NOW,
    );
    expect(batch.events.map((event) => event.kind)).toEqual(['delivery_status', 'read_status']);
    expect(batch.events.every((event) => event.providerMessageId === 'out.1')).toBe(true);
  });

  it('falls back to the event id when no message id is given', () => {
    const batch = adapter.normalize(
      {
        object: 'convo_custom',
        version: '1',
        asset_id: 'g',
        events: [{ id: 'cc.4', from: '+2010', type: 'delivery_status' }],
      },
      NOW,
    );
    expect(batch.events[0]?.providerMessageId).toBe('cc.4');
  });

  it.each([
    ['a version we do not implement', '2'],
    ['no version at all', undefined],
  ])('quarantines a payload with %s, whole', (_label, version) => {
    const batch = adapter.normalize(
      {
        object: 'convo_custom',
        asset_id: 'g',
        events: [{ id: 'a', from: 'b', type: 'message', text: 'x' }],
        ...(version === undefined ? {} : { version }),
      },
      NOW,
    );
    // Kept whole so it can be replayed once that version is supported, rather
    // than parsed hopefully against a contract it was not written for.
    expect(batch.events).toEqual([]);
    expect(batch.quarantined[0]?.reason).toBe(
      `unsupported_contract_version:${version ?? 'absent'}`,
    );
    // The asset is still readable, so the delivery can still be attributed.
    expect(batch.assetId).toBe('g');
  });

  it.each([
    ['an event missing fields', { id: 'a' }, 'event_missing_fields'],
    [
      'an event type outside the contract',
      { id: 'a', from: 'b', type: 'presence' },
      'unsupported_event_type',
    ],
  ])('quarantines %s', (_label, event, reason) => {
    const batch = adapter.normalize(
      { object: 'convo_custom', version: '1', asset_id: 'g', events: [event] },
      NOW,
    );
    expect(batch.quarantined[0]?.reason).toBe(reason);
  });

  it('records a message with no text as unsupported', () => {
    const batch = adapter.normalize(
      { object: 'convo_custom', version: '1', asset_id: 'g', events: [{ id: 'a', from: 'b', type: 'message' }] },
      NOW,
    );
    expect(batch.events[0]?.kind).toBe('unsupported');
  });

  it('falls back on an unparsable occurred_at', () => {
    const batch = adapter.normalize(
      {
        object: 'convo_custom',
        version: '1',
        asset_id: 'g',
        events: [{ id: 'a', from: 'b', type: 'message', text: 'x', occurred_at: 'later' }],
      },
      NOW,
    );
    expect(batch.events[0]?.occurredAt).toEqual(NOW);
  });

  it('leaves the asset empty when the envelope names none', () => {
    const batch = adapter.normalize(
      {
        object: 'convo_custom',
        version: '1',
        events: [
          { id: 'a', from: 'b', type: 'message', text: 'x' },
          { id: 'c', from: 'b', type: 'delivery_status' },
        ],
      },
      NOW,
    );
    expect(batch.assetId).toBeNull();
    expect(batch.events.every((event) => event.assetIdentity === '')).toBe(true);
  });

  it('refuses another channel’s envelope', () => {
    expect(adapter.normalize({ object: 'web_chat' }, NOW).quarantined[0]?.reason).toBe(
      'not_a_custom_envelope',
    );
  });
});

describe('negotiateCustomTypes', () => {
  it('intersects what the operator declared with what the matrix allows', () => {
    const matrix = capabilitiesFor('custom');
    expect(negotiateCustomTypes(['text'], matrix)).toEqual(['text']);
  });

  it('does not let a declaration widen the matrix', () => {
    // Declaring something the ceiling does not have adds nothing: the
    // intersection is what is offered.
    expect(negotiateCustomTypes(['text', 'video'], capabilitiesFor('custom'))).toEqual(['text']);
    expect(negotiateCustomTypes([], capabilitiesFor('custom'))).toEqual([]);
  });
});
