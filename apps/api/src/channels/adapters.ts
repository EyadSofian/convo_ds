import type { ChannelAdapter, ChannelKind } from '@convo/domain';
import {
  CustomChannelAdapter,
  InstagramAdapter,
  MessengerAdapter,
  WebChatAdapter,
  WhatsAppAdapter,
} from '@convo/domain';
import { nodeChannelCrypto } from './node-crypto.js';

/**
 * The adapter registry.
 *
 * One entry per channel kind, built once, and complete: the record's type makes
 * a missing adapter a compile error rather than a runtime null. What is *not*
 * shared is everything above the wire — each adapter brings its own capability
 * matrix, window, template rules and event vocabulary, because a shared default
 * is how Instagram ends up handled by WhatsApp's rules (ADR-0009).
 */
const ADAPTERS: Readonly<Record<ChannelKind, ChannelAdapter>> = {
  whatsapp: new WhatsAppAdapter(nodeChannelCrypto),
  messenger: new MessengerAdapter(nodeChannelCrypto),
  instagram: new InstagramAdapter(nodeChannelCrypto),
  web_chat: new WebChatAdapter(nodeChannelCrypto),
  custom: new CustomChannelAdapter(nodeChannelCrypto),
};

/**
 * Which kinds share one Meta app and one webhook.
 *
 * They are multiplexed by the envelope's `object`, so a delivery on the Meta
 * route is offered to each of these in turn and the one that claims it handles
 * it. The order is stable so a payload that somehow satisfied two adapters
 * would resolve the same way every time rather than by map iteration luck.
 */
export const META_KINDS: readonly ChannelKind[] = ['whatsapp', 'messenger', 'instagram'];

/**
 * Total: every kind has an adapter, and the record's type says so.
 *
 * It used to answer `null` for a kind nobody had built yet. Now that all five
 * exist, keeping that would be a branch no caller could reach and every caller
 * still had to handle.
 */
export function adapterFor(kind: ChannelKind): ChannelAdapter {
  return ADAPTERS[kind];
}

/**
 * The adapter that recognises this verified payload, out of the ones offered.
 *
 * Asking the adapters rather than switching on a string here is what keeps the
 * knowledge of a provider's envelope inside the adapter that owns it.
 */
export function adapterClaiming(
  payload: unknown,
  kinds: readonly ChannelKind[],
): ChannelAdapter | null {
  return kinds.map((kind) => ADAPTERS[kind]).find((adapter) => adapter.claims(payload)) ?? null;
}

/** The kinds this build can actually serve, in a stable order. */
export function implementedKinds(): readonly ChannelKind[] {
  return Object.keys(ADAPTERS) as readonly ChannelKind[];
}
