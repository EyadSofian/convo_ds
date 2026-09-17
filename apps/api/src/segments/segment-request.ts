import type { ConditionDocument } from '@convo/domain';
import { validateConditionDocument } from '@convo/domain';
import { ApiHttpError } from '../http-error.js';

export type ViewResource = 'conversations' | 'contacts';
export type ViewVisibility = 'private' | 'team' | 'workspace';

export interface SavedViewInput {
  readonly name: string;
  readonly resource: ViewResource;
  readonly visibility: ViewVisibility;
  readonly teamId: string | null;
  readonly conditions: ConditionDocument;
}

export interface AudienceInput {
  readonly name: string;
  readonly description: string | null;
  readonly conditions: ConditionDocument;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseSavedView(body: unknown): SavedViewInput {
  const value = record(body);
  const name = text(value['name'], 100);
  const resource = value['resource'];
  const visibility = value['visibility'];
  const teamId = value['teamId'] ?? null;
  const viewResource: ViewResource | null = resource === 'contacts' || resource === 'conversations' ? resource : null;
  const context = viewResource === 'contacts' ? 'audience' : viewResource === 'conversations' ? 'conversation' : null;
  const checked = context === null ? null : validateConditionDocument(value['conditions'], context);
  const validTeam = visibility === 'team' ? typeof teamId === 'string' && UUID.test(teamId) : teamId === null;
  if (name === null || context === null || !['private', 'team', 'workspace'].includes(String(visibility)) || !validTeam || checked === null || !checked.ok) {
    throw invalid(checked !== null && !checked.ok ? checked.issues : []);
  }
  return { name, resource: viewResource as ViewResource, visibility: visibility as ViewVisibility, teamId: teamId as string | null, conditions: checked.value };
}

export function parseAudience(body: unknown): AudienceInput {
  const value = record(body);
  const name = text(value['name'], 120);
  const description = value['description'] === null || value['description'] === undefined ? null : text(value['description'], 500);
  const checked = validateConditionDocument(value['conditions'], 'audience');
  if (name === null || description === null && value['description'] !== null && value['description'] !== undefined || !checked.ok) {
    throw invalid(checked.ok ? [] : checked.issues);
  }
  return { name, description, conditions: checked.value };
}

export function parseVersioned<T>(body: unknown, parser: (body: unknown) => T): { readonly version: number; readonly value: T } {
  const value = record(body);
  const version = value['version'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw invalid([]);
  return { version, value: parser(value) };
}

export function parseVersion(body: unknown): number {
  const value = record(body)['version'];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw invalid([]);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max ? normalized : null;
}

function invalid(issues: readonly { readonly path: string; readonly code: string }[]): ApiHttpError {
  return new ApiHttpError(400, 'validation_failed', 'The segment definition is not valid.', issues.map((issue) => ({ field: issue.path, code: issue.code, message: 'Use an allowed field, operator and bounded value.' })));
}
