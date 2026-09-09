import type { ErrorDetail } from '@convo/contracts';
import type { ChannelKind } from '@convo/domain';
import { isChannelKind } from '@convo/domain';

/**
 * Request parsing for the channel operations.
 *
 * Total and pure, like the People parsers: a service below this line never asks
 * "is this a string". The asset identifier is deliberately permissive about
 * *shape* — a phone number id, a Page id and a widget id look nothing alike —
 * and strict about *character set*, because it ends up in a fingerprint and in
 * a provider URL.
 */

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly details: readonly ErrorDetail[] };

export interface ConnectChannelRequest {
  readonly kind: ChannelKind;
  readonly externalAssetId: string;
  readonly displayName: string;
  /** The provider grant. Never returned, never logged. */
  readonly accessToken: string;
  readonly appId: string | null;
}

export interface RotateCredentialRequest {
  readonly accessToken: string;
}

const ASSET_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_NAME = 80;
const MIN_TOKEN = 8;
const MAX_TOKEN = 4096;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function malformedBody(): ParseResult<never> {
  return {
    ok: false,
    details: [{ field: 'body', code: 'malformed', message: 'The body must be an object.' }],
  };
}

/**
 * Whether a value can safely become part of an HTTP header.
 *
 * Printable ASCII only, no space. Written as a code-point walk rather than a
 * regex with control-character escapes because that is what it actually means:
 * a newline or a NUL in a token is a header-injection primitive, not a
 * formatting quirk to trim.
 */
function isHeaderSafe(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code >= 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * The token check is a length and character-class check only.
 *
 * There is deliberately no attempt to recognise a "valid-looking" provider
 * token: guessing at a format here would reject a legitimate token the day a
 * provider changes it, and the only real proof is `validateConnection` calling
 * the provider. What this does stop is an empty string or a newline-bearing
 * value reaching a header.
 */
function parseToken(raw: unknown, details: ErrorDetail[]): string {
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (token.length < MIN_TOKEN || token.length > MAX_TOKEN || !isHeaderSafe(token)) {
    details.push({
      field: 'accessToken',
      code: 'malformed',
      message: `Provide the provider token: ${String(MIN_TOKEN)} to ${String(MAX_TOKEN)} characters, no whitespace.`,
    });
    return '';
  }
  return token;
}

export function parseConnectChannel(input: unknown): ParseResult<ConnectChannelRequest> {
  const record = asRecord(input);
  if (record === null) {
    return malformedBody();
  }
  const details: ErrorDetail[] = [];

  const rawKind = record['kind'];
  const kind = typeof rawKind === 'string' && isChannelKind(rawKind) ? rawKind : null;
  if (kind === null) {
    details.push({ field: 'kind', code: 'malformed', message: 'Choose a supported channel kind.' });
  }

  const assetId = typeof record['externalAssetId'] === 'string' ? record['externalAssetId'].trim() : '';
  if (!ASSET_ID.test(assetId)) {
    details.push({
      field: 'externalAssetId',
      code: 'malformed',
      message: 'The provider asset id is 1 to 128 characters of A-Z, a-z, 0-9, dot, colon, dash or underscore.',
    });
  }

  const displayName = typeof record['displayName'] === 'string' ? record['displayName'].trim() : '';
  if (displayName.length === 0 || displayName.length > MAX_NAME) {
    details.push({
      field: 'displayName',
      code: 'malformed',
      message: `Provide a name of 1 to ${String(MAX_NAME)} characters.`,
    });
  }

  const accessToken = parseToken(record['accessToken'], details);

  let appId: string | null = null;
  if ('appId' in record && record['appId'] !== null) {
    if (typeof record['appId'] !== 'string' || !UUID_PATTERN.test(record['appId'])) {
      details.push({ field: 'appId', code: 'malformed', message: 'Provide a channel app id.' });
    } else {
      appId = record['appId'];
    }
  }

  if (details.length > 0 || kind === null) {
    return { ok: false, details };
  }
  return { ok: true, value: { kind, externalAssetId: assetId, displayName, accessToken, appId } };
}

export function parseRotateCredential(input: unknown): ParseResult<RotateCredentialRequest> {
  const record = asRecord(input);
  if (record === null) {
    return malformedBody();
  }
  const details: ErrorDetail[] = [];
  const accessToken = parseToken(record['accessToken'], details);
  return details.length > 0 ? { ok: false, details } : { ok: true, value: { accessToken } };
}
