import { svgIcon } from '../dom.js';
import type { IconName } from '../icons.js';
import { icon } from '../icons.js';
import { BRAND_MARK_PATHS } from './brand-marks.js';
import type { BrandMark } from './brand-marks.js';

/**
 * The two ways a channel is drawn, and nothing else:
 *
 * - a provider's own logo (WhatsApp, Messenger, Instagram, Telegram, and
 *   Facebook as a Messenger connection's Page context), from `brandMark`;
 * - a product glyph for the channels this product runs itself (Website Chat,
 *   Custom API), from the one product icon set.
 *
 * No screen draws its own version, and the generic icon set carries no brand.
 */

/** Product glyphs for the channels that are not a third-party brand. */
export const PRODUCT_CHANNEL_ICON: Readonly<Record<string, IconName>> = {
  web_chat: 'webChat',
  custom: 'braces',
};

/** A product channel's glyph. A kind this build does not know gets a neutral globe, never another provider's logo. */
export function productChannelIcon(kind: string): IconName {
  return PRODUCT_CHANNEL_ICON[kind] ?? 'globe';
}

/** Each provider's own colour, as its published mark uses it. */
const BRAND_SOLID: Readonly<Record<BrandMark, string>> = {
  whatsapp: '#25D366',
  messenger: '#0866FF',
  telegram: '#26A5E4',
  facebook: '#1877F2',
  instagram: '',
};

/** Instagram's published gradient: warm at the lower corner, purple at the top. */
const INSTAGRAM_GRADIENT =
  'cx="30%" cy="107%" r="150%"><stop offset="0" stop-color="#FDF497"/><stop offset=".05" stop-color="#FDF497"/><stop offset=".45" stop-color="#FD5949"/><stop offset=".6" stop-color="#D6249F"/><stop offset=".9" stop-color="#9B36B7"/>';

/**
 * Each gradient mark carries its own id: a page lists many of them, and a
 * shared id would paint every copy from whichever one the browser found first
 * — nothing at all when that one sits in a hidden subtree.
 */
let gradients = 0;

export function isBrandMark(kind: string): kind is BrandMark {
  return Object.prototype.hasOwnProperty.call(BRAND_MARK_PATHS, kind);
}

/**
 * A provider's own logo, never mirrored in RTL and never recoloured into the
 * theme: it sits on a neutral tile that holds up in both themes.
 */
export function brandMark(brand: BrandMark, size = 16): SVGElement {
  let defs = '';
  let fill = BRAND_SOLID[brand];
  if (brand === 'instagram') {
    gradients += 1;
    const id = `ds-mark-instagram-${String(gradients)}`;
    defs = `<defs><radialGradient id="${id}" ${INSTAGRAM_GRADIENT}</radialGradient></defs>`;
    fill = `url(#${id})`;
  }
  return svgIcon(`${defs}<path d="${BRAND_MARK_PATHS[brand]}" fill="${fill}"/>`, size, {
    fill: 'none',
    stroke: 'none',
    class: `channel-mark channel-mark--brand channel-mark--${brand}`,
    'data-mark': 'brand',
  });
}

/** A channel's mark: its provider's logo, or this product's own glyph. */
export function channelMark(kind: string, size = 16): SVGElement {
  if (isBrandMark(kind)) return brandMark(kind, size);
  return icon(productChannelIcon(kind), size, { class: `channel-mark channel-mark--product channel-mark--${kind}`, 'data-mark': 'product' });
}
