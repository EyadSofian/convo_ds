import { describe, expect, it } from 'vitest';
import {
  applyCampaignTrigger,
  campaignEditTarget,
  CAMPAIGN_STATES,
  CAMPAIGN_TRIGGERS,
  isCampaignState,
} from './lifecycle.js';

describe('campaign lifecycle', () => {
  it('defines an outcome for every state and trigger', () => {
    for (const state of CAMPAIGN_STATES) {
      for (const trigger of CAMPAIGN_TRIGGERS) {
        const result = applyCampaignTrigger(state, trigger);
        expect(result.from).toBe(state);
        expect(CAMPAIGN_STATES).toContain(result.to);
        expect(result.changed).toBe(result.to !== state);
        expect(result.refusal === null || result.refusal === 'invalid_campaign_transition').toBe(true);
      }
    }
  });

  it('validates before launch and returns a failed validation to editable draft', () => {
    expect(applyCampaignTrigger('draft', 'validate')).toMatchObject({ to: 'validating', refusal: null });
    expect(applyCampaignTrigger('validating', 'validation_passed')).toMatchObject({ to: 'ready' });
    expect(applyCampaignTrigger('validating', 'validation_failed')).toEqual({
      from: 'validating',
      to: 'draft',
      changed: true,
      effects: ['record_validation', 'invalidate_approval'],
      refusal: null,
    });
  });

  it('creates an execution exactly at either launch door', () => {
    expect(applyCampaignTrigger('ready', 'launch_now').effects).toEqual(['create_execution', 'start_execution']);
    expect(applyCampaignTrigger('ready', 'launch_scheduled').effects).toEqual(['create_execution', 'schedule_execution']);
    expect(applyCampaignTrigger('scheduled', 'schedule_due').effects).toEqual(['start_execution']);
  });

  it('pauses and cancels through settling states', () => {
    expect(applyCampaignTrigger('running', 'pause').to).toBe('pausing');
    expect(applyCampaignTrigger('pausing', 'pause_settled').to).toBe('paused');
    expect(applyCampaignTrigger('paused', 'resume').to).toBe('running');
    for (const state of ['scheduled', 'running', 'pausing', 'paused'] as const) {
      expect(applyCampaignTrigger(state, 'cancel')).toMatchObject({ to: 'cancelling', refusal: null });
    }
    expect(applyCampaignTrigger('cancelling', 'cancel_settled').to).toBe('cancelled');
  });

  it('allows completion while a pause is draining and rejects terminal mutation', () => {
    expect(applyCampaignTrigger('pausing', 'dispatch_finished').to).toBe('dispatch_completed');
    for (const state of ['dispatch_completed', 'cancelled', 'failed'] as const) {
      expect(applyCampaignTrigger(state, 'cancel')).toEqual({
        from: state,
        to: state,
        changed: false,
        effects: [],
        refusal: 'invalid_campaign_transition',
      });
    }
  });

  it('reopens only a terminal execution for an explicit failed-only retry', () => {
    expect(applyCampaignTrigger('dispatch_completed', 'retry_failed')).toEqual({
      from: 'dispatch_completed', to: 'running', changed: true,
      effects: ['retry_failed_recipients'], refusal: null,
    });
    expect(applyCampaignTrigger('failed', 'retry_failed')).toMatchObject({ to: 'running', refusal: null });
    expect(applyCampaignTrigger('running', 'retry_failed').refusal).toBe('invalid_campaign_transition');
  });

  it('recognises only campaign states and limits definition edits', () => {
    expect(isCampaignState('running')).toBe(true);
    expect(isCampaignState('unknown')).toBe(false);
    expect(isCampaignState(1)).toBe(false);
    expect(campaignEditTarget('draft')).toBe('draft');
    expect(campaignEditTarget('ready')).toBe('draft');
    expect(campaignEditTarget('running')).toBeNull();
  });
});
