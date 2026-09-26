import { bindingVariable, isBindingVariable, parseTemplateBindings, variableKeyOf } from '@convo/domain';
import type { TemplateBindings } from '@convo/domain';
import { ApiHttpError } from '../http-error.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CampaignDraftInput {
  readonly name: string;
  readonly objective: string | null;
  readonly connectionId: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly audienceFilter: AudienceFilterInput;
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

/**
 * Who a campaign is addressed to, within the contacts that hold an identity on
 * its channel. Every list narrows; an absent or empty list does not.
 *
 * - `search`: the display name contains this text.
 * - `labelIds`: the contact carries **every** one of these contact labels.
 * - `conversationLabelIds`: at least one of the contact's conversations
 *   carries **any** of these labels — "people from conversations labelled X".
 * - `contactIds`: the contact is one of these, hand-picked.
 */
export interface AudienceFilterInput {
  readonly search?: string;
  readonly labelIds?: readonly string[];
  readonly conversationLabelIds?: readonly string[];
  readonly contactIds?: readonly string[];
}

export interface AudiencePreviewInput {
  readonly connectionId: string;
  readonly audienceFilter: AudienceFilterInput;
}

const AUDIENCE_LISTS: Readonly<Record<'labelIds' | 'conversationLabelIds' | 'contactIds', number>> = {
  labelIds: 20,
  conversationLabelIds: 20,
  contactIds: 1000,
};
const AUDIENCE_KEYS = new Set(['search', ...Object.keys(AUDIENCE_LISTS)]);

/**
 * The audience filter, normalised, or `undefined` when it is malformed. An
 * unknown key is refused rather than ignored: a misspelt narrowing that was
 * silently dropped would send to more people than the operator chose.
 */
export function parseAudienceFilter(input: unknown): AudienceFilterInput | undefined {
  const filter = recordOrNull(input);
  if (filter === null || Object.keys(filter).some((key) => !AUDIENCE_KEYS.has(key))) return undefined;
  const normalised: { search?: string; labelIds?: readonly string[]; conversationLabelIds?: readonly string[]; contactIds?: readonly string[] } = {};
  const search = filter['search'];
  if (search !== undefined) {
    if (typeof search !== 'string' || search.trim().length > 120) return undefined;
    if (search.trim() !== '') normalised.search = search.trim();
  }
  for (const [key, limit] of Object.entries(AUDIENCE_LISTS) as [keyof typeof AUDIENCE_LISTS, number][]) {
    const list = filter[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > limit || !list.every((id) => typeof id === 'string' && UUID.test(id))) return undefined;
    if (list.length > 0) normalised[key] = [...new Set(list as readonly string[])];
  }
  return normalised;
}

export function parseAudiencePreview(body: unknown): AudiencePreviewInput {
  const value = record(body);
  const connectionId = value['connectionId'];
  const audienceFilter = value['audienceFilter'] === undefined ? {} : parseAudienceFilter(value['audienceFilter']);
  if (typeof connectionId !== 'string' || !UUID.test(connectionId) || audienceFilter === undefined) {
    throw invalid('Choose a channel and a valid audience filter.');
  }
  return { connectionId, audienceFilter };
}

export interface CampaignExportInput {
  readonly format: 'csv';
  readonly campaignId: string | null;
}

export function parseCampaignDraft(body: unknown): CampaignDraftInput {
  const value = record(body);
  const name = text(value['name'], 160);
  const objective = value['objective'] === undefined || value['objective'] === null
    ? null : text(value['objective'], 500);
  const connectionId = value['connectionId'];
  const content = recordOrNull(value['content']);
  const variables = value['variables'] === undefined ? {} : recordOrNull(value['variables']);
  const audienceFilter = value['audienceFilter'] === undefined ? {} : parseAudienceFilter(value['audienceFilter']);
  const timezone = value['timezone'] === undefined ? 'UTC' : text(value['timezone'], 80);
  const expiresAt = optionalInstant(value['expiresAt']);
  const amount = value['budgetAmountMinor'] === undefined ? 0 : value['budgetAmountMinor'];
  const currency = value['budgetCurrency'] === undefined ? 'USD' : value['budgetCurrency'];
  if (name === null || objective === null && value['objective'] !== undefined && value['objective'] !== null ||
      typeof connectionId !== 'string' || !UUID.test(connectionId) || content === null || Object.keys(content).length === 0 ||
      variables === null || !validVariables(variables) || audienceFilter === undefined || timezone === null || expiresAt === undefined ||
      typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0 ||
      typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw invalid('The campaign draft is not valid.');
  }
  const bound = boundTemplateOf(content);
  return { name, objective, connectionId, audienceFilter, timezone, expiresAt, budgetAmountMinor: amount, budgetCurrency: currency,
    ...(bound === null ? { content, variables } : boundDraft(bound)) };
}

/** A broadcast of an approved template whose every `{{n}}` names where its value comes from. */
export interface BoundTemplate {
  readonly id: string;
  readonly parameters: TemplateBindings;
}

/**
 * The template a broadcast sends, when it names one from the catalogue by id.
 * `null` for any other content — text, or the older name-only template — which
 * keeps working as it did. A catalogue template that is malformed is refused.
 */
export function boundTemplateOf(content: Readonly<Record<string, unknown>>): BoundTemplate | null {
  const template = recordOrNull(content['template']);
  if (template === null || template['id'] === undefined) return null;
  const id = template['id'];
  const parameters = parseTemplateBindings(template['parameters'] ?? {});
  if (typeof id !== 'string' || !UUID.test(id) || parameters === null) {
    throw invalid('Choose an approved template and say where each of its variables comes from.');
  }
  return { id: id.toLowerCase(), parameters };
}

/**
 * The stored content and variables of a bound template. The variables are the
 * server's own derivation of the bindings — one per parameter — so a frozen
 * audience resolves exactly what the template needs and nothing a client sent.
 * The name and language are filled in from the catalogue when it is checked.
 */
function boundDraft(bound: BoundTemplate): Pick<CampaignDraftInput, 'content' | 'variables'> {
  return {
    content: { type: 'template', template: { id: bound.id, parameters: bound.parameters } },
    variables: Object.fromEntries(Object.entries(bound.parameters).map(([key, binding]) => [variableKeyOf(key), bindingVariable(binding)])),
  };
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
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && isBindingVariable(source));
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

export function parseCampaignExport(body: unknown): CampaignExportInput {
  const value = recordOrNull(body);
  if (value === null || value['format'] !== 'csv' ||
      Object.keys(value).some((key) => key !== 'format' && key !== 'campaignId')) {
    throw invalid('Choose the csv export format and an optional campaignId.');
  }
  const campaignId = value['campaignId'] === undefined || value['campaignId'] === null
    ? null : value['campaignId'];
  if (campaignId !== null && (typeof campaignId !== 'string' || !UUID.test(campaignId))) {
    throw invalid('campaignId must identify a campaign in this company.');
  }
  return { format: 'csv', campaignId };
}

export interface CampaignReportFilters {
  /** The first included UTC calendar day, as the caller wrote it. */
  readonly from: string | null;
  /** The last included UTC calendar day, as the caller wrote it. */
  readonly to: string | null;
  readonly channel: string | null;
  readonly campaignId: string | null;
  /** `from` as the inclusive instant the query compares launches against. */
  readonly fromAt: string | null;
  /** The instant after the whole `to` day, so the day itself is included. */
  readonly toExclusiveAt: string | null;
}

const REPORT_FILTER_KEYS = new Set(['from', 'to', 'channel', 'campaignId']);
const REPORT_CHANNELS = new Set(['whatsapp', 'messenger', 'instagram', 'web_chat', 'custom']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Report scope from the query string.
 *
 * Days rather than instants: a report period is a calendar question, and the
 * report publishes UTC, so a day here is a UTC day. An unknown key is refused
 * rather than ignored — a misspelt filter that silently widened the report
 * would be read as the narrowed one.
 */
export function parseReportFilters(query: unknown): CampaignReportFilters {
  const value = record(query);
  if (Object.keys(value).some((key) => !REPORT_FILTER_KEYS.has(key))) {
    throw invalid('Filter the report by from, to, channel or campaignId only.');
  }
  const from = reportDay(value['from']);
  const to = reportDay(value['to']);
  const channel = value['channel'] === undefined ? null : value['channel'];
  const campaignId = value['campaignId'] === undefined ? null : value['campaignId'];
  if (from === undefined || to === undefined) {
    throw invalid('from and to must be calendar days written as YYYY-MM-DD.');
  }
  if (from !== null && to !== null && from > to) {
    throw invalid('from must not be after to.');
  }
  if (channel !== null && (typeof channel !== 'string' || !REPORT_CHANNELS.has(channel))) {
    throw invalid('channel must be one of whatsapp, messenger, instagram, web_chat or custom.');
  }
  if (campaignId !== null && (typeof campaignId !== 'string' || !UUID.test(campaignId))) {
    throw invalid('campaignId must identify a campaign in this company.');
  }
  return {
    from, to, channel, campaignId,
    fromAt: from === null ? null : `${from}T00:00:00.000Z`,
    toExclusiveAt: to === null ? null : new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000).toISOString(),
  };
}

/** undefined means malformed; null means absent. */
function reportDay(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !DAY.test(value)) return undefined;
  const instant = new Date(`${value}T00:00:00.000Z`);
  // `Date` rolls 2026-02-31 into March; a day that does not round-trip is not a day.
  return !Number.isNaN(instant.getTime()) && instant.toISOString().slice(0, 10) === value ? value : undefined;
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
