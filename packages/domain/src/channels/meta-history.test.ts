import { describe, expect, it } from 'vitest';
import type { ChannelCrypto } from './crypto.js';
import { InstagramAdapter } from './instagram.js';
import { MessengerAdapter } from './messenger.js';
import { graphMessageToWebhookItem, normalizeHeldEntries, normalizeMetaHistory } from './meta-history.js';

const crypto = { sha256Hex: (value: string) => `sha-${value.length}` } as unknown as ChannelCrypto;
const NOW = new Date('2026-11-05T12:00:00Z');
const PAGE = '483612954841072';
const CUSTOMER = '4528904674043170';

const fromCustomer = {
  id: 'm_customer', created_time: '2026-11-01T10:00:00+0000', message: 'ممكن تفاصيل الكورس',
  from: { id: CUSTOMER, name: 'Parent' }, to: { data: [{ id: PAGE }] },
};

describe('reading Graph conversation messages as webhook items', () => {
  it('rebuilds a customer message exactly as the webhook would carry it', () => {
    expect(graphMessageToWebhookItem(fromCustomer, PAGE)).toEqual({
      sender: { id: CUSTOMER },
      recipient: { id: PAGE },
      timestamp: Date.parse('2026-11-01T10:00:00Z'),
      message: { mid: 'm_customer', text: 'ممكن تفاصيل الكورس', attachments: [], is_echo: false },
    });
  });

  it('recognises what the business itself said by the sender', () => {
    const item = graphMessageToWebhookItem({ ...fromCustomer, from: { id: PAGE }, to: { data: [{ id: CUSTOMER }] } }, PAGE);
    expect(item?.['message']).toMatchObject({ is_echo: true });
  });

  it.each([
    ['image/jpeg', { image_data: { url: 'https://cdn/i' } }, 'image', 'https://cdn/i'],
    ['video/mp4', { video_data: { url: 'https://cdn/v' } }, 'video', 'https://cdn/v'],
    ['audio/mpeg', { file_url: 'https://cdn/a' }, 'audio', 'https://cdn/a'],
    ['application/pdf', { file_url: 'https://cdn/f' }, 'file', 'https://cdn/f'],
    [undefined, {}, 'file', null],
  ])('types an attachment of %s by its mime type', (mime, source, type, url) => {
    const item = graphMessageToWebhookItem({ ...fromCustomer, message: '', attachments: { data: [{ mime_type: mime, ...source }] } }, PAGE);
    expect(item?.['message']).toMatchObject({ text: null, attachments: [{ type, payload: { url } }] });
  });

  it('refuses a message it cannot key or place', () => {
    expect(graphMessageToWebhookItem('nope', PAGE)).toBeNull();
    expect(graphMessageToWebhookItem({ ...fromCustomer, id: undefined }, PAGE)).toBeNull();
    expect(graphMessageToWebhookItem({ ...fromCustomer, from: {} }, PAGE)).toBeNull();
    expect(graphMessageToWebhookItem({ ...fromCustomer, to: { data: [] } }, PAGE)).toBeNull();
  });

  it('keeps a message with no readable time, for the parser to date', () => {
    const item = graphMessageToWebhookItem({ ...fromCustomer, created_time: undefined }, PAGE);
    expect(item?.['timestamp']).toBeNaN();
  });
});

describe('normalizing what Graph returned', () => {
  it('produces the same dedupe key a webhook delivery would, marked as historic', () => {
    const adapter = new MessengerAdapter(crypto);
    const batch = normalizeMetaHistory(adapter, PAGE, [fromCustomer, 'junk'], NOW);
    const live = adapter.normalize({ object: 'page', entry: [{ id: PAGE, messaging: [{
      sender: { id: CUSTOMER }, recipient: { id: PAGE }, timestamp: 1, message: { mid: 'm_customer', text: 'x' },
    }] }] }, NOW);
    expect(batch.events[0]?.dedupeKey).toBe(live.events[0]?.dedupeKey);
    expect(batch.events[0]).toMatchObject({ kind: 'message', peerIdentity: CUSTOMER, detail: { history: true } });
    expect(batch.quarantined).toEqual([]);
  });

  it('answers for Instagram under its own envelope and keys', () => {
    const batch = normalizeMetaHistory(new InstagramAdapter(crypto), 'ig-1', [{ ...fromCustomer, to: { data: [{ id: 'ig-1' }] } }], NOW);
    expect(batch.events[0]?.dedupeKey).toBe('ig:msg:m_customer');
  });

  it('holds nothing back when Graph had nothing to say', () => {
    expect(normalizeMetaHistory(new MessengerAdapter(crypto), PAGE, ['junk'], NOW)).toEqual({ assetId: PAGE, events: [], quarantined: [] });
  });

  it('reads held standby entries again as the customer messages they were', () => {
    const entry = { id: PAGE, standby: [{ sender: { id: CUSTOMER }, recipient: { id: PAGE }, timestamp: 5, message: { mid: 'm_held', text: 'hello' } }] };
    const batch = normalizeHeldEntries(new MessengerAdapter(crypto), [entry], NOW);
    expect(batch.events[0]).toMatchObject({ kind: 'message', dedupeKey: 'mg:msg:m_held', detail: { history: true } });
  });
});
