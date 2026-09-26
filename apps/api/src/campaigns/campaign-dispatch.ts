import { parseTemplateBindings, resolveTemplateValues, variableKeyOf } from '@convo/domain';
import type { TemplateBindings } from '@convo/domain';

export interface CampaignPermitState {
  readonly recipient_state: string;
  readonly execution_state: string;
  readonly execution_stop_version: string;
  readonly campaign_stop_version: string | null;
  readonly campaign_state: string;
  readonly expires_at: Date | null;
  readonly approved: boolean;
  readonly consent_state: string | null;
}

export interface CampaignDispatchRefusal {
  readonly reason: string;
  readonly detail: string;
}

export interface CampaignCommandContent {
  readonly type: 'text' | 'template';
  readonly text: string | null;
  readonly templateName: string | null;
  readonly templateLanguage: string | null;
  /** A catalogue template: which one, and the value of each of its parameters. */
  readonly templateId?: string;
  readonly templateValues?: Readonly<Record<string, string>>;
}

/** Renders only values captured in the immutable audience snapshot. */
export function campaignCommandContent(
  content: Readonly<Record<string, unknown>>,
  renderedVariables: Readonly<Record<string, unknown>>,
): CampaignCommandContent | null {
  const bound = boundContent(content);
  if (bound !== undefined) {
    if (bound === null) return null;
    const values = resolveTemplateValues(bound.parameters, (key) => renderedVariables[variableKeyOf(key)]);
    return values === null ? null : {
      type: 'template', text: null, templateName: bound.name, templateLanguage: bound.language,
      templateId: bound.id, templateValues: values,
    };
  }
  if (typeof content['text'] === 'string' && content['text'].trim() !== '') {
    let unresolved = false;
    const rendered = content['text'].replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (_match, key: string) => {
      const value = renderedVariables[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
      unresolved = true;
      return '';
    });
    return unresolved || rendered.trim() === ''
      ? null
      : { type: 'text', text: rendered, templateName: null, templateLanguage: null };
  }
  const template = content['template'];
  if (typeof template === 'object' && template !== null && !Array.isArray(template)) {
    const value = template as Record<string, unknown>;
    if (typeof value['name'] === 'string' && value['name'].trim() !== '' &&
        typeof value['language'] === 'string' && value['language'].trim() !== '') {
      return {
        type: 'template', text: null,
        templateName: value['name'].trim(), templateLanguage: value['language'].trim(),
      };
    }
  }
  return null;
}

/**
 * A stored catalogue template: `undefined` when the content is not one,
 * `null` when it is one that can no longer be read.
 */
function boundContent(content: Readonly<Record<string, unknown>>):
  { readonly id: string; readonly name: string; readonly language: string; readonly parameters: TemplateBindings } | null | undefined {
  const template = content['template'];
  if (typeof template !== 'object' || template === null || Array.isArray(template) || !('id' in template)) return undefined;
  const value = template as Record<string, unknown>;
  const parameters = parseTemplateBindings(value['parameters']);
  const { id, name, language } = value;
  return typeof id === 'string' && typeof name === 'string' && typeof language === 'string' && parameters !== null
    ? { id, name, language, parameters } : null;
}

/** Pure policy evaluated from the locked database projection at dispatch time. */
export function campaignDispatchRefusal(
  row: CampaignPermitState | undefined,
  now: number,
): CampaignDispatchRefusal | null {
  if (row === undefined) {
    return { reason: 'campaign_recipient_missing', detail: 'The campaign recipient no longer exists.' };
  }
  if (row.execution_state !== 'running' || row.campaign_state !== 'running') {
    return { reason: 'campaign_stopped', detail: 'The campaign is not running.' };
  }
  if (row.recipient_state !== 'in_flight') {
    return { reason: 'campaign_recipient_stale', detail: 'The recipient is no longer dispatchable.' };
  }
  if (row.campaign_stop_version !== row.execution_stop_version) {
    return { reason: 'campaign_fence_changed', detail: 'The campaign changed after this command was planned.' };
  }
  if (!row.approved) {
    return { reason: 'campaign_approval_revoked', detail: 'The approved revision is no longer live.' };
  }
  if (row.expires_at !== null && row.expires_at.getTime() <= now) {
    return { reason: 'campaign_expired', detail: 'The campaign expired before dispatch.' };
  }
  if (row.consent_state !== 'granted') {
    return { reason: 'marketing_consent_missing', detail: 'Marketing consent is not currently granted.' };
  }
  return null;
}

export interface CampaignOutcomeProjection {
  readonly recipientState: 'queued' | 'accepted' | 'failed' | 'outcome_unknown';
  readonly budgetState: 'committed' | 'released' | 'held_unknown' | null;
  readonly finishesAttempt: boolean;
}

/** Keeps command outcomes and campaign recipient/budget outcomes in one mapping. */
export function campaignOutcomeProjection(
  outcome: 'accepted' | 'rejected' | 'outcome_unknown' | 'retry',
): CampaignOutcomeProjection {
  if (outcome === 'retry') {
    return { recipientState: 'queued', budgetState: null, finishesAttempt: false };
  }
  if (outcome === 'accepted') {
    return { recipientState: 'accepted', budgetState: 'committed', finishesAttempt: true };
  }
  if (outcome === 'rejected') {
    return { recipientState: 'failed', budgetState: 'released', finishesAttempt: true };
  }
  return { recipientState: 'outcome_unknown', budgetState: 'held_unknown', finishesAttempt: true };
}
