import { describe, expect, it } from 'vitest';
import { INBOX_FILTER_CATALOGUE, INBOX_FILTER_KEYS, inboxFilterDefinition } from './inbox-filters.js';

describe('Inbox filter catalogue', () => {
  it('has one closed definition for every public key', () => {
    expect(INBOX_FILTER_CATALOGUE.map((item) => item.key)).toEqual(INBOX_FILTER_KEYS);
    expect(new Set(INBOX_FILTER_CATALOGUE.map((item) => item.compiler)).size).toBe(INBOX_FILTER_CATALOGUE.length);
  });

  it('exposes durable campaign attribution as an ID-backed filter, never a mutable name', () => {
    expect(inboxFilterDefinition('campaign_id')).toMatchObject({ valueType: 'campaign_id', compiler: 'campaign_attribution', savedView: true });
    expect(inboxFilterDefinition('campaign_name')).toBeNull();
  });
});
