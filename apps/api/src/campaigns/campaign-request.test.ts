import { describe, expect, it, vi } from 'vitest';
import { ApiHttpError } from '../http-error.js';
import { parseCampaignClone, parseCampaignControl, parseCampaignDraft, parseCampaignExport, parseCampaignLaunch, parseCampaignRetry, parseCampaignTestSend, parseCampaignUpdate, parseReportFilters, parseTestRecipient } from './campaign-request.js';

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

  it('requires and trims a clone name', () => {
    expect(parseCampaignClone({ name: '  September copy  ' })).toEqual({ name: 'September copy' });
    expect(() => parseCampaignClone({})).toThrow(ApiHttpError);
  });

  it('accepts only an explicit empty failed-only retry request', () => {
    expect(parseCampaignRetry({})).toEqual({});
    expect(() => parseCampaignRetry(null)).toThrow(ApiHttpError);
    expect(() => parseCampaignRetry({ all: true })).toThrow(ApiHttpError);
  });

  it('accepts only a CSV report export with an optional campaign scope', () => {
    expect(parseCampaignExport({ format: 'csv' })).toEqual({ format: 'csv', campaignId: null });
    expect(parseCampaignExport({ format: 'csv', campaignId: CONNECTION })).toEqual({
      format: 'csv', campaignId: CONNECTION,
    });
    for (const body of [null, {}, { format: 'json' }, { format: 'csv', campaignId: 'bad' }, { format: 'csv', extra: true }]) {
      expect(() => parseCampaignExport(body)).toThrow(ApiHttpError);
    }
  });

  it('parses report filters as whole UTC days, one channel and one campaign', () => {
    expect(parseReportFilters({})).toEqual({
      from: null, to: null, channel: null, campaignId: null, fromAt: null, toExclusiveAt: null,
    });
    expect(parseReportFilters(undefined)).toMatchObject({ from: null, to: null });
    expect(parseReportFilters({ from: '2026-09-01', to: '2026-09-01' })).toMatchObject({
      fromAt: '2026-09-01T00:00:00.000Z', toExclusiveAt: '2026-09-02T00:00:00.000Z',
    });
    expect(parseReportFilters({ to: '2026-12-31', channel: 'web_chat', campaignId: CONNECTION })).toEqual({
      from: null, to: '2026-12-31', channel: 'web_chat', campaignId: CONNECTION,
      fromAt: null, toExclusiveAt: '2027-01-01T00:00:00.000Z',
    });
    for (const query of [
      { period: 'week' },
      { from: '2026-9-1' },
      { from: ['2026-09-01', '2026-09-02'] },
      { to: '2026-13-01' },
      { to: '2026-02-31' },
      { from: '2026-09-02', to: '2026-09-01' },
      { channel: 'telegram' },
      { channel: ['whatsapp'] },
      { campaignId: 'bad' },
      { campaignId: 7 },
    ]) {
      expect(() => parseReportFilters(query), JSON.stringify(query)).toThrow(ApiHttpError);
    }
  });

  it('requires a positive concurrency version for campaign updates', () => {
    const body = { name: 'Updated', connectionId: CONNECTION, content: { text: 'Hello' }, expectedVersion: 2 };
    expect(parseCampaignUpdate(body)).toMatchObject({ name: 'Updated', expectedVersion: 2 });
    expect(() => parseCampaignUpdate({ ...body, expectedVersion: 0 })).toThrow(ApiHttpError);
    expect(() => parseCampaignUpdate({ ...body, expectedVersion: 1.5 })).toThrow(ApiHttpError);
  });

  it('parses test recipient authorization and test-send requests', () => {
    expect(parseTestRecipient({ peerIdentity: ' 201000000001 ', label: 'Owner phone' })).toEqual({
      peerIdentity: '201000000001', label: 'Owner phone',
    });
    expect(() => parseTestRecipient({ peerIdentity: 'bad identity', label: '' })).toThrow(ApiHttpError);
    expect(parseCampaignTestSend({ testRecipientId: CONNECTION, expectedVersion: 2 })).toEqual({
      testRecipientId: CONNECTION, expectedVersion: 2,
    });
    for (const body of [{}, { testRecipientId: 'bad', expectedVersion: 1 }, { testRecipientId: CONNECTION, expectedVersion: 0 }]) {
      expect(() => parseCampaignTestSend(body)).toThrow(ApiHttpError);
    }
  });
});
