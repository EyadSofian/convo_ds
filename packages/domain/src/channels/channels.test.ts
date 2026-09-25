import { describe, expect, it } from 'vitest';
import { CAPABILITY_MATRICES, capabilitiesFor, measureText, utf8Length } from './capabilities.js';
import type { ChannelCrypto } from './crypto.js';
import {
  CHANNEL_KINDS,
  EVIDENCE_KINDS,
  isChannelKind,
  missingEvidence,
  PROVIDER_OF,
  readinessOf,
} from './kinds.js';
import type { EvidenceRecord } from './kinds.js';
import { answerMetaChallenge, REPLAY_WINDOW_SECONDS, verifyMetaSignature } from './meta-signature.js';
import {
  classifyOutcome,
  COMMAND_STATES,
  DELIVERY_STATES,
  foldDelivery,
  mayAutoRetry,
} from './outcome.js';
import type { CommandState, DeliveryFold } from './outcome.js';
import { permitSend } from './policy.js';
import type { SendRequest } from './policy.js';
import { WhatsAppAdapter } from './whatsapp.js';

/* ------------------------------------------------------------------ setup -- */

/**
 * A deterministic stand-in for the crypto port.
 *
 * The real HMAC is asserted in `apps/api/src/channels/node-crypto.test.ts`
 * against known vectors; what matters here is that the adapter asks the port
 * rather than comparing digests itself, and that a mismatch is a refusal.
 */
function fakeCrypto(): ChannelCrypto {
  return {
    hmacSha256Hex: (secret, message) =>
      simpleHash(`${secret}|${Buffer.from(message).toString('utf8')}`),
    sha256Hex: (value) => simpleHash(value),
    timingSafeEqualHex: (left, right) => left.length === right.length && left === right,
  };
}

/** A 64-hex digest that is stable and collision-free enough for a test. */
function simpleHash(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < value.length; index += 1) {
    a = Math.imul(a ^ value.charCodeAt(index), 0x01000193) >>> 0;
    b = Math.imul(b + value.charCodeAt(index) * (index + 1), 0x85ebca6b) >>> 0;
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).repeat(4);
}

const NOW = new Date('2026-09-09T12:00:00.000Z');

/* ------------------------------------------------------------------ kinds -- */

describe('channel kinds', () => {
  it('narrows an untrusted string', () => {
    expect(isChannelKind('whatsapp')).toBe(true);
    expect(isChannelKind('meta')).toBe(false);
    expect(isChannelKind('')).toBe(false);
  });

  it('maps every kind to exactly one provider', () => {
    for (const kind of CHANNEL_KINDS) {
      expect(PROVIDER_OF[kind]).toBeDefined();
    }
    // The three Meta channels share a provider and nothing else.
    expect(PROVIDER_OF.whatsapp).toBe('meta');
    expect(PROVIDER_OF.messenger).toBe('meta');
    expect(PROVIDER_OF.instagram).toBe('meta');
  });
});

describe('readiness', () => {
  const none: EvidenceRecord = {
    asset_verified: false,
    credential_verified: false,
    webhook_subscribed: false,
    first_inbound: false,
    first_outbound: false,
  };
  const all: EvidenceRecord = {
    asset_verified: true,
    credential_verified: true,
    webhook_subscribed: true,
    first_inbound: true,
    first_outbound: true,
  };

  it('needs every piece of evidence before it says healthy', () => {
    expect(readinessOf({ evidence: all, disconnected: false, hasError: false })).toBe('healthy');
    // Remove any one of the four that gate it and it is no longer healthy.
    expect(
      readinessOf({
        evidence: { ...all, first_inbound: false },
        disconnected: false,
        hasError: false,
      }),
    ).toBe('webhook_pending');
    expect(
      readinessOf({
        evidence: { ...all, webhook_subscribed: false },
        disconnected: false,
        hasError: false,
      }),
    ).toBe('webhook_pending');
  });

  it('names the first missing piece, so an operator knows what to do next', () => {
    expect(readinessOf({ evidence: none, disconnected: false, hasError: false })).toBe(
      'not_configured',
    );
    expect(
      readinessOf({
        evidence: { ...none, asset_verified: true },
        disconnected: false,
        hasError: false,
      }),
    ).toBe('authorization_needed');
  });

  it('reports an error only once the thing was configured and authorized', () => {
    // A failure before authorization is not "degraded": there was nothing
    // working to degrade, and telling the operator to investigate would be
    // wrong when what they need is to finish connecting.
    expect(readinessOf({ evidence: none, disconnected: false, hasError: true })).toBe(
      'not_configured',
    );
    expect(
      readinessOf({
        evidence: { ...all, first_inbound: false },
        disconnected: false,
        hasError: true,
      }),
    ).toBe('degraded');
  });

  it('lets disconnected outrank everything, including an error', () => {
    expect(readinessOf({ evidence: all, disconnected: true, hasError: true })).toBe('disconnected');
  });

  it('lists what is still missing', () => {
    expect(missingEvidence(all)).toEqual([]);
    expect(missingEvidence(none)).toEqual([...EVIDENCE_KINDS]);
  });
});

/* ----------------------------------------------------------- capabilities -- */

describe('capability matrices', () => {
  it('gives every kind its own matrix', () => {
    for (const kind of CHANNEL_KINDS) {
      expect(capabilitiesFor(kind).kind).toBe(kind);
    }
  });

  it('keeps templates a WhatsApp concept', () => {
    // The single most important line in the matrix: if Messenger or Instagram
    // ever reported `templates: true`, a WhatsApp template could be accepted
    // for them (TPL-05, CH-MSG-01).
    expect(CAPABILITY_MATRICES.whatsapp.templates).toBe(true);
    expect(CAPABILITY_MATRICES.messenger.templates).toBe(false);
    expect(CAPABILITY_MATRICES.instagram.templates).toBe(false);
  });

  it('sends Instagram to its own host', () => {
    expect(CAPABILITY_MATRICES.instagram.host).toBe('graph.facebook.com');
    expect(CAPABILITY_MATRICES.whatsapp.host).toBe('graph.facebook.com');
  });

  it('keeps Messenger and Instagram customer-initiated', () => {
    expect(CAPABILITY_MATRICES.messenger.businessInitiated).toBe(false);
    expect(CAPABILITY_MATRICES.instagram.businessInitiated).toBe(false);
  });
});

describe('text measurement', () => {
  it('counts UTF-8 bytes, not UTF-16 units', () => {
    expect(utf8Length('abc')).toBe(3);
    // Arabic is two bytes per character: a 1000-character limit in bytes is
    // reached at 500 Arabic characters, which is the whole point (CH-IG-04).
    expect(utf8Length('مرحبا')).toBe(10);
    expect(utf8Length('€')).toBe(3);
    expect(utf8Length('😀')).toBe(4);
  });

  it('counts an emoji as one character and a ZWJ sequence as its parts', () => {
    expect(measureText('😀', { characters: 10, bytes: 10 }).characters).toBe(1);
    // A family emoji is several code points joined by ZWJ. Providers count them
    // the same way, so we do not pretend it is one.
    const family = '👨‍👩‍👧';
    expect(measureText(family, { characters: 10, bytes: 100 }).characters).toBe(5);
  });

  it('fails a limit on bytes even when the character count fits', () => {
    const arabic = 'م'.repeat(600);
    const result = measureText(arabic, { characters: 1000, bytes: 1000 });
    expect(result.characters).toBe(600);
    expect(result.bytes).toBe(1200);
    expect(result.withinLimit).toBe(false);
  });

  it('passes when both bounds hold', () => {
    expect(measureText('hello', { characters: 10, bytes: 10 }).withinLimit).toBe(true);
  });
});

/* ------------------------------------------------------------- signatures -- */

describe('meta signature verification', () => {
  const crypto = fakeCrypto();
  const secret = 'app-secret';
  const body = new TextEncoder().encode('{"object":"whatsapp_business_account"}');
  const good = `sha256=${crypto.hmacSha256Hex(secret, body)}`;

  function verify(headers: Record<string, string | undefined>, now = NOW) {
    return verifyMetaSignature({ rawBody: body, headers, secret, now }, crypto);
  }

  it('accepts a signature over the exact bytes', () => {
    expect(verify({ 'x-hub-signature-256': good })).toEqual({ valid: true });
  });

  it('rejects one byte of difference', () => {
    const altered = new TextEncoder().encode('{"object":"whatsapp_business_accounT"}');
    expect(
      verifyMetaSignature(
        { rawBody: altered, headers: { 'x-hub-signature-256': good }, secret, now: NOW },
        crypto,
      ),
    ).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('rejects a signature made with another secret', () => {
    const other = `sha256=${crypto.hmacSha256Hex('someone-elses-secret', body)}`;
    expect(verify({ 'x-hub-signature-256': other })).toEqual({ valid: false, reason: 'mismatch' });
  });

  it.each([
    ['no header at all', {}, 'missing_header'],
    ['an empty header', { 'x-hub-signature-256': '' }, 'missing_header'],
    ['a sha1 header', { 'x-hub-signature-256': 'sha1=abc' }, 'unsupported_algorithm'],
    ['no prefix', { 'x-hub-signature-256': 'a'.repeat(64) }, 'unsupported_algorithm'],
    ['a short digest', { 'x-hub-signature-256': 'sha256=abc' }, 'malformed_header'],
    [
      'a non-hex digest',
      { 'x-hub-signature-256': `sha256=${'z'.repeat(64)}` },
      'malformed_header',
    ],
  ])('refuses %s', (_label, headers, reason) => {
    expect(verify(headers)).toEqual({ valid: false, reason });
  });

  it('refuses a replayed delivery outside the window', () => {
    const old = String(NOW.getTime() / 1000 - REPLAY_WINDOW_SECONDS - 1);
    expect(verify({ 'x-hub-signature-256': good, 'x-hub-timestamp': old })).toEqual({
      valid: false,
      reason: 'stale',
    });
  });

  it('accepts a delivery inside the window, in either direction', () => {
    const recent = String(NOW.getTime() / 1000 - 10);
    const slightlyAhead = String(NOW.getTime() / 1000 + 10);
    expect(verify({ 'x-hub-signature-256': good, 'x-hub-timestamp': recent })).toEqual({
      valid: true,
    });
    expect(verify({ 'x-hub-signature-256': good, 'x-hub-timestamp': slightlyAhead })).toEqual({
      valid: true,
    });
  });

  it('does not treat an undated delivery as stale', () => {
    // Meta does not always send a timestamp. Refusing every undated delivery
    // would drop real customer messages to close a hole the secret already
    // bounds.
    expect(verify({ 'x-hub-signature-256': good, 'x-hub-timestamp': 'not-a-number' })).toEqual({
      valid: true,
    });
  });

  it('checks the signature before the age', () => {
    // Otherwise an attacker learns whether a captured body is recent by
    // watching which refusal comes back.
    const old = String(NOW.getTime() / 1000 - 10_000);
    expect(verify({ 'x-hub-signature-256': 'sha256=' + 'a'.repeat(64), 'x-hub-timestamp': old })).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });
});

describe('meta challenge', () => {
  const crypto = fakeCrypto();
  const tokenHash = crypto.sha256Hex('verify-me');

  it('echoes the challenge when the token matches', () => {
    expect(
      answerMetaChallenge(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '12345' },
        tokenHash,
        crypto,
      ),
    ).toBe('12345');
  });

  it.each([
    ['the wrong token', { 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' }],
    ['the wrong mode', { 'hub.mode': 'unsubscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '1' }],
    ['no token', { 'hub.mode': 'subscribe', 'hub.challenge': '1' }],
    ['no challenge', { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me' }],
    ['an empty challenge', { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '' }],
  ])('refuses %s', (_label, query) => {
    expect(answerMetaChallenge(query, tokenHash, crypto)).toBeNull();
  });
});

/* ------------------------------------------------------- whatsapp adapter -- */

describe('WhatsAppAdapter.normalize', () => {
  const adapter = new WhatsAppAdapter(fakeCrypto());

  function delivery(value: Record<string, unknown>): Record<string, unknown> {
    return {
      object: 'whatsapp_business_account',
      entry: [{ id: 'waba-1', changes: [{ field: 'messages', value }] }],
    };
  }

  const metadata = { display_phone_number: '15550001111', phone_number_id: 'phone-1' };

  const textIn = (id: string): Record<string, unknown> => ({
    id,
    from: '1',
    timestamp: '1789000000',
    type: 'text',
    text: { body: 'x' },
  });
  const statusIn = (id: string): Record<string, unknown> => ({
    id,
    status: 'sent',
    recipient_id: '1',
    timestamp: '1789000000',
  });

  it('reads the asset id from the payload, which is what resolves the tenant', () => {
    const batch = adapter.normalize(delivery({ metadata, messages: [] }), NOW);
    expect(batch.assetId).toBe('phone-1');
  });

  it('normalizes a text message', () => {
    const batch = adapter.normalize(
      delivery({
        metadata,
        messages: [
          { id: 'wamid.1', from: '15559998888', timestamp: '1789000000', type: 'text', text: { body: 'مرحبا' } },
        ],
      }),
      NOW,
    );
    expect(batch.quarantined).toEqual([]);
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({
      kind: 'message',
      dedupeKey: 'wa:msg:wamid.1',
      eventType: 'messages.text',
      providerMessageId: 'wamid.1',
      peerIdentity: '15559998888',
      assetIdentity: 'phone-1',
      contentType: 'text',
      text: 'مرحبا',
    });
    expect(batch.events[0]?.occurredAt.toISOString()).toBe('2026-09-10T00:26:40.000Z');
    // The provider's own element travels with it, so the journal keeps the
    // evidence and nothing has to normalize twice.
    expect(batch.events[0]?.source).toMatchObject({ id: 'wamid.1' });
  });

  it('normalizes a media message into an attachment', () => {
    const batch = adapter.normalize(
      delivery({
        metadata,
        messages: [
          {
            id: 'wamid.2',
            from: '15559998888',
            timestamp: '1789000000',
            type: 'image',
            image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'a photo' },
          },
        ],
      }),
      NOW,
    );
    expect(batch.events[0]?.attachments).toEqual([
      { type: 'image', providerId: 'media-1', mimeType: 'image/jpeg', caption: 'a photo' },
    ]);
    expect(batch.events[0]?.kind).toBe('message');
  });

  it('keeps an unknown message type instead of dropping it', () => {
    // A customer sent something real. Storing it as `unsupported` with its
    // payload means the conversation shows a documented fallback rather than a
    // gap (CH-01).
    const batch = adapter.normalize(
      delivery({
        metadata,
        messages: [{ id: 'wamid.3', from: '155599', timestamp: '1789000000', type: 'interactive_v9' }],
      }),
      NOW,
    );
    expect(batch.events[0]).toMatchObject({
      kind: 'unsupported',
      detail: { unsupported_type: 'interactive_v9' },
    });
    expect(batch.quarantined).toEqual([]);
  });

  it('separates delivery and read receipts, and keys them by state', () => {
    const batch = adapter.normalize(
      delivery({
        metadata,
        statuses: [
          { id: 'wamid.9', status: 'delivered', recipient_id: '155599', timestamp: '1789000001' },
          { id: 'wamid.9', status: 'read', recipient_id: '155599', timestamp: '1789000002' },
        ],
      }),
      NOW,
    );
    expect(batch.events.map((event) => [event.kind, event.dedupeKey])).toEqual([
      ['delivery_status', 'wa:status:wamid.9:delivered'],
      ['read_status', 'wa:status:wamid.9:read'],
    ]);
    // A message and a status about it must never share a key, or the second
    // would look like a duplicate of the first.
    expect(batch.events[0]?.dedupeKey).not.toBe('wa:msg:wamid.9');
  });

  it('quarantines one bad element without losing its siblings', () => {
    const batch = adapter.normalize(
      delivery({
        metadata,
        messages: [
          { id: 'wamid.a', from: '1', timestamp: '1789000000', type: 'text', text: { body: 'first' } },
          { from: '2', type: 'text', text: { body: 'no id' } },
          { id: 'wamid.c', from: '3', timestamp: '1789000000', type: 'text', text: { body: 'third' } },
        ],
      }),
      NOW,
    );
    expect(batch.events.map((event) => event.text)).toEqual(['first', 'third']);
    expect(batch.quarantined).toHaveLength(1);
    expect(batch.quarantined[0]?.reason).toBe('message_missing_id_or_sender');
    expect(batch.quarantined[0]?.payload).toMatchObject({ from: '2' });
  });

  it('quarantines an account-level change but still reads the asset from it', () => {
    const batch = adapter.normalize(
      {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'waba-1',
            changes: [{ field: 'account_update', value: { metadata, event: 'PHONE_NUMBER_ADDED' } }],
          },
        ],
      },
      NOW,
    );
    expect(batch.assetId).toBe('phone-1');
    expect(batch.events).toEqual([]);
    expect(batch.quarantined[0]?.reason).toBe('unsupported_change_field');
  });

  it('quarantines a change with no value', () => {
    const batch = adapter.normalize(
      { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages' }] }] },
      NOW,
    );
    expect(batch.quarantined[0]?.reason).toBe('change_has_no_value');
  });

  it('quarantines a status with missing fields', () => {
    const batch = adapter.normalize(delivery({ metadata, statuses: [{ id: 'x' }] }), NOW);
    expect(batch.quarantined[0]?.reason).toBe('status_missing_fields');
  });

  it.each([
    ['a non-object', 'nope'],
    ['null', null],
    ['another product’s envelope', { object: 'page', entry: [] }],
  ])('refuses %s as an envelope, with nothing addressable', (_label, payload) => {
    const batch = adapter.normalize(payload, NOW);
    expect(batch.assetId).toBeNull();
    expect(batch.events).toEqual([]);
    expect(batch.quarantined[0]?.reason).toBe('not_a_whatsapp_business_account_envelope');
  });

  it('falls back to the receipt time when the provider timestamp is unusable', () => {
    const batch = adapter.normalize(
      delivery({
        metadata,
        messages: [{ id: 'wamid.t', from: '1', type: 'text', text: { body: 'x' }, timestamp: 'soon' }],
      }),
      NOW,
    );
    expect(batch.events[0]?.occurredAt).toEqual(NOW);
  });

  it('handles a batch with several entries and several changes', () => {
    const batch = adapter.normalize(
      {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'waba-1',
            changes: [
              {
                field: 'messages',
                value: {
                  metadata,
                  messages: [
                    { id: 'm1', from: '1', timestamp: '1789000000', type: 'text', text: { body: 'a' } },
                  ],
                },
              },
            ],
          },
          {
            id: 'waba-1',
            changes: [
              {
                field: 'messages',
                value: {
                  metadata,
                  statuses: [
                    { id: 'm0', status: 'sent', recipient_id: '1', timestamp: '1789000000' },
                  ],
                },
              },
            ],
          },
        ],
      },
      NOW,
    );
    expect(batch.events).toHaveLength(2);
  });

  it('normalizes a change that names no field and a message with no type', () => {
    const batch = adapter.normalize(
      {
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ value: { metadata, messages: [] } }] }],
      },
      NOW,
    );
    expect(batch.quarantined[0]?.reason).toBe('unsupported_change_field');
    expect(batch.quarantined[0]?.eventType).toBe('unknown');
  });

  it('records an unknown message type as unknown rather than crashing', () => {
    const batch = adapter.normalize(
      delivery({ metadata, messages: [{ id: 'wamid.x', from: '1', timestamp: '1789000000' }] }),
      NOW,
    );
    expect(batch.events[0]).toMatchObject({
      kind: 'unsupported',
      eventType: 'messages.unknown',
      contentType: 'unknown',
    });
  });

  it('leaves the asset identity empty when the change carried no metadata', () => {
    // The batch then has no asset id at all, so the ingress refuses to route it
    // — but the normalizer still answers rather than throwing.
    const batch = adapter.normalize(
      delivery({ messages: [textIn('wamid.nometa')], statuses: [statusIn('wamid.nometa')] }),
      NOW,
    );
    expect(batch.assetId).toBeNull();
    expect(batch.events.map((event) => event.assetIdentity)).toEqual(['', '']);
  });

  it('quarantines a change that is not an object at all', () => {
    const batch = adapter.normalize(
      { object: 'whatsapp_business_account', entry: [{ changes: [null] }] },
      NOW,
    );
    expect(batch.quarantined[0]).toMatchObject({ reason: 'change_has_no_value', payload: null });
  });

  it('accepts a numeric provider timestamp as well as a string one', () => {
    const batch = adapter.normalize(
      delivery({
        metadata,
        messages: [
          { id: 'wamid.n', from: '1', timestamp: 1789000000, type: 'text', text: { body: 'x' } },
        ],
      }),
      NOW,
    );
    expect(batch.events[0]?.occurredAt.toISOString()).toBe('2026-09-10T00:26:40.000Z');
  });

  it('falls back on a timestamp that is neither a string nor a number', () => {
    const batch = adapter.normalize(
      delivery({
        metadata,
        messages: [
          { id: 'wamid.o', from: '1', timestamp: { at: 1 }, type: 'text', text: { body: 'x' } },
        ],
      }),
      NOW,
    );
    expect(batch.events[0]?.occurredAt).toEqual(NOW);
  });

  it('reports its own kind, port version and capabilities', () => {
    expect(adapter.kind).toBe('whatsapp');
    expect(adapter.portVersion).toBe(1);
    expect(adapter.capabilities().templates).toBe(true);
  });

  it('answers the challenge through the same crypto port', () => {
    const crypto = fakeCrypto();
    expect(
      adapter.verifyChallenge(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 't', 'hub.challenge': 'c' },
        crypto.sha256Hex('t'),
      ),
    ).toBe('c');
  });

  it('verifies a signature through the same crypto port', () => {
    const crypto = fakeCrypto();
    const body = new TextEncoder().encode('{}');
    expect(
      adapter.verifySignature({
        rawBody: body,
        headers: { 'x-hub-signature-256': `sha256=${crypto.hmacSha256Hex('s', body)}` },
        secret: 's',
        now: NOW,
      }),
    ).toEqual({ valid: true });
  });
});

/* ------------------------------------------------------------ send policy -- */

describe('permitSend', () => {
  function request(overrides: Partial<SendRequest> = {}): SendRequest {
    const kind = overrides.kind ?? 'whatsapp';
    return {
      kind,
      capabilities: capabilitiesFor(kind),
      messageType: 'text',
      isPrivateNote: false,
      text: 'hello',
      lastInboundAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      now: NOW,
      template: null,
      consentWithdrawn: false,
      ...overrides,
    };
  }

  it('allows a reply inside the window with no template', () => {
    expect(permitSend(request())).toEqual({ allowed: true, requiresTemplate: false });
  });

  it('never lets a private note reach a provider, whatever else is true', () => {
    // Checked first and unconditionally: no window, template or consent state
    // can make an internal note deliverable (DEL-11).
    expect(permitSend(request({ isPrivateNote: true }))).toMatchObject({
      allowed: false,
      reason: 'note_not_deliverable',
    });
    expect(
      permitSend(request({ isPrivateNote: true, lastInboundAt: null, consentWithdrawn: true })),
    ).toMatchObject({ reason: 'note_not_deliverable' });
  });

  it('refuses a message type the channel cannot carry', () => {
    expect(permitSend(request({ kind: 'instagram', messageType: 'document' }))).toMatchObject({
      allowed: false,
      reason: 'not_supported',
    });
  });

  it('refuses a WhatsApp template on Messenger and on Instagram', () => {
    for (const kind of ['messenger', 'instagram'] as const) {
      expect(
        permitSend(request({ kind, template: { name: 'order_update', kind: 'whatsapp' } })),
      ).toMatchObject({ allowed: false, reason: 'template_not_applicable' });
    }
  });

  it('refuses a template approved for another channel even where templates exist', () => {
    expect(
      permitSend(request({ kind: 'whatsapp', template: { name: 'x', kind: 'messenger' } })),
    ).toMatchObject({ allowed: false, reason: 'template_not_applicable' });
  });

  it('refuses a withdrawn-consent recipient even inside the window', () => {
    expect(permitSend(request({ consentWithdrawn: true }))).toMatchObject({
      allowed: false,
      reason: 'consent_withheld',
    });
  });

  it('refuses text past the byte limit', () => {
    const result = permitSend(request({ kind: 'instagram', text: 'م'.repeat(600) }));
    expect(result).toMatchObject({ allowed: false, reason: 'text_too_long' });
    if (result.allowed) throw new Error('unreachable');
    expect(result.detail).toContain('1200 bytes');
  });

  it('requires a template outside the WhatsApp window', () => {
    const stale = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    expect(permitSend(request({ lastInboundAt: stale }))).toMatchObject({
      allowed: false,
      reason: 'template_required',
    });
    expect(
      permitSend(request({ lastInboundAt: stale, template: { name: 'x', kind: 'whatsapp' } })),
    ).toEqual({ allowed: true, requiresTemplate: true });
  });

  it('gives Instagram no template path out of a closed window', () => {
    const stale = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    expect(permitSend(request({ kind: 'instagram', lastInboundAt: stale }))).toMatchObject({
      allowed: false,
      reason: 'window_expired',
    });
  });

  it('refuses a cold DM as customer-initiation, not as an expired window', () => {
    // The two are different facts and lead to different operator actions:
    // waiting for a reply versus never being able to send at all (CH-IG-03).
    expect(permitSend(request({ kind: 'instagram', lastInboundAt: null }))).toMatchObject({
      allowed: false,
      reason: 'customer_initiation_required',
    });
    expect(permitSend(request({ kind: 'messenger', lastInboundAt: null }))).toMatchObject({
      reason: 'customer_initiation_required',
    });
  });

  it('lets our own channels send with no window at all', () => {
    for (const kind of ['web_chat', 'custom'] as const) {
      expect(permitSend(request({ kind, lastInboundAt: null }))).toEqual({
        allowed: true,
        requiresTemplate: false,
      });
    }
  });

  it('refuses a WhatsApp cold open with no template', () => {
    expect(permitSend(request({ lastInboundAt: null }))).toMatchObject({
      allowed: false,
      reason: 'template_required',
    });
  });

  it('closes a business-initiated channel that has no templates', () => {
    // No shipped channel is both business-initiated and template-less today.
    // The permit is decided against the connection's own frozen matrix, so this
    // is the case a future channel — or a version bump — would produce, and it
    // must refuse rather than ask for a template that cannot exist.
    const stale = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    const result = permitSend(
      request({
        lastInboundAt: stale,
        capabilities: { ...capabilitiesFor('whatsapp'), templates: false },
      }),
    );
    expect(result).toMatchObject({ allowed: false, reason: 'window_expired' });
  });

  it('decides against the connection’s frozen matrix, not the current build', () => {
    // A connection pinned to a narrower matrix keeps that matrix. Reading the
    // global one instead would let a version bump change the rules underneath
    // messages that were drafted before it.
    const narrow = { ...capabilitiesFor('whatsapp'), textLimit: { characters: 4, bytes: 4 } };
    expect(permitSend(request({ capabilities: narrow, text: 'hello' }))).toMatchObject({
      allowed: false,
      reason: 'text_too_long',
    });
    expect(permitSend(request({ text: 'hello' })).allowed).toBe(true);
  });

  it('closes the window exactly at the boundary', () => {
    const exactly = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    expect(permitSend(request({ lastInboundAt: exactly }))).toMatchObject({
      allowed: false,
      reason: 'template_required',
    });
    const justInside = new Date(exactly.getTime() + 1);
    expect(permitSend(request({ lastInboundAt: justInside }))).toEqual({
      allowed: true,
      requiresTemplate: false,
    });
  });
});

/* ------------------------------------------------------------ the outcome -- */

describe('classifyOutcome', () => {
  function classify(
    observation: Parameters<typeof classifyOutcome>[0]['observation'],
    overrides: Partial<Parameters<typeof classifyOutcome>[0]> = {},
  ) {
    return classifyOutcome({
      observation,
      providerMessageId: null,
      errorCode: null,
      errorMessage: null,
      ...overrides,
    });
  }

  it('accepts a 2xx that carries a message id', () => {
    expect(
      classify({ kind: 'response', status: 200, body: { ok: true } }, { providerMessageId: 'wamid.1' }),
    ).toEqual({ status: 'accepted', providerMessageId: 'wamid.1', raw: { ok: true } });
  });

  it('calls a 2xx with no message id unknown, not accepted', () => {
    // We cannot prove it was accepted and we cannot prove it was not — and a
    // message no receipt can ever be correlated to is exactly that.
    expect(classify({ kind: 'response', status: 202, body: {} })).toMatchObject({
      status: 'outcome_unknown',
      code: 'no_provider_message_id',
    });
  });

  it('rejects a 4xx as final, and a 429 or 5xx as worth retrying', () => {
    expect(classify({ kind: 'response', status: 400, body: {} })).toMatchObject({
      status: 'definitely_rejected',
      retryable: false,
      code: 'http_400',
    });
    for (const status of [429, 500, 503]) {
      expect(classify({ kind: 'response', status, body: {} })).toMatchObject({
        status: 'definitely_rejected',
        retryable: true,
      });
    }
  });

  it('prefers the provider’s own error code when the adapter extracted one', () => {
    expect(
      classify(
        { kind: 'response', status: 400, body: {} },
        { errorCode: 'template_not_approved', errorMessage: 'Not approved.' },
      ),
    ).toMatchObject({ code: 'template_not_approved', message: 'Not approved.' });
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'DNS_FAILURE', 'TLS_HANDSHAKE_FAILED'])(
    'treats %s as never-sent, so it may be retried',
    (code) => {
      // These fail before any bytes leave, so nothing was sent and a retry
      // cannot duplicate anything.
      expect(classify({ kind: 'transport_error', code, message: 'no' })).toMatchObject({
        status: 'definitely_rejected',
        retryable: true,
        code,
      });
    },
  );

  it.each(['ETIMEDOUT', 'ECONNRESET', 'ABORT_ERR', 'SOCKET_HANGUP'])(
    'treats %s as an unknown outcome',
    (code) => {
      // The request was on the wire. The industry default — retry on timeout —
      // is what sends duplicate messages to real customers.
      expect(classify({ kind: 'transport_error', code, message: 'gone' })).toEqual({
        status: 'outcome_unknown',
        code,
        message: 'gone',
      });
    },
  );

  it('never returns accepted for anything but a 2xx with an id', () => {
    const cases = [
      classify({ kind: 'response', status: 500, body: {} }),
      classify({ kind: 'response', status: 200, body: {} }),
      classify({ kind: 'transport_error', code: 'ETIMEDOUT', message: 'x' }),
    ];
    expect(cases.every((outcome) => outcome.status !== 'accepted')).toBe(true);
  });
});

describe('foldDelivery', () => {
  const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);

  it('takes the first receipt as it stands', () => {
    expect(foldDelivery(null, { state: 'delivered', at: at(0) })).toEqual({
      state: 'delivered',
      at: at(0),
      anomaly: null,
    });
  });

  it('advances through sent, delivered, read', () => {
    let fold: DeliveryFold | null = null;
    for (const state of DELIVERY_STATES) {
      fold = foldDelivery(fold, { state, at: at(1) });
    }
    expect(fold?.state).toBe('read');
  });

  it('never moves backwards, and records the disagreement', () => {
    // The anomaly EVT-04 names: a `delivered` arriving after a confirmed `read`
    // must not erase the read, and must not be silently dropped either.
    const read = foldDelivery(null, { state: 'read', at: at(5) });
    const late = foldDelivery(read, { state: 'delivered', at: at(6) });
    expect(late).toEqual({ state: 'read', at: at(5), anomaly: 'delivered_after_read' });
  });

  it('treats a repeated receipt as the provider repeating itself', () => {
    const first = foldDelivery(null, { state: 'delivered', at: at(1) });
    expect(foldDelivery(first, { state: 'delivered', at: at(2) })).toBe(first);
  });

  it('keeps an earlier anomaly while still advancing', () => {
    const read = foldDelivery(null, { state: 'read', at: at(5) });
    const anomalous = foldDelivery(read, { state: 'sent', at: at(6) });
    expect(anomalous.anomaly).toBe('sent_after_read');
    // Nothing above `read` exists, so advance from a lower state instead.
    const sent = foldDelivery(null, { state: 'sent', at: at(1) });
    const withAnomaly = { ...sent, anomaly: 'noted' };
    expect(foldDelivery(withAnomaly, { state: 'read', at: at(2) })).toEqual({
      state: 'read',
      at: at(2),
      anomaly: 'noted',
    });
  });

  it('folds any permutation of the same receipts to the same state', () => {
    // The property ADR-0006 asks for: order of arrival changes the anomaly
    // record, never the state the operator is shown.
    const receipts = [
      { state: 'sent' as const, at: at(1) },
      { state: 'delivered' as const, at: at(2) },
      { state: 'read' as const, at: at(3) },
    ];
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const order of permutations) {
      let fold: DeliveryFold | null = null;
      for (const index of order) {
        fold = foldDelivery(fold, receipts[index] as { state: 'sent'; at: Date });
      }
      expect(fold?.state).toBe('read');
    }
  });
});

describe('mayAutoRetry', () => {
  it('never allows an unknown outcome to be resent', () => {
    // The single most important line in the delivery design.
    expect(mayAutoRetry('outcome_unknown')).toBe(false);
  });

  it('allows only the two states that mean "not attempted yet"', () => {
    const allowed = COMMAND_STATES.filter((state: CommandState) => mayAutoRetry(state));
    expect(allowed).toEqual(['queued', 'retry_scheduled']);
  });
});
