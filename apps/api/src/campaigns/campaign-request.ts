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

export interface CampaignUpdateInput extends CampaignDraftInput {
  readonly expectedVersion: number;
}

export interface TestRecipientInput {
  readonly peerIdentity: string;
  readonly label: string;
}

export interface CampaignTestSendInput {
  readonly testRecipientId: string;
  readonly expectedVersion: number;
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

export function parseCampaignUpdate(body: unknown): CampaignUpdateInput {
  const value = record(body);
  const expectedVersion = value['expectedVersion'];
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw invalid('expectedVersion must be a positive integer.');
  }
  return { ...parseCampaignDraft(body), expectedVersion };
}

export function parseTestRecipient(body: unknown): TestRecipientInput {
  const value = record(body);
  const peerIdentity = value['peerIdentity'];
  const label = text(value['label'], 120);
  if (typeof peerIdentity !== 'string' || !/^[A-Za-z0-9_.:+@-]{1,190}$/.test(peerIdentity.trim()) || label === null) {
    throw invalid('Provide a live channel identity and a label for the authorized test recipient.');
  }
  return { peerIdentity: peerIdentity.trim(), label };
}

export function parseCampaignTestSend(body: unknown): CampaignTestSendInput {
  const value = record(body);
  const testRecipientId = value['testRecipientId'];
  const expectedVersion = value['expectedVersion'];
  if (typeof testRecipientId !== 'string' || !UUID.test(testRecipientId) ||
      typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw invalid('Choose an authorized test recipient and provide the campaign version you reviewed.');
  }
  return { testRecipientId, expectedVersion };
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

export function parseCampaignClone(body: unknown): { readonly name: string } {
  const name = text(record(body)['name'], 160);
  if (name === null) throw invalid('Choose a name for the cloned campaign.');
  return { name };
}

export function parseCampaignRetry(body: unknown): Readonly<Record<string, never>> {
  const value = recordOrNull(body);
  if (value === null || Object.keys(value).length !== 0) {
    throw invalid('The failed-only retry request must be an empty object.');
  }
  return {};
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
