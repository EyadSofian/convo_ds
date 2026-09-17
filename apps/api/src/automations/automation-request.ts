import { AUTOMATION_TRIGGERS, validateAutomationWorkflow, type AutomationTrigger, type AutomationWorkflow } from '@convo/domain';
import { ApiHttpError } from '../http-error.js';

export interface AutomationInput { readonly name: string; readonly description: string | null; readonly timezone: string; readonly workflow: AutomationWorkflow }
export function parseAutomation(input: unknown): AutomationInput {
  const value = object(input); const result = validateAutomationWorkflow(value?.['workflow']);
  if (value === null || typeof value['name'] !== 'string' || value['name'].trim().length < 1 || value['name'].length > 160 || (value['description'] !== undefined && value['description'] !== null && typeof value['description'] !== 'string') || typeof value['timezone'] !== 'string' || value['timezone'].length < 1 || value['timezone'].length > 100 || !result.ok) throw invalid(result.ok ? [] : result.issues);
  try { new Intl.DateTimeFormat('en', { timeZone: value['timezone'] }).format(); } catch { throw invalid([{ path: '$.timezone', code: 'invalid_timezone' }]); }
  return { name: value['name'].trim(), description: typeof value['description'] === 'string' ? value['description'].trim() || null : null, timezone: value['timezone'], workflow: result.value };
}
export function parseVersion(input: unknown): number { const value = object(input)?.['version']; if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw invalid([]); return value; }
export function parseVersioned(input: unknown): { readonly version: number; readonly value: AutomationInput } { const value = object(input); return { version: parseVersion(input), value: parseAutomation(value) }; }
export interface AutomationEventInput { readonly type:AutomationTrigger; readonly payload:Readonly<Record<string,unknown>>; readonly idempotencyKey:string; readonly occurredAt:Date }
export function parseAutomationEvent(input:unknown):AutomationEventInput{const value=object(input);const type=value?.['type'];const payload=object(value?.['payload']);const key=value?.['idempotencyKey'];const occurred=value?.['occurredAt'];if(typeof type!=='string'||!(AUTOMATION_TRIGGERS as readonly string[]).includes(type)||payload===null||typeof key!=='string'||key.trim()===''||key.length>200||typeof occurred!=='string'||!Number.isFinite(Date.parse(occurred)))throw invalid([]);return{type:type as AutomationTrigger,payload,idempotencyKey:key,occurredAt:new Date(occurred)};}
function object(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function invalid(issues: readonly { readonly path: string; readonly code: string }[]): ApiHttpError { return new ApiHttpError(400, 'validation_failed', 'The automation definition is invalid.', issues.map((issue) => ({ field: issue.path, code: issue.code, message: 'Correct this workflow value.' }))); }
