import { describe, expect, it } from 'vitest';
import { INBOX_FILTER_CATALOGUE, INBOX_FILTER_KEYS, inboxFilterDefinition } from './inbox-filters.js';

describe('Inbox filter catalogue', () => {
  it('has one closed definition for every public key', () => {
    expect(INBOX_FILTER_CATALOGUE.map((item) => item.key)).toEqual(INBOX_FILTER_KEYS);
    expect(new Set(INBOX_FILTER_CATALOGUE.map((item) => item.compiler)).size).toBe(INBOX_FILTER_CATALOGUE.length);
  });

  it('does not expose campaign until durable attribution exists', () => {
    expect(inboxFilterDefinition('campaign_id')).toBeNull();
    expect(inboxFilterDefinition('campaign_name')).toBeNull();
  });
});
