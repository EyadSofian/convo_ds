import type { ConditionDocument } from '../conditions/condition.js';
import { validateConditionDocument } from '../conditions/condition.js';
import { validateScheduleDefinition } from './schedule.js';

export const AUTOMATION_TRIGGERS = [
  'customer_created','customer_updated','custom_field_changed','label_added','label_removed',
  'conversation_created','conversation_assigned','conversation_closed','conversation_reopened',
  'inbound_message_created','outbound_message_created','customer_replied','no_reply_for_duration',
  'schedule','manual','custom_event','student_enrolled','course_starting','session_created',
  'session_scheduled','session_starting','attendance_updated','course_completed',
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const AUTOMATION_STEP_TYPES = [
  'condition','delay','send_whatsapp_template','add_label','remove_label','assign_team',
  'assign_agent','update_customer_field','create_internal_notification','webhook',
] as const;
export type AutomationStepType = (typeof AUTOMATION_STEP_TYPES)[number];
export const AUTOMATION_TARGETS = ['single_customer','dynamic_audience','label','saved_view','course_context','matching_conditions'] as const;
export type AutomationTargetType = (typeof AUTOMATION_TARGETS)[number];
export const AUTOMATION_SCHEDULE_KINDS = ['one_time','daily','weekly','monthly','custom_recurrence','relative'] as const;

export interface AutomationStep { readonly id: string; readonly type: AutomationStepType; readonly conditions?: ConditionDocument; readonly config: Readonly<Record<string, unknown>> }
export interface AutomationWorkflow {
  readonly version: 1;
  readonly trigger: { readonly type: AutomationTrigger; readonly config: Readonly<Record<string, unknown>> };
  readonly target: { readonly type: AutomationTargetType; readonly config: Readonly<Record<string, unknown>> };
  readonly steps: readonly AutomationStep[];
  readonly schedule?: Readonly<Record<string, unknown>>;
  readonly safety: { readonly approvalRequired: boolean; readonly duplicateWindowSeconds: number };
}
export interface WorkflowIssue { readonly path: string; readonly code: string }
export type WorkflowValidation = { readonly ok: true; readonly value: AutomationWorkflow } | { readonly ok: false; readonly issues: readonly WorkflowIssue[] };
const ID = /^[a-z][a-z0-9_-]{0,63}$/;

export function validateAutomationWorkflow(input: unknown): WorkflowValidation {
  const issues: WorkflowIssue[] = []; const value = record(input); const trigger = record(value?.['trigger']); const target = record(value?.['target']); const safety = record(value?.['safety']); const steps = value?.['steps'];
  if (value?.['version'] !== 1) issues.push({ path: '$.version', code: 'unsupported_version' });
  if (!member(trigger?.['type'], AUTOMATION_TRIGGERS) || record(trigger?.['config']) === null) issues.push({ path: '$.trigger', code: 'invalid_trigger' });
  if (!member(target?.['type'], AUTOMATION_TARGETS) || record(target?.['config']) === null) issues.push({ path: '$.target', code: 'invalid_target' });
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 50) issues.push({ path: '$.steps', code: 'invalid_step_count' });
  else { const ids = new Set<string>(); steps.forEach((candidate, index) => { const step = record(candidate); const path = `$.steps[${String(index)}]`; if (typeof step?.['id'] !== 'string' || !ID.test(step['id']) || ids.has(step['id'])) issues.push({ path: `${path}.id`, code: 'invalid_or_duplicate_id' }); else ids.add(step['id']); if (!member(step?.['type'], AUTOMATION_STEP_TYPES) || record(step?.['config']) === null) issues.push({ path, code: 'invalid_step' }); if (step?.['type'] === 'condition') { const result = validateConditionDocument(step['conditions'], 'automation'); if (!result.ok) issues.push(...result.issues.map((issue) => ({ path: `${path}.conditions${issue.path.slice(1)}`, code: issue.code }))); } }); }
  if (typeof safety?.['approvalRequired'] !== 'boolean' || !integer(safety?.['duplicateWindowSeconds'], 0, 31_536_000)) issues.push({ path: '$.safety', code: 'invalid_safety' });
  if (value?.['schedule'] !== undefined) issues.push(...validateScheduleDefinition(value['schedule']));
  if (trigger?.['type'] === 'schedule' && value?.['schedule'] === undefined) issues.push({ path: '$.schedule', code: 'required' });
  return issues.length === 0 ? { ok: true, value: input as AutomationWorkflow } : { ok: false, issues };
}

export function validateVariableMapping(input: unknown, requiredVariables: readonly string[]): readonly WorkflowIssue[] {
  const mapping = record(input); const issues: WorkflowIssue[] = []; if (mapping === null) return [{ path: '$', code: 'invalid_mapping' }];
  for (const variable of requiredVariables) { const source = record(mapping[variable]); if (source === null || typeof source['type'] !== 'string') issues.push({ path: `$.${variable}`, code: 'required' }); }
  for (const key of Object.keys(mapping)) if (!requiredVariables.includes(key)) issues.push({ path: `$.${key}`, code: 'unknown_variable' });
  return issues;
}
function member<T extends string>(value: unknown, values: readonly T[]): value is T { return typeof value === 'string' && (values as readonly string[]).includes(value); }
function integer(value: unknown, min: number, max: number): boolean { return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max; }
function record(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
