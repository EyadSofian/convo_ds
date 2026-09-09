/**
 * The channel vocabulary.
 *
 * Five kinds, three providers, and no "Meta messaging" category. WhatsApp,
 * Messenger and Instagram are separate products with separate hosts, tokens,
 * scopes, windows and capabilities (ADR-0009); a shared enum value is the first
 * step towards a shared default, and a shared default is how a WhatsApp
 * template ends up offered on Messenger.
 */

export const CHANNEL_KINDS = ['whatsapp', 'messenger', 'instagram', 'web_chat', 'custom'] as const;

export type ChannelKind = (typeof CHANNEL_KINDS)[number];

const CHANNEL_KIND_SET: ReadonlySet<string> = new Set<string>(CHANNEL_KINDS);

export function isChannelKind(value: string): value is ChannelKind {
  return CHANNEL_KIND_SET.has(value);
}

export const CHANNEL_PROVIDERS = ['meta', 'web_chat', 'custom'] as const;

export type ChannelProvider = (typeof CHANNEL_PROVIDERS)[number];

/**
 * Which provider serves a kind.
 *
 * Three kinds share the `meta` provider — one app registration, one webhook
 * signature scheme — and that is the *only* thing they share. Every rule below
 * this line is declared per kind.
 */
export const PROVIDER_OF: Readonly<Record<ChannelKind, ChannelProvider>> = {
  whatsapp: 'meta',
  messenger: 'meta',
  instagram: 'meta',
  web_chat: 'web_chat',
  custom: 'custom',
};

/**
 * Connection readiness.
 *
 * These are *derived* from evidence, never set by hand. The ordering matters:
 * each state names the first missing piece, so an operator reads a state and
 * knows what to do next rather than being told "something is wrong".
 */
export const READINESS_STATES = [
  /** Nothing has been supplied yet. */
  'not_configured',
  /** The asset is known but no usable credential is held. */
  'authorization_needed',
  /** Credentials work; the provider has not yet delivered a webhook. */
  'webhook_pending',
  /** Every piece of evidence is present. */
  'healthy',
  /** It worked and then something broke; the last error says what. */
  'degraded',
  /** Deliberately taken out of service. */
  'disconnected',
] as const;

export type Readiness = (typeof READINESS_STATES)[number];

/**
 * The separate pieces of evidence behind `healthy` (CH-02).
 *
 * A non-empty token field proves none of these. Each is a timestamp on the
 * connection, set by the thing that actually observed it — not by the form that
 * submitted it.
 */
export const EVIDENCE_KINDS = [
  'asset_verified',
  'credential_verified',
  'webhook_subscribed',
  'first_inbound',
  'first_outbound',
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export type EvidenceRecord = Readonly<Record<EvidenceKind, boolean>>;

export interface ReadinessInput {
  readonly evidence: EvidenceRecord;
  readonly disconnected: boolean;
  readonly hasError: boolean;
}

/**
 * Derives readiness from evidence, in one place.
 *
 * Written as an ordered walk rather than a lookup table because the order *is*
 * the rule: being disconnected outranks having an error, and having an error
 * only matters once the thing was working. A table would let a later editor
 * reorder the rows without noticing they changed the meaning.
 */
export function readinessOf(input: ReadinessInput): Readiness {
  if (input.disconnected) {
    return 'disconnected';
  }
  if (!input.evidence.asset_verified) {
    return 'not_configured';
  }
  if (!input.evidence.credential_verified) {
    return 'authorization_needed';
  }
  if (input.hasError) {
    // It was configured and authorized, and then something failed. That is a
    // different situation from never having worked, and hiding it inside
    // `webhook_pending` would tell an operator to keep waiting.
    return 'degraded';
  }
  if (!input.evidence.webhook_subscribed || !input.evidence.first_inbound) {
    return 'webhook_pending';
  }
  return 'healthy';
}

/** The evidence still missing, so the UI can say what to do next. */
export function missingEvidence(evidence: EvidenceRecord): readonly EvidenceKind[] {
  return EVIDENCE_KINDS.filter((kind) => !evidence[kind]);
}
