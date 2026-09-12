import { describe, expect, it } from 'vitest';
import {
  campaignDispatchRefusal,
  campaignCommandContent,
  campaignOutcomeProjection,
  type CampaignPermitState,
} from './campaign-dispatch.js';

const NOW = Date.parse('2026-09-12T10:00:00.000Z');

function permit(overrides: Partial<CampaignPermitState> = {}): CampaignPermitState {
  return {
    recipient_state: 'in_flight', execution_state: 'running', execution_stop_version: '4',
    campaign_stop_version: '4', campaign_state: 'running', expires_at: null,
    approved: true, consent_state: 'granted', ...overrides,
  };
}

describe('campaign dispatch policy', () => {
  it('renders approved text from frozen values, including scalar values', () => {
    expect(campaignCommandContent(
      { text: 'أهلاً {{ display_name }} — level {{level}}, active {{active}}' },
      { display_name: 'سارة', level: 2, active: true },
    )).toEqual({
      type: 'text', text: 'أهلاً سارة — level 2, active true',
      templateName: null, templateLanguage: null,
    });
  });

  it('refuses missing variables, empty text and malformed templates', () => {
    expect(campaignCommandContent({ text: 'Hello {{missing}}' }, {})).toBeNull();
    expect(campaignCommandContent({ text: '   ' }, {})).toBeNull();
    expect(campaignCommandContent({ template: { name: '', language: 'ar' } }, {})).toBeNull();
    expect(campaignCommandContent({ template: [] }, {})).toBeNull();
  });

  it('creates a trimmed template command', () => {
    expect(campaignCommandContent({ template: { name: ' course_open ', language: ' ar ' } }, {}))
      .toEqual({ type: 'template', text: null, templateName: 'course_open', templateLanguage: 'ar' });
  });

  it.each([
    [undefined, 'campaign_recipient_missing'],
    [permit({ execution_state: 'paused' }), 'campaign_stopped'],
    [permit({ campaign_state: 'paused' }), 'campaign_stopped'],
    [permit({ recipient_state: 'queued' }), 'campaign_recipient_stale'],
    [permit({ campaign_stop_version: '3' }), 'campaign_fence_changed'],
    [permit({ approved: false }), 'campaign_approval_revoked'],
    [permit({ expires_at: new Date(NOW) }), 'campaign_expired'],
    [permit({ consent_state: 'withdrawn' }), 'marketing_consent_missing'],
  ] as const)('refuses an unsafe projection with %s', (row, reason) => {
    expect(campaignDispatchRefusal(row, NOW)).toMatchObject({ reason });
  });

  it('allows a live approved recipient before expiry', () => {
    expect(campaignDispatchRefusal(permit({ expires_at: new Date(NOW + 1) }), NOW)).toBeNull();
  });

  it.each([
    ['retry', { recipientState: 'queued', budgetState: null, finishesAttempt: false }],
    ['accepted', { recipientState: 'accepted', budgetState: 'committed', finishesAttempt: true }],
    ['rejected', { recipientState: 'failed', budgetState: 'released', finishesAttempt: true }],
    ['outcome_unknown', { recipientState: 'outcome_unknown', budgetState: 'held_unknown', finishesAttempt: true }],
  ] as const)('projects %s without conflating command and budget state', (outcome, expected) => {
    expect(campaignOutcomeProjection(outcome)).toEqual(expected);
  });
});
