import type { ChannelKind } from './kinds.js';

/**
 * The versioned capability matrix, one per channel (ADR-0009, CH-01).
 *
 * Everything a screen or a policy needs to know about what a channel can carry
 * is declared here, for a named provider version. Nothing is inherited across
 * channels: WhatsApp's template support is not Messenger's, and Instagram's
 * text limit is not WhatsApp's.
 *
 * `textLimit` carries **both** characters and UTF-8 bytes. Providers publish
 * limits in one or the other and the two diverge badly for Arabic — a 1000
 * "character" limit is reached at 500 Arabic characters if the real bound is
 * 1000 bytes — so the matrix states both and the checker enforces both
 * (CH-IG-04).
 */

export interface TextLimit {
  readonly characters: number;
  readonly bytes: number;
}

export interface CapabilityMatrix {
  readonly kind: ChannelKind;
  /** The provider version this matrix was recorded against. */
  readonly version: string;
  /** API host, because Instagram Login and Facebook Login differ (CH-IG-01). */
  readonly host: string;
  readonly inboundEvents: readonly string[];
  readonly outboundTypes: readonly string[];
  readonly attachmentTypes: readonly string[];
  readonly textLimit: TextLimit;
  /** Reply window in hours, or `null` where the channel has none. */
  readonly windowHours: number | null;
  /** Whether the business may open a conversation the customer did not start. */
  readonly businessInitiated: boolean;
  /** Templates are a WhatsApp concept; declaring it per channel keeps it there. */
  readonly templates: boolean;
  /** Whether the provider reports delivered/read at all. Absent ≠ false. */
  readonly deliveryReceipts: boolean;
  readonly readReceipts: boolean;
}

/**
 * Pinned versions.
 *
 * Recorded in `docs/research/provider-evidence.md` with source and date.
 * Bumping one is a config change plus a fixture re-record plus a matrix diff —
 * never an implicit follow-the-latest.
 */
export const PINNED_GRAPH_VERSION = 'v21.0';

const WHATSAPP: CapabilityMatrix = {
  kind: 'whatsapp',
  version: PINNED_GRAPH_VERSION,
  host: 'graph.facebook.com',
  inboundEvents: ['messages', 'statuses'],
  outboundTypes: ['text', 'image', 'document', 'audio', 'video', 'template'],
  attachmentTypes: ['image', 'document', 'audio', 'video', 'sticker'],
  textLimit: { characters: 4096, bytes: 4096 },
  windowHours: 24,
  // Only with an approved template. The window policy below is what enforces
  // that; `businessInitiated` alone would read as "send anything, any time".
  businessInitiated: true,
  templates: true,
  deliveryReceipts: true,
  readReceipts: true,
};

const MESSENGER: CapabilityMatrix = {
  kind: 'messenger',
  version: PINNED_GRAPH_VERSION,
  host: 'graph.facebook.com',
  inboundEvents: ['messages', 'messaging_postbacks', 'message_deliveries', 'message_reads'],
  outboundTypes: ['text', 'image', 'file', 'audio', 'video'],
  attachmentTypes: ['image', 'file', 'audio', 'video'],
  textLimit: { characters: 2000, bytes: 2000 },
  windowHours: 24,
  businessInitiated: false,
  // Deliberately false. A WhatsApp template must never be accepted here, and
  // the cheapest way to guarantee that is for Messenger to have no template
  // concept at all.
  templates: false,
  deliveryReceipts: true,
  readReceipts: true,
};

const INSTAGRAM: CapabilityMatrix = {
  kind: 'instagram',
  version: PINNED_GRAPH_VERSION,
  // Instagram Login talks to its own host, not Facebook's (CH-IG-01).
  host: 'graph.instagram.com',
  inboundEvents: ['messages', 'messaging_postbacks', 'message_reactions'],
  outboundTypes: ['text', 'image'],
  attachmentTypes: ['image', 'video', 'audio', 'share', 'story_mention'],
  // Published as characters; the byte bound is what actually bites in Arabic.
  textLimit: { characters: 1000, bytes: 1000 },
  windowHours: 24,
  // Customer-initiated only (CH-IG-03). A cold DM is rejected with a typed
  // reason rather than queued to fail later.
  businessInitiated: false,
  templates: false,
  deliveryReceipts: false,
  // Not reported by this product. `not_available`, never `false` or `0%`.
  readReceipts: false,
};

const WEB_CHAT: CapabilityMatrix = {
  kind: 'web_chat',
  version: 'v1',
  host: 'self',
  inboundEvents: ['messages', 'typing', 'session_start'],
  outboundTypes: ['text', 'image', 'file'],
  attachmentTypes: ['image', 'file'],
  textLimit: { characters: 8000, bytes: 16000 },
  // Our own channel: no provider window to obey.
  windowHours: null,
  businessInitiated: true,
  templates: false,
  deliveryReceipts: true,
  readReceipts: true,
};

const CUSTOM: CapabilityMatrix = {
  kind: 'custom',
  version: 'v1',
  host: 'self',
  inboundEvents: ['messages'],
  outboundTypes: ['text'],
  attachmentTypes: [],
  textLimit: { characters: 4000, bytes: 8000 },
  windowHours: null,
  businessInitiated: true,
  templates: false,
  // The operator's own transport tells us nothing unless they report it.
  deliveryReceipts: false,
  readReceipts: false,
};

export const CAPABILITY_MATRICES: Readonly<Record<ChannelKind, CapabilityMatrix>> = {
  whatsapp: WHATSAPP,
  messenger: MESSENGER,
  instagram: INSTAGRAM,
  web_chat: WEB_CHAT,
  custom: CUSTOM,
};

export function capabilitiesFor(kind: ChannelKind): CapabilityMatrix {
  return CAPABILITY_MATRICES[kind];
}

/**
 * How a piece of text measures against a channel's limit.
 *
 * Both numbers are returned, not just the verdict, because the composer has to
 * show a remaining count and choosing the wrong unit is the bug this exists to
 * prevent.
 */
export interface TextMeasurement {
  readonly characters: number;
  readonly bytes: number;
  readonly withinLimit: boolean;
}

export function measureText(text: string, limit: TextLimit): TextMeasurement {
  // `Array.from` counts code points, not UTF-16 units, so an emoji is one
  // character rather than two. A ZWJ sequence still counts as its parts, which
  // is what providers count too.
  const characters = Array.from(text).length;
  const bytes = utf8Length(text);
  return {
    characters,
    bytes,
    withinLimit: characters <= limit.characters && bytes <= limit.bytes,
  };
}

/**
 * UTF-8 byte length.
 *
 * `TextEncoder` is a platform standard rather than a Node import, so the domain
 * stays runtime-independent while the arithmetic stays exact. A hand-rolled
 * code-point walk was the first version of this and carried a branch for a code
 * point that cannot exist; the platform's encoder has no such gap.
 */
const ENCODER = new TextEncoder();

export function utf8Length(text: string): number {
  return ENCODER.encode(text).length;
}
