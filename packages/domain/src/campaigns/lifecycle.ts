/** Campaign orchestration is deliberately a closed transition table. */
export const CAMPAIGN_STATES = [
  'draft',
  'validating',
  'ready',
  'scheduled',
  'running',
  'pausing',
  'paused',
  'dispatch_completed',
  'cancelling',
  'cancelled',
  'failed',
] as const;

export type CampaignState = (typeof CAMPAIGN_STATES)[number];

export const CAMPAIGN_TRIGGERS = [
  'validate',
  'validation_passed',
  'validation_failed',
  'launch_scheduled',
  'launch_now',
  'schedule_due',
  'pause',
  'pause_settled',
  'resume',
  'dispatch_finished',
  'cancel',
  'cancel_settled',
  'orchestration_failed',
] as const;

export type CampaignTrigger = (typeof CAMPAIGN_TRIGGERS)[number];

export const CAMPAIGN_EFFECTS = [
  'begin_validation',
  'record_validation',
  'invalidate_approval',
  'create_execution',
  'schedule_execution',
  'start_execution',
  'stop_new_dispatches',
  'resume_dispatches',
  'finish_execution',
  'record_failure',
] as const;

export type CampaignEffect = (typeof CAMPAIGN_EFFECTS)[number];
export type CampaignRefusal = 'invalid_campaign_transition';

export interface CampaignTransition {
  readonly from: CampaignState;
  readonly to: CampaignState;
  readonly changed: boolean;
  readonly effects: readonly CampaignEffect[];
  readonly refusal: CampaignRefusal | null;
}

interface Row {
  readonly to: CampaignState;
  readonly effects: readonly CampaignEffect[];
}

type TransitionTable = Partial<Record<CampaignState, Row>>;

const TABLE: Readonly<Record<CampaignTrigger, TransitionTable>> = {
  validate: {
    draft: { to: 'validating', effects: ['begin_validation'] },
  },
  validation_passed: {
    validating: { to: 'ready', effects: ['record_validation'] },
  },
  validation_failed: {
    validating: { to: 'draft', effects: ['record_validation', 'invalidate_approval'] },
  },
  launch_scheduled: {
    ready: { to: 'scheduled', effects: ['create_execution', 'schedule_execution'] },
  },
  launch_now: {
    ready: { to: 'running', effects: ['create_execution', 'start_execution'] },
  },
  schedule_due: {
    scheduled: { to: 'running', effects: ['start_execution'] },
  },
  pause: {
    running: { to: 'pausing', effects: ['stop_new_dispatches'] },
  },
  pause_settled: {
    pausing: { to: 'paused', effects: [] },
  },
  resume: {
    paused: { to: 'running', effects: ['resume_dispatches'] },
  },
  dispatch_finished: {
    running: { to: 'dispatch_completed', effects: ['finish_execution'] },
    pausing: { to: 'dispatch_completed', effects: ['finish_execution'] },
  },
  cancel: {
    scheduled: { to: 'cancelling', effects: ['stop_new_dispatches'] },
    running: { to: 'cancelling', effects: ['stop_new_dispatches'] },
    pausing: { to: 'cancelling', effects: ['stop_new_dispatches'] },
    paused: { to: 'cancelling', effects: ['stop_new_dispatches'] },
  },
  cancel_settled: {
    cancelling: { to: 'cancelled', effects: [] },
  },
  orchestration_failed: {
    validating: { to: 'failed', effects: ['record_failure'] },
    scheduled: { to: 'failed', effects: ['stop_new_dispatches', 'record_failure'] },
    running: { to: 'failed', effects: ['stop_new_dispatches', 'record_failure'] },
    pausing: { to: 'failed', effects: ['stop_new_dispatches', 'record_failure'] },
    paused: { to: 'failed', effects: ['stop_new_dispatches', 'record_failure'] },
    cancelling: { to: 'failed', effects: ['stop_new_dispatches', 'record_failure'] },
  },
};

const STATE_SET: ReadonlySet<string> = new Set(CAMPAIGN_STATES);

export function isCampaignState(value: unknown): value is CampaignState {
  return typeof value === 'string' && STATE_SET.has(value);
}

export function applyCampaignTrigger(
  from: CampaignState,
  trigger: CampaignTrigger,
): CampaignTransition {
  const row = TABLE[trigger][from];
  if (row === undefined) {
    return { from, to: from, changed: false, effects: [], refusal: 'invalid_campaign_transition' };
  }
  return { from, to: row.to, changed: row.to !== from, effects: row.effects, refusal: null };
}

/** Only an unlaunched definition may be edited; a ready edit must return to draft. */
export function campaignEditTarget(state: CampaignState): 'draft' | null {
  return state === 'draft' || state === 'ready' ? 'draft' : null;
}
