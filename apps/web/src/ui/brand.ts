import { h, svgIcon } from '../dom.js';
import { icon } from '../icons.js';
import { channelIcon } from './parts.js';

/**
 * The product mark and the channel tiles.
 *
 * Drawn locally: no logo is fetched from a provider's CDN, so a self-hosted
 * install renders with no outbound call. Provider colour is confined to the
 * small tile behind each glyph — the card around it stays in the product's own
 * palette, so six integrations do not become six competing colour schemes.
 */

/** The CONVO mark: a message bubble in a rounded tile. Decorative; the name is text. */
export function logomark(size: 'sm' | 'lg' = 'sm'): HTMLElement {
  return h('span', { class: `logomark logomark--${size}`, 'aria-hidden': 'true' }, [
    svgIcon(
      '<path d="M6.5 5.5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H11l-4 3.5v-3.5h-.5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z"/><path d="M8.5 9.5h7M8.5 12.3h4.5"/>',
      size === 'lg' ? 22 : 18,
      { 'stroke-width': 1.9 },
    ),
  ]);
}

/** The brand row used on the sign-in and loading screens. */
export function brandLockup(): HTMLElement {
  return h('span', { class: 'brand' }, [logomark('lg'), h('span', { class: 'brand__name' }, ['CONVO'])]);
}

/** A channel's glyph on its provider-coloured tile. */
export function channelTile(kind: string, size: 'md' | 'lg' = 'md'): HTMLElement {
  return h('span', { class: `channel-tile channel-tile--${kind} channel-tile--${size}`, 'aria-hidden': 'true' }, [
    icon(channelIcon(kind), size === 'lg' ? 22 : 16),
  ]);
}
