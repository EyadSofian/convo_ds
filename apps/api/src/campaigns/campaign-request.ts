import { ApiHttpError } from '../http-error.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CampaignDraftInput {
  readonly name: string;
  readonly objective: string | null;
  readonly connectionId: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly audienceFilter: Readonly<Record<string, unknown>>;
  readonly timezone: string;
  readonly expiresAt: string | null;
  readonly budgetAmountMinor: number;
  readonly budgetCurrency: string;
}

export function parseCampaignDraft(body: unknown): CampaignDraftInput {
  const value = record(body);
  const name = text(value['name'], 160);
  const objective = value['objective'] === undefined || value['objective'] === null
    ? null : text(value['objective'], 500);
  const connectionId = value['connectionId'];
  const content = recordOrNull(value['content']);
  const variables = value['variables'] === undefined ? {} : recordOrNull(value['variables']);
  const audienceFilter = value['audienceFilter'] === undefined ? {} : recordOrNull(value['audienceFilter']);
  const timezone = value['timezone'] === undefined ? 'UTC' : text(value['timezone'], 80);
  const expiresAt = optionalInstant(value['expiresAt']);
  const amount = value['budgetAmountMinor'] === undefined ? 0 : value['budgetAmountMinor'];
  const currency = value['budgetCurrency'] === undefined ? 'USD' : value['budgetCurrency'];
  if (name === null || objective === null && value['objective'] !== undefined && value['objective'] !== null ||
      typeof connectionId !== 'string' || !UUID.test(connectionId) || content === null || Object.keys(content).length === 0 ||
      variables === null || !validVariables(variables) || audienceFilter === null || timezone === null || expiresAt === undefined ||
      typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0 ||
      typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw invalid('The campaign draft is not valid.');
  }
  return { name, objective, connectionId, content, variables, audienceFilter, timezone,
    expiresAt, budgetAmountMinor: amount, budgetCurrency: currency };
}

function validVariables(variables: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(variables).every(([key, source]) =>
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && source === 'display_name');
}

export function parseCampaignLaunch(body: unknown): { readonly scheduledFor: string | null } {
  const value = record(body);
  if (value['mode'] === 'now' && value['scheduledFor'] === undefined) return { scheduledFor: null };
  const instant = optionalInstant(value['scheduledFor']);
  if (value['mode'] !== 'scheduled' || instant === null || instant === undefined || Date.parse(instant) <= Date.now()) {
    throw invalid('Choose now, or a future scheduledFor instant.');
  }
  return { scheduledFor: instant };
}

export function parseCampaignControl(body: unknown): 'pause' | 'resume' | 'cancel' {
  const action = record(body)['action'];
  if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
    throw invalid('action must be pause, resume or cancel.');
  }
  return action;
}

function record(value: unknown): Record<string, unknown> {
  return recordOrNull(value) ?? {};
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

/** undefined means malformed; null means intentionally absent. */
function optionalInstant(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function invalid(message: string): ApiHttpError {
  return new ApiHttpError(400, 'validation_failed', message);
}
