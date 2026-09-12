import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseConnectChannel, parseRotateCredential } from './channel-request.js';
import { NO_PROVIDER_CODE, unconfiguredTransport } from './channel-transport.js';
import {
  CredentialCipher,
  CredentialCipherError,
  parseCipherKey,
  type CredentialBinding,
} from './credential-cipher.js';
import { adapterClaiming, adapterFor, implementedKinds, META_KINDS } from './adapters.js';
import { ChannelCredentialService } from './credential.service.js';
import { inboundRowFrom } from './inbound-projection.js';
import { parseSendMessage } from './outbound-request.js';
import { assetFingerprint, nodeChannelCrypto, sha256BytesHex } from './node-crypto.js';

/* ------------------------------------------------------------------ crypto -- */

describe('nodeChannelCrypto', () => {
  it('produces the same HMAC Node does, over raw bytes', () => {
    const body = new TextEncoder().encode('{"a":1}');
    const expected = createHmac('sha256', 'secret').update(body).digest('hex');
    expect(nodeChannelCrypto.hmacSha256Hex('secret', body)).toBe(expected);
  });

  it('hashes bytes and strings separately, and consistently', () => {
    const text = 'مرحبا';
    expect(nodeChannelCrypto.sha256Hex(text)).toBe(sha256BytesHex(new TextEncoder().encode(text)));
  });

  it('compares equal digests as equal', () => {
    const digest = nodeChannelCrypto.sha256Hex('x');
    expect(nodeChannelCrypto.timingSafeEqualHex(digest, digest)).toBe(true);
  });

  it('answers a length mismatch rather than throwing', () => {
    // `timingSafeEqual` throws on differing lengths, which is exactly what a
    // malformed header produces. That has to be a refusal, not a 500.
    expect(nodeChannelCrypto.timingSafeEqualHex('a'.repeat(64), 'a'.repeat(32))).toBe(false);
    expect(nodeChannelCrypto.timingSafeEqualHex('', '')).toBe(false);
  });

  it('refuses a same-length value that is not hex', () => {
    expect(nodeChannelCrypto.timingSafeEqualHex('a'.repeat(64), 'z'.repeat(64))).toBe(false);
  });

  it('fingerprints an asset from its provider, kind and id together', () => {
    // The three are joined, so a Page and a WhatsApp number that happened to
    // share an id could never resolve to the same tenant.
    expect(assetFingerprint('meta', 'whatsapp', '1')).not.toBe(
      assetFingerprint('meta', 'messenger', '1'),
    );
    expect(assetFingerprint('meta', 'whatsapp', '1')).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* ------------------------------------------------------------- the cipher -- */

const KEY = `v1:${Buffer.alloc(32, 7).toString('base64')}`;
const OLD_KEY = `v0:${Buffer.alloc(32, 3).toString('base64')}`;
const BINDING: CredentialBinding = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222',
  purpose: 'access_token',
};

describe('parseCipherKey', () => {
  it('accepts a versioned 32-byte key', () => {
    expect(parseCipherKey(KEY)).toEqual({ version: 'v1', key: Buffer.alloc(32, 7) });
  });

  it.each([
    ['no separator', 'justthekey'],
    ['an uppercase version', `V1:${Buffer.alloc(32).toString('base64')}`],
    ['an empty version', `:${Buffer.alloc(32).toString('base64')}`],
  ])('refuses %s', (_label, raw) => {
    expect(() => parseCipherKey(raw)).toThrow(CredentialCipherError);
  });

  it('refuses a key of the wrong length', () => {
    expect(() => parseCipherKey(`v1:${Buffer.alloc(16).toString('base64')}`)).toThrow(
      /exactly 32 bytes/,
    );
  });
});

describe('CredentialCipher', () => {
  const cipher = new CredentialCipher([parseCipherKey(KEY)], 'fingerprint-secret');

  it('refuses to exist with no keys', () => {
    expect(() => new CredentialCipher([], 'x')).toThrow(/at least one/i);
  });

  it('round-trips a token', () => {
    const sealed = cipher.seal('EAAG...token', BINDING);
    expect(cipher.open(sealed, BINDING)).toBe('EAAG...token');
  });

  it('never produces the same ciphertext twice for the same token', () => {
    // A fresh IV per record. Without it, two tenants storing the same token
    // would be visibly storing the same token.
    const first = cipher.seal('same-token', BINDING);
    const second = cipher.seal('same-token', BINDING);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(first.iv.equals(second.iv)).toBe(false);
    // The fingerprint is deterministic, which is what makes it useful.
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('fingerprints under a secret, so a guessed token cannot be confirmed', () => {
    const other = new CredentialCipher([parseCipherKey(KEY)], 'a-different-secret');
    expect(cipher.fingerprint('token')).not.toBe(other.fingerprint('token'));
    expect(cipher.fingerprint('token')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a ciphertext moved to another row', () => {
    // The binding is authenticated data, so lifting a row into another tenant,
    // connection or purpose breaks decryption rather than transferring the
    // credential.
    const sealed = cipher.seal('token', BINDING);
    for (const moved of [
      { ...BINDING, tenantId: '33333333-3333-4333-8333-333333333333' },
      { ...BINDING, connectionId: '44444444-4444-4444-8444-444444444444' },
      { ...BINDING, purpose: 'refresh_token' },
    ]) {
      expect(() => cipher.open(sealed, moved)).toThrow(/could not be opened/);
    }
  });

  it('refuses a tampered ciphertext and a tampered tag', () => {
    const sealed = cipher.seal('token', BINDING);
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(() => cipher.open({ ...sealed, ciphertext: flipped }, BINDING)).toThrow(
      /could not be opened/,
    );
    const badTag = Buffer.alloc(16, 9);
    expect(() => cipher.open({ ...sealed, authTag: badTag }, BINDING)).toThrow(
      /could not be opened/,
    );
  });

  it('reads a record written under an older key, and writes under the newest', () => {
    // What a rotation actually needs: the old key stays configured so existing
    // records keep opening, and new records use the new one.
    const older = new CredentialCipher([parseCipherKey(OLD_KEY)], 'fingerprint-secret');
    const sealedOld = older.seal('old-token', BINDING);
    expect(sealedOld.keyVersion).toBe('v0');

    const both = new CredentialCipher(
      [parseCipherKey(KEY), parseCipherKey(OLD_KEY)],
      'fingerprint-secret',
    );
    expect(both.open(sealedOld, BINDING)).toBe('old-token');
    expect(both.seal('new-token', BINDING).keyVersion).toBe('v1');
  });

  it('names a missing key version rather than failing mysteriously', () => {
    const sealed = new CredentialCipher([parseCipherKey(OLD_KEY)], 'fingerprint-secret').seal(
      'token',
      BINDING,
    );
    expect(() => cipher.open(sealed, BINDING)).toThrow(/version "v0"/);
  });
});

/* ----------------------------------------------------------- the transport -- */

describe('the unconfigured transport', () => {
  it('refuses a connection test instead of reporting success', async () => {
    const check = await unconfiguredTransport.validateConnection('whatsapp', 'token', 'phone-1');
    expect(check).toMatchObject({ ok: false, code: NO_PROVIDER_CODE });
    expect(check.assetIdentity).toBeNull();
  });

  it('rejects a send definitely, not ambiguously', async () => {
    // The distinction matters: nothing was sent, and we know nothing was sent.
    // Calling it `outcome_unknown` would suppress automatic retry forever for a
    // message that never left the building (ADR-0006).
    const outcome = await unconfiguredTransport.send('whatsapp', 'token', {
      assetIdentity: 'phone-1',
      peerIdentity: '1555',
      messageType: 'text',
      text: 'hello',
      template: null,
      attachments: [],
      idempotencyKey: 'k',
    });
    expect(outcome).toMatchObject({
      status: 'definitely_rejected',
      code: NO_PROVIDER_CODE,
      retryable: true,
    });
  });
});

describe('the adapter registry', () => {
  it('serves every channel kind, each with its own adapter', () => {
    expect(implementedKinds()).toEqual([
      'whatsapp',
      'messenger',
      'instagram',
      'web_chat',
      'custom',
    ]);
    for (const kind of implementedKinds()) {
      expect(adapterFor(kind)?.kind).toBe(kind);
    }
  });

  it('picks the Meta adapter that claims a verified envelope', () => {
    // One app, one webhook, three products, distinguished only by `object`.
    expect(adapterClaiming({ object: 'page' }, META_KINDS)?.kind).toBe('messenger');
    expect(adapterClaiming({ object: 'instagram' }, META_KINDS)?.kind).toBe('instagram');
    expect(adapterClaiming({ object: 'whatsapp_business_account' }, META_KINDS)?.kind).toBe(
      'whatsapp',
    );
  });

  it('claims nothing for an envelope no Meta adapter recognises', () => {
    expect(adapterClaiming({ object: 'threads' }, META_KINDS)).toBeNull();
    // Our own channels are not offered on the Meta route at all.
    expect(adapterClaiming({ object: 'web_chat' }, META_KINDS)).toBeNull();
  });
});

/* -------------------------------------------------------------- parsing -- */

const VALID_CONNECT = {
  kind: 'whatsapp',
  externalAssetId: 'phone-1',
  displayName: 'Enrollment line',
  accessToken: 'EAAGabcdef123456',
};

describe('parseConnectChannel', () => {
  it('accepts a complete request and trims what it keeps', () => {
    const result = parseConnectChannel({ ...VALID_CONNECT, displayName: '  Enrollment line  ' });
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({
      kind: 'whatsapp',
      externalAssetId: 'phone-1',
      displayName: 'Enrollment line',
      accessToken: 'EAAGabcdef123456',
      providerAppId: null,
      appId: null,
      settings: {},
    });
  });

  it('accepts an explicit app id', () => {
    const appId = '55555555-5555-4555-8555-555555555555';
    const result = parseConnectChannel({ ...VALID_CONNECT, appId });
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.appId).toBe(appId);
  });

  it('accepts the provider-facing app id the operator can copy from Meta', () => {
    const result = parseConnectChannel({ ...VALID_CONNECT, providerAppId: ' 100000000000009 ' });
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.providerAppId).toBe('100000000000009');
  });

  it.each([
    ['a non-object body', ['nope'], ['body']],
    ['an unknown kind', { ...VALID_CONNECT, kind: 'telegram' }, ['kind']],
    ['a missing kind', { ...VALID_CONNECT, kind: undefined }, ['kind']],
    ['an empty asset id', { ...VALID_CONNECT, externalAssetId: '' }, ['externalAssetId']],
    [
      'an asset id with a slash',
      { ...VALID_CONNECT, externalAssetId: '../secrets' },
      ['externalAssetId'],
    ],
    ['a missing name', { ...VALID_CONNECT, displayName: '  ' }, ['displayName']],
    ['an over-long name', { ...VALID_CONNECT, displayName: 'x'.repeat(81) }, ['displayName']],
    ['a short token', { ...VALID_CONNECT, accessToken: 'abc' }, ['accessToken']],
    ['a non-string token', { ...VALID_CONNECT, accessToken: 42 }, ['accessToken']],
    ['a non-uuid app id', { ...VALID_CONNECT, appId: 'app-1' }, ['appId']],
    ['a malformed provider app id', { ...VALID_CONNECT, providerAppId: '../app' }, ['providerAppId']],
    ['a non-string provider app id', { ...VALID_CONNECT, providerAppId: 42 }, ['providerAppId']],
    [
      'two app references',
      { ...VALID_CONNECT, appId: '55555555-5555-4555-8555-555555555555', providerAppId: '100000000000009' },
      ['appReference'],
    ],
  ])('rejects %s', (_label, body, expected) => {
    const result = parseConnectChannel(body);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.details.map((detail) => detail.field)).toEqual(expected);
  });

  it('rejects a token carrying a newline, which is a header-injection primitive', () => {
    const result = parseConnectChannel({ ...VALID_CONNECT, accessToken: 'abcdefgh\r\nX-Evil: 1' });
    if (result.ok) throw new Error('expected a rejection');
    expect(result.details[0]?.field).toBe('accessToken');
  });

  it('collects every problem at once rather than stopping at the first', () => {
    const result = parseConnectChannel({ kind: 'nope', externalAssetId: '', displayName: '' });
    if (result.ok) throw new Error('expected a rejection');
    expect(result.details.map((detail) => detail.field)).toEqual([
      'kind',
      'externalAssetId',
      'displayName',
      'accessToken',
    ]);
  });
});

describe('parseRotateCredential', () => {
  it('accepts a token', () => {
    const result = parseRotateCredential({ accessToken: 'EAAGnewtoken1234' });
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.accessToken).toBe('EAAGnewtoken1234');
  });

  it.each([
    ['a non-object body', ['nope'], 'body'],
    ['a missing token', {}, 'accessToken'],
  ])('rejects %s', (_label, body, field) => {
    const result = parseRotateCredential(body);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.details[0]?.field).toBe(field);
  });
});

/* ------------------------------------------------------ inbound projection -- */

describe('inboundRowFrom', () => {
  const FALLBACK = new Date('2026-09-09T12:00:00.000Z');

  it('reads a complete normalized event', () => {
    expect(
      inboundRowFrom(
        {
          kind: 'message',
          providerMessageId: 'wamid.1',
          peerIdentity: '15559998888',
          assetIdentity: 'phone-1',
          contentType: 'text',
          text: 'مرحبا',
          attachments: [{ type: 'image' }],
          detail: { a: 1 },
          occurredAt: '2026-09-01T00:00:00.000Z',
        },
        FALLBACK,
      ),
    ).toEqual({
      kind: 'message',
      providerMessageId: 'wamid.1',
      peerIdentity: '15559998888',
      assetIdentity: 'phone-1',
      contentType: 'text',
      text: 'مرحبا',
      attachments: '[{"type":"image"}]',
      detail: '{"a":1}',
      occurredAt: new Date('2026-09-01T00:00:00.000Z'),
    });
  });

  it('answers an empty object with defaults rather than throwing', () => {
    // Everything here came out of `jsonb`. A schema change, a replayed old
    // event or an adapter bug all arrive as a shape that does not match, and one
    // malformed row must not stop a worker draining a customer's messages.
    expect(inboundRowFrom({}, FALLBACK)).toEqual({
      kind: 'unsupported',
      providerMessageId: null,
      peerIdentity: '',
      assetIdentity: '',
      contentType: null,
      text: null,
      attachments: '[]',
      detail: '{}',
      occurredAt: FALLBACK,
    });
  });

  it('degrades a message with no provider id to unsupported', () => {
    // The table refuses `message` without an id, and the WhatsApp normalizer
    // quarantines one before it gets here — so this can only be an adapter bug,
    // and it is made visible instead of fatal.
    expect(inboundRowFrom({ kind: 'message' }, FALLBACK).kind).toBe('unsupported');
  });

  it('rejects a kind this build does not know', () => {
    expect(inboundRowFrom({ kind: 'telepathy', providerMessageId: 'x' }, FALLBACK).kind).toBe(
      'unsupported',
    );
    expect(inboundRowFrom({ kind: 42 }, FALLBACK).kind).toBe('unsupported');
  });

  it('falls back on an unusable timestamp', () => {
    expect(inboundRowFrom({ occurredAt: 'yesterday' }, FALLBACK).occurredAt).toBe(FALLBACK);
    expect(inboundRowFrom({ occurredAt: 12345 }, FALLBACK).occurredAt).toBe(FALLBACK);
  });

  it('treats an empty string as absent', () => {
    const row = inboundRowFrom({ peerIdentity: '', text: '', providerMessageId: '' }, FALLBACK);
    expect(row.peerIdentity).toBe('');
    expect(row.text).toBeNull();
    expect(row.providerMessageId).toBeNull();
  });
});

/* -------------------------------------------------- credential availability -- */

describe('ChannelCredentialService without usable keys', () => {
  function serviceWith(keys: readonly string[]): ChannelCredentialService {
    // Only the two fields the service reads. Constructing the whole config
    // would assert nothing extra and would break every time it grows.
    const config = { secrets: { credentialKeys: keys, authHash: 'fingerprint-secret' } };
    return new ChannelCredentialService(config as never);
  }

  it('is unavailable, not broken, when no key is configured', () => {
    // An installation with no channel connections needs no key. Refusing to
    // boot over an unused feature would be worse than refusing here.
    const service = serviceWith([]);
    expect(service.available).toBe(false);
  });

  it('names the missing configuration at the point of use', async () => {
    const service = serviceWith([]);
    await expect(
      service.store({} as never, { tenantId: 't', connectionId: 'c', purpose: 'access_token' }, 'x', null),
    ).rejects.toThrow(/CONVO_CREDENTIAL_KEYS/);
  });

  it('reports a malformed key without repeating the key', async () => {
    const service = serviceWith(['not-a-valid-key']);
    expect(service.available).toBe(false);
    await expect(
      service.withActive(
        {} as never,
        { tenantId: 't', connectionId: 'c', purpose: 'access_token' },
        () => Promise.resolve('never'),
      ),
    ).rejects.toThrow(/credential key/i);
  });

  it('is available with a usable key', () => {
    expect(serviceWith([KEY]).available).toBe(true);
  });
});

/* ---------------------------------------------------------- send requests -- */

const VALID_SEND = {
  peerIdentity: '15559998888',
  messageType: 'text',
  text: 'مرحبا',
  clientMessageId: 'client-message-0001',
};

describe('parseSendMessage', () => {
  it('accepts a minimal text send and defaults the rest', () => {
    const result = parseSendMessage(VALID_SEND);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({
      peerIdentity: '15559998888',
      messageType: 'text',
      text: 'مرحبا',
      template: null,
      clientMessageId: 'client-message-0001',
      trafficClass: 'interactive',
      isPrivateNote: false,
    });
  });

  it('accepts a template and a bulk traffic class', () => {
    const result = parseSendMessage({
      ...VALID_SEND,
      template: { name: 'order_update', language: 'ar' },
      trafficClass: 'bulk',
    });
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.template).toEqual({ name: 'order_update', language: 'ar' });
    expect(result.value.trafficClass).toBe('bulk');
  });

  it('accepts a private note rather than rejecting it as malformed', () => {
    // A note is a real thing an operator writes. The permit is the one place
    // that decides what may reach a provider, so it is accepted here and
    // refused there — not silently dropped somewhere nobody tests.
    const result = parseSendMessage({ ...VALID_SEND, isPrivateNote: true });
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.isPrivateNote).toBe(true);
  });

  it.each([
    ['a non-object body', ['nope'], ['body']],
    ['a missing recipient', { ...VALID_SEND, peerIdentity: '' }, ['peerIdentity']],
    ['a recipient with a slash', { ...VALID_SEND, peerIdentity: 'a/b' }, ['peerIdentity']],
    ['a missing message type', { ...VALID_SEND, messageType: '' }, ['messageType']],
    ['a shouty message type', { ...VALID_SEND, messageType: 'TEXT' }, ['messageType']],
    ['an over-long body', { ...VALID_SEND, text: 'x'.repeat(16_001) }, ['text']],
    ['a short client id', { ...VALID_SEND, clientMessageId: 'short' }, ['clientMessageId']],
    ['a missing client id', { peerIdentity: '1', messageType: 'text' }, ['clientMessageId']],
    ['a half template', { ...VALID_SEND, template: { name: 'x' } }, ['template']],
    ['a bad language tag', { ...VALID_SEND, template: { name: 'x', language: 'arabic' } }, ['template']],
    ['an unknown traffic class', { ...VALID_SEND, trafficClass: 'urgent' }, ['trafficClass']],
    ['a non-boolean note flag', { ...VALID_SEND, isPrivateNote: 'yes' }, ['isPrivateNote']],
  ])('rejects %s', (_label, body, expected) => {
    const result = parseSendMessage(body);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.details.map((detail) => detail.field)).toEqual(expected);
  });

  it.each([
    ['a non-string recipient', { ...VALID_SEND, peerIdentity: 42 }, ['peerIdentity']],
    ['a non-string type', { ...VALID_SEND, messageType: 7 }, ['messageType']],
    ['a non-string template name', { ...VALID_SEND, template: { name: 1, language: 'ar' } }, ['template']],
    ['a non-string client id', { ...VALID_SEND, clientMessageId: 12345678 }, ['clientMessageId']],
  ])('rejects %s without trusting its type', (_label, body, expected) => {
    const result = parseSendMessage(body);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.details.map((detail) => detail.field)).toEqual(expected);
  });

  it('reads an absent or non-string body as empty rather than rejecting it', () => {
    // A template-only send legitimately carries no text, so "no usable text" is
    // empty rather than an error. The permit is what decides whether an empty
    // body is acceptable on this channel.
    for (const text of [undefined, 42, null]) {
      const result = parseSendMessage({ ...VALID_SEND, text });
      if (!result.ok) throw new Error('expected acceptance');
      expect(result.value.text).toBe('');
    }
  });

  it('does not check the text against a channel limit', () => {
    // The limit belongs to the connection's own frozen matrix, and that is a
    // permit-time decision. Checking it here would use the wrong matrix.
    const result = parseSendMessage({ ...VALID_SEND, text: 'م'.repeat(5000) });
    expect(result.ok).toBe(true);
  });
});
