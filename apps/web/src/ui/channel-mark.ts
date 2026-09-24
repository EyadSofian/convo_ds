import { svgIcon } from '../dom.js';
import type { IconName } from '../icons.js';
import { icon } from '../icons.js';
import { BRAND_MARK_PATHS } from './brand-marks.js';
import type { BrandMark } from './brand-marks.js';

/** Product glyphs for channels that are not a third-party brand, and the fallback. */
export const CHANNEL_ICON: Readonly<Record<string, IconName>> = {
  whatsapp: 'whatsapp',
  instagram: 'instagram',
  messenger: 'messenger',
  web_chat: 'webChat',
  custom: 'braces',
  telegram: 'plane',
};

/** The channel's glyph. A kind this build does not know gets a neutral globe. */
export function channelIcon(kind: string): IconName {
  return CHANNEL_ICON[kind] ?? 'globe';
}

/**
 * The fills each provider publishes for its own mark. Gradients are the
 * providers' own; everything around the mark stays in the product's palette.
 */
const BRAND_GRADIENT: Readonly<Record<BrandMark, string>> = {
  whatsapp: '',
  telegram: '',
  messenger: 'cx="19%" cy="99%" r="109%"><stop offset="0" stop-color="#0099FF"/><stop offset=".61" stop-color="#A033FF"/><stop offset=".93" stop-color="#FF5280"/><stop offset="1" stop-color="#FF7061"/>',
  instagram: 'cx="30%" cy="107%" r="150%"><stop offset="0" stop-color="#FDF497"/><stop offset=".05" stop-color="#FDF497"/><stop offset=".45" stop-color="#FD5949"/><stop offset=".6" stop-color="#D6249F"/><stop offset=".9" stop-color="#285AEB"/>',
};

const BRAND_SOLID: Readonly<Record<BrandMark, string>> = {
  whatsapp: '#25D366',
  telegram: '#26A5E4',
  messenger: '',
  instagram: '',
};

/**
 * Each gradient mark carries its own id: a page lists many of them, and a
 * shared id would paint every copy from whichever one the browser found first
 * — nothing at all when that one sits in a hidden subtree.
 */
let gradients = 0;

function isBrand(kind: string): kind is BrandMark {
  return Object.prototype.hasOwnProperty.call(BRAND_MARK_PATHS, kind);
}

/**
 * A channel's mark: the provider's own logo for WhatsApp, Messenger, Instagram
 * and Telegram, and a product glyph for the channels this product owns (Website
 * chat, Custom API). Never mirrored in RTL, never a letter stand-in.
 */
export function channelMark(kind: string, size = 16): SVGElement {
  if (!isBrand(kind)) return icon(channelIcon(kind), size, { class: 'channel-mark channel-mark--product' });
  const gradient = BRAND_GRADIENT[kind];
  let defs = '';
  let fill = BRAND_SOLID[kind];
  if (gradient !== '') {
    gradients += 1;
    const id = `ds-mark-${kind}-${String(gradients)}`;
    defs = `<defs><radialGradient id="${id}" ${gradient}</radialGradient></defs>`;
    fill = `url(#${id})`;
  }
  return svgIcon(`${defs}<path d="${BRAND_MARK_PATHS[kind]}" fill="${fill}"/>`, size, {
    fill: 'none',
    stroke: 'none',
    class: `channel-mark channel-mark--${kind}`,
  });
}

