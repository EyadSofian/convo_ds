import { createHash } from 'node:crypto';
import pg from 'pg';
import { PINNED_GRAPH_VERSION } from '@convo/domain';
import type { ClusterCredentials, DatabaseNames } from './types.js';

// See the note in bootstrap.ts: `pg` is CommonJS and has no ESM named export.
const { Client } = pg;

/**
 * Registering the provider app that Meta channels are connected through.
 *
 * ## Why this lives here and not in the API
 *
 * `channel_apps` is installation configuration, not tenant data, and the
 * runtime role holds `SELECT` on it and nothing else (migration 0010). That is
 * deliberate: the row names the configuration key an app secret is read from,
 * so a runtime that could write it could redirect signature verification at a
 * secret of its own choosing. The privilege to create it therefore belongs to
 * the same role that owns the schema, which is this CLI.
 *
 * What was missing was not the privilege boundary but the tool. Without one the
 * only route was a hand-written `INSERT` computing two SHA-256 digests by hand,
 * and a `connect` that answers `channel_app_not_configured` gives an operator
 * no way to discover that. Nothing about Meta can be configured until this row
 * exists, including the webhook URL, whose `<appConnectionId>` *is* this row's
 * id.
 *
 * ## Why the secrets come from the environment
 *
 * Neither secret is accepted as an argument. Arguments are visible to every
 * other process on the host through `ps`, and these two values are exactly the
 * ones that must not leak: the app secret verifies every webhook signature, and
 * the verify token answers the subscription handshake.
 *
 * The app secret is read from `CONVO_CHANNEL_SECRET_<REF>` — the *same*
 * variable the API reads at runtime. That is the point. Registration fails if
 * the operator has not set it, which turns the most common misconfiguration
 * ("the row names a key nobody configured") into an error at setup time rather
 * than a 503 on the first real delivery.
 */

/** Only Meta uses an app row. */
export const CHANNEL_APP_PROVIDERS = ['meta'] as const;
export type ChannelAppProvider = (typeof CHANNEL_APP_PROVIDERS)[number];

export const SECRET_REF_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
export const EXTERNAL_APP_ID_PATTERN = /^[0-9]{1,32}$/;
export const GRAPH_VERSION_PATTERN = /^v[0-9]+\.[0-9]+$/;

/** The configuration key holding the app secret for `<REF>`. */
export function secretVariableOf(secretRef: string): string {
  return `CONVO_CHANNEL_SECRET_${secretRef}`;
}

/** The configuration key holding the webhook verify token for `<REF>`. */
export function verifyTokenVariableOf(secretRef: string): string {
  return `CONVO_CHANNEL_VERIFY_TOKEN_${secretRef}`;
}

export interface RegisterChannelAppInput {
  readonly provider: ChannelAppProvider;
  readonly externalAppId: string;
  readonly secretRef: string;
  readonly graphVersion: string;
  /** Read from `CONVO_CHANNEL_SECRET_<REF>`, never from an argument. */
  readonly appSecret: string;
  /** Read from `CONVO_CHANNEL_VERIFY_TOKEN_<REF>`, never from an argument. */
  readonly verifyToken: string;
}

export interface RegisteredChannelApp {
  /** The webhook URL's `<appConnectionId>`. */
  readonly id: string;
  readonly provider: string;
  readonly externalAppId: string;
  readonly secretRef: string;
  readonly graphVersion: string;
  /** `false` when an existing registration was rotated in place. */
  readonly created: boolean;
}

/**
 * SHA-256, lowercase hex.
 *
 * The verify-token hash is not a choice made here: the handshake compares
 * `sha256Hex(hub.verify_token)` against the stored column
 * (`answerMetaChallenge`, packages/domain/src/channels/meta-signature.ts), so a
 * salt or an HMAC would simply never match. The secret fingerprint uses the
 * same construction for the same reason it exists at all — to be comparable
 * later against the configured value.
 */
function digestOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Creates or rotates one provider app registration.
 *
 * Idempotent on `(provider, external_app_id)`, which is the table's own unique
 * key, so re-running after rotating the app secret or the verify token updates
 * the row in place and keeps its id — and keeps the webhook URL already
 * configured in Meta working. `rotated_at` records that it happened; a
 * registration that changed nothing still reports `created: false` rather than
 * pretending to be new.
 */
export async function registerChannelApp(
  cluster: ClusterCredentials,
  names: DatabaseNames,
  input: RegisterChannelAppInput,
): Promise<RegisteredChannelApp> {
  const client = new Client({
    host: cluster.host,
    port: cluster.port,
    user: names.migrationRole,
    password: names.migrationPassword,
    database: names.database,
  });
  await client.connect();
  try {
    const rows = await client.query<{ id: string; created: boolean }>(
      `INSERT INTO channel_apps
         (provider, external_app_id, secret_ref, secret_fingerprint,
          verify_token_hash, graph_version, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')
       ON CONFLICT (provider, external_app_id) DO UPDATE
         SET secret_ref = excluded.secret_ref,
             secret_fingerprint = excluded.secret_fingerprint,
             verify_token_hash = excluded.verify_token_hash,
             graph_version = excluded.graph_version,
             status = 'active',
             rotated_at = now()
       -- Evaluated against the row as it stands after the statement, so the
       -- update branch, which has just stamped rotated_at, reports false, and
       -- the insert branch, where it is still null, reports true.
       RETURNING id::text, rotated_at IS NULL AS created`,
      [
        input.provider,
        input.externalAppId,
        input.secretRef,
        digestOf(input.appSecret),
        digestOf(input.verifyToken),
        input.graphVersion,
      ],
    );
    const row = rows.rows[0];
    if (row === undefined) {
      throw new Error('The channel app registration returned no row.');
    }
    return {
      id: row.id,
      provider: input.provider,
      externalAppId: input.externalAppId,
      secretRef: input.secretRef,
      graphVersion: input.graphVersion,
      created: row.created,
    };
  } finally {
    await client.end();
  }
}

export interface ParsedRegisterChannelApp {
  readonly provider: ChannelAppProvider;
  readonly externalAppId: string;
  readonly secretRef: string;
  readonly graphVersion: string;
}

/**
 * Parses the flags, total and pure.
 *
 * Every refusal names the flag and what it expects, because the operator
 * reading it is mid-deployment with a Meta console open in another window. The
 * patterns are the table's own `CHECK` constraints, enforced here so a typo is
 * a sentence rather than a PostgreSQL constraint violation.
 */
export function parseRegisterChannelApp(
  argv: readonly string[],
): { readonly ok: true; readonly value: ParsedRegisterChannelApp } | { readonly ok: false; readonly error: string } {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith('--')) {
      return { ok: false, error: `Expected a --flag, found: ${String(flag)}` };
    }
    if (value === undefined || value.startsWith('--')) {
      return { ok: false, error: `${flag} needs a value.` };
    }
    if (flags.has(flag)) {
      return { ok: false, error: `${flag} was given twice.` };
    }
    flags.set(flag, value);
  }

  const known = new Set(['--provider', '--external-app-id', '--secret-ref', '--graph-version']);
  for (const flag of flags.keys()) {
    if (!known.has(flag)) {
      return { ok: false, error: `Unknown flag: ${flag}` };
    }
  }

  // Only Meta consumes an app row: Website Chat and the Custom Channel resolve
  // their deliveries through `channel_asset_registry` instead, so accepting
  // them here would create configuration that nothing ever reads.
  const provider = flags.get('--provider') ?? 'meta';
  if (!(CHANNEL_APP_PROVIDERS as readonly string[]).includes(provider)) {
    return {
      ok: false,
      error: `--provider must be one of: ${CHANNEL_APP_PROVIDERS.join(', ')}. Website Chat and Custom channels do not use an app registration.`,
    };
  }

  const externalAppId = flags.get('--external-app-id');
  if (externalAppId === undefined || !EXTERNAL_APP_ID_PATTERN.test(externalAppId)) {
    return { ok: false, error: '--external-app-id must be the numeric Meta App ID, 1 to 32 digits.' };
  }

  const secretRef = flags.get('--secret-ref');
  if (secretRef === undefined || !SECRET_REF_PATTERN.test(secretRef)) {
    return {
      ok: false,
      error: '--secret-ref must be 3 to 64 characters of A-Z, 0-9 and underscore, starting with a letter, e.g. META_APP.',
    };
  }

  const graphVersion = flags.get('--graph-version') ?? PINNED_GRAPH_VERSION;
  if (!GRAPH_VERSION_PATTERN.test(graphVersion)) {
    return { ok: false, error: '--graph-version must look like v21.0.' };
  }
  // A row pinned to a different version than the transport compiles against
  // would send through one Graph version and advertise another in the
  // capability matrix, so the mismatch is refused rather than recorded.
  if (graphVersion !== PINNED_GRAPH_VERSION) {
    return {
      ok: false,
      error: `--graph-version must match this build's pinned version, ${PINNED_GRAPH_VERSION}. Bumping it is a code change (ADR-0009), not a registration flag.`,
    };
  }

  return { ok: true, value: { provider: provider as ChannelAppProvider, externalAppId, secretRef, graphVersion } };
}
