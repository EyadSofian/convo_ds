import { h } from '../dom.js';
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

/** Official Digital School by Berlitz lockup supplied by the client. */
export function logomark(size: 'sm' | 'lg' = 'sm'): HTMLElement {
  return h('img', {
    class: `logomark logomark--${size}`,
    src: '/brand/digital-school-by-berlitz.png',
    alt: '',
    'aria-hidden': 'true',
  });
}

/** The brand row used on the sign-in and loading screens. */
export function brandLockup(): HTMLElement {
  return h('span', { class: 'brand', 'aria-label': 'Digital School by Berlitz' }, [
    logomark('lg'),
    h('span', { class: 'brand__name' }, ['DIGITAL SCHOOL']),
  ]);
}

/** A channel's glyph on its provider-coloured tile. */
export function channelTile(kind: string, size: 'md' | 'lg' = 'md'): HTMLElement {
  return h('span', { class: `channel-tile channel-tile--${kind} channel-tile--${size}`, 'aria-hidden': 'true' }, [
    icon(channelIcon(kind), size === 'lg' ? 20 : 16),
  ]);
}
