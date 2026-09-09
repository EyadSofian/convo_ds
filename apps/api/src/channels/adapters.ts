import type { ChannelAdapter, ChannelKind } from '@convo/domain';
import { WhatsAppAdapter } from '@convo/domain';
import { nodeChannelCrypto } from './node-crypto.js';

/**
 * The adapter registry.
 *
 * One entry per channel kind, built once. A kind with no adapter yet is absent
 * rather than mapped to a shared default: a default is how Instagram ends up
 * being handled by WhatsApp's rules, which is the exact failure ADR-0009 exists
 * to prevent.
 */
const ADAPTERS = new Map<ChannelKind, ChannelAdapter>([
  ['whatsapp', new WhatsAppAdapter(nodeChannelCrypto)],
]);

export function adapterFor(kind: ChannelKind): ChannelAdapter | null {
  return ADAPTERS.get(kind) ?? null;
}

/** The kinds this build can actually serve, in a stable order. */
export function implementedKinds(): readonly ChannelKind[] {
  return [...ADAPTERS.keys()];
}
