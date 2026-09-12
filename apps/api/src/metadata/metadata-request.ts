import type { CustomFieldTarget, CustomFieldType } from '@convo/domain';
import { isCustomFieldTarget, isCustomFieldType } from '@convo/domain';
import { ApiHttpError } from '../http-error.js';
import type { MetadataMutation } from './metadata.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_]{0,49}$/;
const COLOR = /^#[0-9a-f]{6}$/i;

export function parseLabelCreate(body: unknown): { readonly name: string; readonly color: string } {
  const record = object(body);
  const name = bounded(record['name'], 60);
  const color = record['color'];
  if (name === null || typeof color !== 'string' || !COLOR.test(color)) {
    throw invalid('A label needs a name and a six-digit hex color.');
  }
  return { name, color: color.toUpperCase() };
}

export function parseLabelUpdate(body: unknown): {
  readonly version: number;
  readonly name?: string;
  readonly color?: string;
} {
  const record = object(body);
  const version = positiveVersion(record['version']);
  const name = record['name'] === undefined ? undefined : bounded(record['name'], 60);
  const rawColor = record['color'];
  const color = rawColor === undefined ? undefined : typeof rawColor === 'string' && COLOR.test(rawColor) ? rawColor.toUpperCase() : null;
  if (version === null || name === null || color === null || (name === undefined && color === undefined)) {
    throw invalid('Send the version and at least one valid label field.');
  }
  return { version, ...(name === undefined ? {} : { name }), ...(color === undefined ? {} : { color }) };
}

export function parseVersion(body: unknown): number {
  const version = positiveVersion(object(body)['version']);
  if (version === null) throw invalid('A positive integer version is required.');
  return version;
}

export function parseFieldCreate(body: unknown): {
  readonly target: CustomFieldTarget;
  readonly key: string;
  readonly name: string;
  readonly type: CustomFieldType;
  readonly options: readonly string[];
} {
  const record = object(body);
  const target = record['target'];
  const type = record['type'];
  const key = record['key'];
  const name = bounded(record['name'], 80);
  const options = parseOptions(record['options'] ?? []);
  if (typeof target !== 'string' || !isCustomFieldTarget(target) || typeof type !== 'string' || !isCustomFieldType(type) || typeof key !== 'string' || !KEY.test(key) || name === null || options === null || !optionsFit(type, options)) {
    throw invalid('The custom-field definition is not valid.');
  }
  return { target, key, name, type, options };
}

export function parseFieldUpdate(body: unknown): {
  readonly version: number;
  readonly name?: string;
  readonly options?: readonly string[];
} {
  const record = object(body);
  const version = positiveVersion(record['version']);
  const name = record['name'] === undefined ? undefined : bounded(record['name'], 80);
  const options = record['options'] === undefined ? undefined : parseOptions(record['options']);
  if (version === null || name === null || options === null || (name === undefined && options === undefined)) {
    throw invalid('Send the version and at least one valid field property.');
  }
  return { version, ...(name === undefined ? {} : { name }), ...(options === undefined ? {} : { options }) };
}

export function parseMutation(body: unknown): MetadataMutation {
  const record = object(body);
  const version = positiveVersion(record['version']);
  const rawAddLabels = record['addLabels'] ?? [];
  const rawRemoveLabels = record['removeLabels'] ?? [];
  const addLabels = uuidList(rawAddLabels);
  const removeLabels = uuidList(rawRemoveLabels);
  const rawFields = record['fields'] ?? [];
  const fields = Array.isArray(rawFields)
    ? rawFields.flatMap((item) => {
        const entry = objectOrNull(item);
        return entry !== null && typeof entry['fieldId'] === 'string' && UUID.test(entry['fieldId']) && 'value' in entry
          ? [{ fieldId: entry['fieldId'], value: entry['value'] ?? null }]
          : [];
      })
    : [];
  const fieldIds = fields.map((entry) => entry.fieldId);
  const overlap = addLabels.some((id) => removeLabels.includes(id));
  const malformed =
    version === null ||
    addLabels.length !== (Array.isArray(rawAddLabels) ? rawAddLabels.length : -1) ||
    removeLabels.length !== (Array.isArray(rawRemoveLabels) ? rawRemoveLabels.length : -1) ||
    fields.length !== (Array.isArray(rawFields) ? rawFields.length : -1) ||
    new Set(fieldIds).size !== fieldIds.length ||
    overlap ||
    (addLabels.length === 0 && removeLabels.length === 0 && fields.length === 0);
  if (malformed) throw invalid('The metadata change is empty or malformed.');
  return { version, addLabels, removeLabels, fields };
}

export function parseTarget(value: string | undefined): CustomFieldTarget | null {
  if (value === undefined || value === '') return null;
  if (!isCustomFieldTarget(value)) throw invalid('target must be contact or conversation.');
  return value;
}

export function parseBoolean(value: string | undefined): boolean {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw invalid('The boolean query value must be true or false.');
}

function optionsFit(type: CustomFieldType, options: readonly string[]): boolean {
  const select = type === 'single_select' || type === 'multi_select';
  return select ? options.length > 0 : options.length === 0;
}

function parseOptions(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const options = value.flatMap((entry) => {
    const option = bounded(entry, 80);
    return option === null ? [] : [option];
  });
  return options.length === value.length && new Set(options).size === options.length ? options : null;
}

function uuidList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && UUID.test(entry))
    : [];
}

function positiveVersion(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function bounded(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function object(value: unknown): Record<string, unknown> {
  return objectOrNull(value) ?? {};
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalid(message: string): ApiHttpError {
  return new ApiHttpError(400, 'validation_failed', message);
}
