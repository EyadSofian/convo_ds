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
  /**
   * The credential.
   *
   * For a provider channel it is the grant they issued us. For Website Chat and
   * the Custom Channel API it is the **signing key** the installation will sign
   * its deliveries with — the same field because it is the same kind of secret,
   * stored the same encrypted way, and never returned by any operation.
   */
  readonly accessToken: string;
  /** Provider-facing app id, e.g. the numeric Meta App ID shown in Meta Business. */
  readonly providerAppId: string | null;
  /** Legacy/internal reference accepted for service-to-service callers. */
  readonly appId: string | null;
  /** Per-connection configuration, only meaningful for the channels we own. */
  readonly settings: ChannelSettings;
}

export interface ChannelSettings {
  /**
   * Exact origins a widget may deliver from. Empty means "not configured yet",
   * which the ingress reads as no — an unconfigured allowlist is not an open one.
   */
  readonly origins?: readonly string[] | undefined;
  readonly ratePerMinute?: number | undefined;
  /** What a Custom Channel's own transport says it can carry. */
  readonly declaredTypes?: readonly string[] | undefined;
}

export interface RotateCredentialRequest {
  readonly accessToken: string;
}

const ASSET_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NAME = /^[a-z0-9_]{1,40}$/;
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

  let providerAppId: string | null = null;
  if ('providerAppId' in record && record['providerAppId'] !== null) {
    const value = typeof record['providerAppId'] === 'string' ? record['providerAppId'].trim() : '';
    if (!ASSET_ID.test(value)) {
      details.push({ field: 'providerAppId', code: 'malformed', message: 'Provide the app id shown by the provider.' });
    } else {
      providerAppId = value;
    }
  }
  if (appId !== null && providerAppId !== null) {
    details.push({ field: 'appReference', code: 'conflicting', message: 'Send providerAppId or appId, not both.' });
  }

  const settings = parseSettings(record['settings'], details);

  if (details.length > 0 || kind === null) {
    return { ok: false, details };
  }
  return {
    ok: true,
    value: { kind, externalAssetId: assetId, displayName, accessToken, providerAppId, appId, settings },
  };
}

const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/;
const MAX_ORIGINS = 20;

/**
 * Per-connection settings for the channels we own.
 *
 * Origins are matched exactly by the ingress, so they are validated as whole
 * origins here: a value with a path or a wildcard would never match anything
 * and would look like a configured allowlist that silently refuses everyone.
 */
function parseSettings(raw: unknown, details: ErrorDetail[]): ChannelSettings {
  if (raw === undefined || raw === null) {
    return {};
  }
  const record = asRecord(raw);
  if (record === null) {
    details.push({ field: 'settings', code: 'malformed', message: 'Settings must be an object.' });
    return {};
  }
  const settings: {
    origins?: readonly string[];
    ratePerMinute?: number;
    declaredTypes?: readonly string[];
  } = {};

  if ('origins' in record) {
    const origins = record['origins'];
    if (
      !Array.isArray(origins) ||
      origins.length > MAX_ORIGINS ||
      !origins.every((entry) => typeof entry === 'string' && ORIGIN.test(entry))
    ) {
      details.push({
        field: 'settings.origins',
        code: 'malformed',
        message: `Up to ${String(MAX_ORIGINS)} whole origins, e.g. "https://school.example".`,
      });
    } else {
      settings.origins = origins as readonly string[];
    }
  }

  if ('ratePerMinute' in record) {
    const rate = record['ratePerMinute'];
    if (typeof rate !== 'number' || !Number.isInteger(rate) || rate < 1 || rate > 100_000) {
      details.push({
        field: 'settings.ratePerMinute',
        code: 'malformed',
        message: 'A rate limit is an integer from 1 to 100000.',
      });
    } else {
      settings.ratePerMinute = rate;
    }
  }

  if ('declaredTypes' in record) {
    const types = record['declaredTypes'];
    if (!Array.isArray(types) || !types.every((entry) => typeof entry === 'string' && NAME.test(entry))) {
      details.push({
        field: 'settings.declaredTypes',
        code: 'malformed',
        message: 'Declared types are lowercase names, e.g. ["text"].',
      });
    } else {
      settings.declaredTypes = types as readonly string[];
    }
  }

  return settings;
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
