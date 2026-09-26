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

  it('fills a catalogue template from the frozen values, falling back where a contact had none', () => {
    const content = {
      type: 'template',
      template: {
        id: 'tpl-1', name: 'course_open', language: 'ar',
        parameters: { 'body:1': { source: 'display_name', fallback: 'عميلنا' }, 'body:2': { source: 'static', value: 'الأحد' } },
      },
    };
    expect(campaignCommandContent(content, { body_1: 'سارة', body_2: 'الأحد' })).toEqual({
      type: 'template', text: null, templateName: 'course_open', templateLanguage: 'ar',
      templateId: 'tpl-1', templateValues: { 'body:1': 'سارة', 'body:2': 'الأحد' },
    });
    expect(campaignCommandContent(content, {})?.templateValues).toEqual({ 'body:1': 'عميلنا', 'body:2': 'الأحد' });
    // Nothing to fall back on: that recipient cannot be sent this template.
    const strict = { template: { ...content.template, parameters: { 'body:1': { source: 'phone' } } } };
    expect(campaignCommandContent(strict, {})).toBeNull();
    // A stored template that no longer reads as one is not guessed at.
    expect(campaignCommandContent({ template: { id: 'tpl-1', name: 'x', language: 'ar', parameters: 'nope' } }, {})).toBeNull();
    expect(campaignCommandContent({ template: { id: 'tpl-1', parameters: {} } }, {})).toBeNull();
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
    [permit({ consent_state: 'withdrawn' }), 'marketing_consent_withdrawn'],
  ] as const)('refuses an unsafe projection with %s', (row, reason) => {
    expect(campaignDispatchRefusal(row, NOW)).toMatchObject({ reason });
  });

  it('allows a live approved recipient before expiry, with or without a recorded consent', () => {
    expect(campaignDispatchRefusal(permit({ expires_at: new Date(NOW + 1) }), NOW)).toBeNull();
    // Broadcasts reach everyone who has not said no.
    expect(campaignDispatchRefusal(permit({ consent_state: null }), NOW)).toBeNull();
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
