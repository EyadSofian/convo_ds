import { ApiHttpError } from '../http-error.js';

export type QuickReplyKind = 'text' | 'location';

export interface QuickReplyLocation {
  readonly name: string;
  readonly address: string | null;
  readonly latitude: number;
  readonly longitude: number;
}

export interface QuickReplyInput {
  readonly shortcut: string;
  readonly title: string;
  readonly kind: QuickReplyKind;
  /** The text a text reply sends, or the optional note under a location. */
  readonly body: string;
  readonly location: QuickReplyLocation | null;
}

/**
 * A shortcut is what follows "/" in the composer: one word, no spaces and no
 * slash, compared without case. Arabic letters are words too.
 */
const SHORTCUT = /^[^\s/]{1,32}$/u;

export function parseQuickReply(body: unknown): QuickReplyInput {
  const value = record(body);
  const issues: { field: string; code: string }[] = [];
  const rawShortcut = typeof value['shortcut'] === 'string' ? value['shortcut'].trim().replace(/^\//, '').toLowerCase() : '';
  if (!SHORTCUT.test(rawShortcut)) issues.push({ field: 'shortcut', code: 'invalid' });
  const title = text(value['title'], 80);
  if (title === null) issues.push({ field: 'title', code: 'invalid' });
  const kind = value['kind'] === undefined ? 'text' : value['kind'];
  if (kind !== 'text' && kind !== 'location') issues.push({ field: 'kind', code: 'invalid' });
  const rawBody = typeof value['body'] === 'string' ? value['body'].trim() : value['body'] === undefined || value['body'] === null ? '' : null;
  if (rawBody === null || rawBody.length > 4000 || (kind === 'text' && rawBody === '')) issues.push({ field: 'body', code: 'invalid' });
  const location = kind === 'location' ? parseLocation(value['location'], issues) : null;
  if (issues.length > 0) {
    throw new ApiHttpError(400, 'validation_failed', 'The quick reply is not valid.', issues.map((issue) => ({ ...issue, message: messageFor(issue.field) })));
  }
  return { shortcut: rawShortcut, title: title as string, kind: kind as QuickReplyKind, body: rawBody as string, location };
}

export function parseVersioned(body: unknown): { readonly version: number; readonly value: QuickReplyInput } {
  return { version: parseVersion(body), value: parseQuickReply(body) };
}

export function parseVersion(body: unknown): number {
  const version = record(body)['version'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new ApiHttpError(400, 'validation_failed', 'The quick reply is not valid.', [{ field: 'version', code: 'invalid', message: 'Send the version you last read.' }]);
  }
  return version;
}

function parseLocation(raw: unknown, issues: { field: string; code: string }[]): QuickReplyLocation | null {
  const value = record(raw);
  const name = text(value['name'], 120);
  const address = value['address'] === undefined || value['address'] === null || value['address'] === '' ? null : text(value['address'], 300);
  const latitude = coordinate(value['latitude'], 90);
  const longitude = coordinate(value['longitude'], 180);
  if (name === null) issues.push({ field: 'location.name', code: 'invalid' });
  if (address === null && !(value['address'] === undefined || value['address'] === null || value['address'] === '')) issues.push({ field: 'location.address', code: 'invalid' });
  if (latitude === null) issues.push({ field: 'location.latitude', code: 'invalid' });
  if (longitude === null) issues.push({ field: 'location.longitude', code: 'invalid' });
  if (name === null || latitude === null || longitude === null) return null;
  return { name, address, latitude, longitude };
}

function coordinate(value: unknown, limit: number): number | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

function messageFor(field: string): string {
  if (field === 'shortcut') return 'Use one word of up to 32 characters, without spaces or "/".';
  if (field.startsWith('location.')) return 'Give the place a name and a latitude and longitude.';
  return 'Use a non-empty value within the allowed length.';
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max ? normalized : null;
}
