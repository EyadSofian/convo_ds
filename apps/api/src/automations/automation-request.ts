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
export type AutomationSort = 'name_asc' | 'name_desc' | 'updated_desc';
export interface AutomationListQuery {
  readonly search: string | null;
  readonly state: 'draft' | 'active' | 'paused' | 'archived' | null;
  readonly sort: AutomationSort;
  readonly cursor: string | null;
  readonly limit: number;
}
export interface AutomationRunsQuery { readonly cursor: string | null; readonly limit: number; }
export function parseAutomationListQuery(input: unknown): AutomationListQuery {
  const query = object(input) ?? {};
  const allowed = new Set(['search', 'state', 'sort', 'cursor', 'limit']);
  if (Object.keys(query).some((key) => !allowed.has(key))) throw invalid([]);
  const search = one(query['search']);
  const state = one(query['state']);
  const sort = one(query['sort']) ?? 'name_asc';
  const cursor = one(query['cursor']);
  const limit = number(query['limit'], 25, 100);
  if (search !== undefined && (search.length > 160 || search.trim() === '')) throw invalid([]);
  if (state !== undefined && !['draft', 'active', 'paused', 'archived'].includes(state)) throw invalid([]);
  if (!['name_asc', 'name_desc', 'updated_desc'].includes(sort)) throw invalid([]);
  if (cursor !== undefined && (cursor === '' || cursor.length > 4096)) throw invalid([]);
  return { search: search?.trim() || null, state: state as AutomationListQuery['state'] ?? null, sort: sort as AutomationSort, cursor: cursor ?? null, limit };
}
export function parseAutomationRunsQuery(input: unknown): AutomationRunsQuery {
  const query = object(input) ?? {};
  if (Object.keys(query).some((key) => key !== 'cursor' && key !== 'limit')) throw invalid([]);
  const cursor = one(query['cursor']);
  if (cursor !== undefined && (cursor === '' || cursor.length > 4096)) throw invalid([]);
  return { cursor: cursor ?? null, limit: number(query['limit'], 25, 100) };
}
export interface AutomationEventInput { readonly type:AutomationTrigger; readonly payload:Readonly<Record<string,unknown>>; readonly idempotencyKey:string; readonly occurredAt:Date }
export function parseAutomationEvent(input:unknown):AutomationEventInput{const value=object(input);const type=value?.['type'];const payload=object(value?.['payload']);const key=value?.['idempotencyKey'];const occurred=value?.['occurredAt'];if(typeof type!=='string'||!(AUTOMATION_TRIGGERS as readonly string[]).includes(type)||payload===null||typeof key!=='string'||key.trim()===''||key.length>200||typeof occurred!=='string'||!Number.isFinite(Date.parse(occurred)))throw invalid([]);return{type:type as AutomationTrigger,payload,idempotencyKey:key,occurredAt:new Date(occurred)};}
function object(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function one(value: unknown): string | undefined { if (value === undefined) return undefined; if (typeof value !== 'string') throw invalid([]); return value; }
function number(value: unknown, fallback: number, max: number): number { if (value === undefined) return fallback; if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw invalid([]); const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed > max) throw invalid([]); return parsed; }
function invalid(issues: readonly { readonly path: string; readonly code: string }[]): ApiHttpError { return new ApiHttpError(400, 'validation_failed', 'The automation definition is invalid.', issues.map((issue) => ({ field: issue.path, code: issue.code, message: 'Correct this workflow value.' }))); }
