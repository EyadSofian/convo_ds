import { describe, expect, it, vi } from 'vitest';
import { ApiHttpError } from '../http-error.js';
import { parseCampaignControl, parseCampaignDraft, parseCampaignLaunch } from './campaign-request.js';

const CONNECTION = '11111111-1111-4111-8111-111111111111';

describe('campaign request parsing', () => {
  it('normalizes a complete draft and supplies safe defaults', () => {
    expect(parseCampaignDraft({ name: '  September intake ', connectionId: CONNECTION, content: { text: 'Hello' } })).toEqual({
      name: 'September intake', objective: null, connectionId: CONNECTION, content: { text: 'Hello' },
      variables: {}, audienceFilter: {}, timezone: 'UTC', expiresAt: null,
      budgetAmountMinor: 0, budgetCurrency: 'USD',
    });
    expect(parseCampaignDraft({
      name: 'A', objective: ' Enrolment ', connectionId: CONNECTION, content: { template: 'welcome' },
      variables: { first_name: 'display_name' }, audienceFilter: { labels: ['lead'] }, timezone: 'Africa/Cairo',
      expiresAt: '2027-01-01T00:00:00Z', budgetAmountMinor: 70000, budgetCurrency: 'EGP',
    })).toMatchObject({ objective: 'Enrolment', expiresAt: '2027-01-01T00:00:00.000Z' });
  });

  it.each([
    null, [], {}, { name: '', connectionId: CONNECTION, content: { text: 'x' } },
    { name: 'A', connectionId: 'bad', content: { text: 'x' } },
    { name: 'A', connectionId: CONNECTION, content: {} },
    { name: 'A', connectionId: CONNECTION, content: [] },
    { name: 'A', connectionId: CONNECTION, content: { text: 'x' }, variables: [] },
    { name: 'A', connectionId: CONNECTION, content: { text: 'x' }, variables: { 'bad-key': 'display_name' } },
    { name: 'A', connectionId: CONNECTION, content: { text: 'x' }, variables: { first_name: 'email' } },
    { name: 'A', connectionId: CONNECTION, content: { text: 'x' }, audienceFilter: [] },
    { name: 'A', connectionId: CONNECTION, content: { text: 'x' }, objective: '' },
    { name: 'A', connectionId: CONNECTION, content: { text: 'x' }, timezone: '' },
    { name: 'A', connectionId: CONNECTION, content: { text: 'x' }, expiresAt: 'bad' },
    { name: 'A', connectionId: CONNECTION, content: { text: 'x' }, budgetAmountMinor: -1 },
    { name: 'A', connectionId: CONNECTION, content: { text: 'x' }, budgetAmountMinor: 1.5 },
    { name: 'A', connectionId: CONNECTION, content: { text: 'x' }, budgetCurrency: 'usd' },
  ])('refuses malformed drafts %#', (body) => expect(() => parseCampaignDraft(body)).toThrow(ApiHttpError));

  it('parses immediate and future launch choices', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    expect(parseCampaignLaunch({ mode: 'now' })).toEqual({ scheduledFor: null });
    expect(parseCampaignLaunch({ mode: 'scheduled', scheduledFor: '2026-09-02T00:00:00Z' })).toEqual({ scheduledFor: '2026-09-02T00:00:00.000Z' });
    vi.useRealTimers();
  });

  it.each([
    {}, { mode: 'now', scheduledFor: '2027-01-01T00:00:00Z' }, { mode: 'scheduled' },
    { mode: 'scheduled', scheduledFor: 'bad' }, { mode: 'later', scheduledFor: '2027-01-01T00:00:00Z' },
  ])('refuses malformed launch choices %#', (body) => expect(() => parseCampaignLaunch(body)).toThrow(ApiHttpError));

  it('parses only the three operator controls', () => {
    expect(parseCampaignControl({ action: 'pause' })).toBe('pause');
    expect(parseCampaignControl({ action: 'resume' })).toBe('resume');
    expect(parseCampaignControl({ action: 'cancel' })).toBe('cancel');
    expect(() => parseCampaignControl({ action: 'delete' })).toThrow(ApiHttpError);
  });
});
