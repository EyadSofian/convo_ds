import { svgIcon } from './dom';
import type { Attrs } from './dom';

/**
 * Stroke icons on a 24px grid, one consistent style. Drawn here rather than
 * pulled from a third-party set so nothing in the demo carries another
 * product's identity (docs/design/ui-research.md §"Scope of what was copied").
 */
export const ICON_PATHS = {
  inbox: '<path d="M4 5.5h16v13H4z"/><path d="M4 13h4l1.6 2.6h4.8L16 13h4"/>',
  broadcasts: '<path d="M4 10v4h3l5 3.5v-11L7 10H4z"/><path d="M16.4 9.2a4 4 0 0 1 0 5.6"/><path d="M18.9 6.7a7.5 7.5 0 0 1 0 10.6"/>',
  analytics: '<path d="M4 19.5V4.5"/><path d="M4 19.5h16"/><path d="M7.5 16V11"/><path d="M12 16V7.5"/><path d="M16.5 16v-3"/>',
  settings: '<path d="M10.3 3.9a1.8 1.8 0 0 1 3.4 0l.3.9a1.8 1.8 0 0 0 2.5 1l.8-.4a1.8 1.8 0 0 1 2.4 2.4l-.4.8a1.8 1.8 0 0 0 1 2.5l.9.3a1.8 1.8 0 0 1 0 3.4l-.9.3a1.8 1.8 0 0 0-1 2.5l.4.8a1.8 1.8 0 0 1-2.4 2.4l-.8-.4a1.8 1.8 0 0 0-2.5 1l-.3.9a1.8 1.8 0 0 1-3.4 0l-.3-.9a1.8 1.8 0 0 0-2.5-1l-.8.4a1.8 1.8 0 0 1-2.4-2.4l.4-.8a1.8 1.8 0 0 0-1-2.5l-.9-.3a1.8 1.8 0 0 1 0-3.4l.9-.3a1.8 1.8 0 0 0 1-2.5l-.4-.8a1.8 1.8 0 0 1 2.4-2.4l.8.4a1.8 1.8 0 0 0 2.5-1z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-3.6-3.6"/>',
  filter: '<path d="M4 6h16"/><path d="M7 12h10"/><path d="M10 18h4"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronEnd: '<path d="m9 6 6 6-6 6"/>',
  chevronStart: '<path d="m15 6-6 6 6 6"/>',
  expand: '<path d="M9 4.5H4.5V9"/><path d="M15 4.5h4.5V9"/><path d="M9 19.5H4.5V15"/><path d="M15 19.5h4.5V15"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  dots: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  arrowIn: '<path d="M18 6 7.5 16.5"/><path d="M7 10.5v6.5h6.5"/>',
  arrowOut: '<path d="M6 18 16.5 7.5"/><path d="M10.5 7H17v6.5"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 1.8"/>',
  alert: '<path d="M12 4.5 2.8 20h18.4z"/><path d="M12 10v4"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
  shield: '<path d="M12 3.5 5 6v6c0 4 3 7 7 8.5 4-1.5 7-4.5 7-8.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9" rx="1.8"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  wifiOff: '<path d="M3 3 21 21"/><path d="M5 12.5a11 11 0 0 1 3.6-2.3"/><path d="M2 8.8A16 16 0 0 1 7.5 5.6"/><path d="M16.5 10.2A11 11 0 0 1 19 12.5"/><path d="M14 5.3A16 16 0 0 1 22 8.8"/><path d="M9 16a5 5 0 0 1 6 0"/><circle cx="12" cy="19.5" r=".7" fill="currentColor"/>',
  inboxEmpty: '<path d="M4 6.5h16v11H4z"/><path d="M4 13h4l1.6 2.4h4.8L16 13h4"/><path d="M9.5 9.5h5"/>',
  note: '<path d="M6 4h9l4 4v12H6z"/><path d="M14.5 4v4.5H19"/><path d="M9 13h6M9 16.5h4"/>',
  reply: '<path d="M9 7 4 12l5 5"/><path d="M4 12h9a6 6 0 0 1 6 6v1"/>',
  send: '<path d="M4.5 12 20 5l-6.2 14.5-2.4-6z"/><path d="m11.4 13.5 8.6-8.5"/>',
  paperclip: '<path d="M17.5 10.5 11 17a3.5 3.5 0 0 1-5-5l7-7a2.5 2.5 0 0 1 3.5 3.5l-6.6 6.6a1.4 1.4 0 0 1-2-2l6-6"/>',
  emoji: '<circle cx="12" cy="12" r="8"/><circle cx="9.5" cy="10" r=".8" fill="currentColor"/><circle cx="14.5" cy="10" r=".8" fill="currentColor"/><path d="M8.8 14.2a4 4 0 0 0 6.4 0"/>',
  macro: '<path d="m13 3-8 10h6l-2 8 8-10h-6z"/>',
  snooze: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 1.5"/><path d="M8 3.5 5 6M16 3.5 19 6"/>',
  resolve: '<circle cx="12" cy="12" r="8"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/>',
  assign: '<circle cx="10" cy="9" r="3.2"/><path d="M4.5 19a5.5 5.5 0 0 1 11 0"/><path d="M17.5 8v5M15 10.5h5"/>',
  flag: '<path d="M6 21V4"/><path d="M6 4.8h10.5l-1.8 3.4 1.8 3.4H6z"/>',
  user: '<circle cx="12" cy="8.5" r="3.4"/><path d="M5.5 19.5a6.5 6.5 0 0 1 13 0"/>',
  users: '<circle cx="9" cy="9" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16.5 6.4a3 3 0 0 1 0 5.2"/><path d="M18 14.4a5 5 0 0 1 2.5 4.6"/>',
  bookmark: '<path d="M7 4h10v16l-5-3.6L7 20z"/>',
  tag: '<path d="M4 11.5V4.5h7l9 9-7 7z"/><circle cx="8" cy="8" r="1.2"/>',
  building: '<path d="M4 20V6.5L12 4v16"/><path d="M12 9.5h8V20"/><path d="M20 20H3.5"/><path d="M7 9h2M7 12.5h2M7 16h2M15 13h2M15 16.5h2"/>',
  link: '<path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.2 1.2"/><path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.2-1.2"/>',
  refresh: '<path d="M20 7v5h-5"/><path d="M19.2 12A7.2 7.2 0 1 0 17 17.1"/>',
  download: '<path d="M12 4v10"/><path d="m8 10.5 4 4 4-4"/><path d="M4.5 19.5h15"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.2 6.4A9.8 9.8 0 0 1 12 6.2c4.4 0 8 3.3 9.2 5.8a12 12 0 0 1-3 3.6"/><path d="M6.6 8.1A12 12 0 0 0 2.8 12c1.2 2.5 4.8 5.8 9.2 5.8 1.2 0 2.3-.2 3.3-.6"/><path d="M9.9 10.2a3 3 0 0 0 4 4"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4.5V9h4.5"/><path d="M12 8v4.4l3 1.8"/>',
  sparkline: '<path d="M4 15.5 8.5 10l3.5 3 3.5-6 4.5 6.5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 5.5h-9a2 2 0 0 0-2 2v9"/>',
  info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5.5"/><circle cx="12" cy="8.2" r=".7" fill="currentColor"/>',
  globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16"/><path d="M12 4a13 13 0 0 1 0 16 13 13 0 0 1 0-16z"/>',
  language: '<path d="M4 6h9"/><path d="M8.2 4.5V6"/><path d="M10.5 6c-.6 4-3 6.6-6 8"/><path d="M6 9.6c1 2.3 3 4.1 5.3 4.9"/><path d="m12.5 19.5 3.6-8.5 3.6 8.5"/><path d="M13.7 16.6h5"/>',
  sun: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"/>',
  moon: '<path d="M20 15.2A8 8 0 0 1 8.8 4a8.3 8.3 0 1 0 11.2 11.2z"/>',
  sidebar: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M9 4v16"/><path d="m14 9 3 3-3 3"/>',
  panel: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M15 4v16"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  logout: '<path d="M14 4.5h4a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-4"/><path d="M10 16.5 5.5 12 10 7.5"/><path d="M5.5 12H15"/>',
  checkDouble: '<path d="m2.5 12.5 4 4L15 8"/><path d="m11 16 1 .5L21.5 8"/>',
  device: '<rect x="3.5" y="5" width="17" height="11" rx="1.6"/><path d="M8.5 19.5h7M12 16v3.5"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  key: '<circle cx="8" cy="14.5" r="3.8"/><path d="m10.8 11.8 8.2-8.3M16 6.5l2.5 2.5M13.5 9l2 2"/>',
  plug: '<path d="M9 3.5v5M15 3.5v5"/><path d="M6.5 8.5h11v2.5a5.5 5.5 0 0 1-11 0z"/><path d="M12 16.5v4"/>',
  image: '<rect x="4" y="4.5" width="16" height="15" rx="2"/><circle cx="9.5" cy="10" r="1.6"/><path d="m20 16-4.5-4.5L7 20"/>',
  template: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/>',
  webhook: '<path d="M9.5 8.5a3.5 3.5 0 1 1 5.2 3L17.5 17"/><path d="M6.8 18.5a3.5 3.5 0 0 1-.6-6.2L9 7.5"/><path d="M11 16h6.5a3.5 3.5 0 1 1-2.6 5.8"/>',
  externalLink: '<path d="M13.5 4.5h6v6"/><path d="m19.5 4.5-8 8"/><path d="M17 13.5v5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18.5v-10A1.5 1.5 0 0 1 5.5 7h5"/>',
  eye: '<path d="M3.5 12c1.4-2.6 4.8-5.5 8.5-5.5s7.1 2.9 8.5 5.5c-1.4 2.6-4.8 5.5-8.5 5.5S4.9 14.6 3.5 12z"/><circle cx="12" cy="12" r="3.1"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
  plane: '<path d="M20.5 4 3.5 11l5.5 2.2L11 19.5l3.2-4 4 3z"/><path d="m9 13.2 11.5-9.2"/>',
  code: '<path d="m8.5 7.5-5 4.5 5 4.5"/><path d="m15.5 7.5 5 4.5-5 4.5"/><path d="m13.5 5-3 14"/>',
  chat: '<path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11l-4.5 3.5V16.5h0a2 2 0 0 1-2-2z"/><path d="M8.5 9.5h7M8.5 12.5h4.5"/>',
  funnel: '<path d="M4 5h16l-6 7.5V19l-4-2v-4.5z"/>',
  pause: '<path d="M9 5.5v13M15 5.5v13"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  edit: '<path d="M4.5 19.5h4l10-10a2.8 2.8 0 0 0-4-4l-10 10z"/><path d="m13.5 6.5 4 4"/>',
  flask: '<path d="M9.5 3.5h5M10.5 3.5v5.5L5 18.5a1.3 1.3 0 0 0 1.1 2h11.8a1.3 1.3 0 0 0 1.1-2L13.5 9V3.5"/><path d="M7.5 14h9"/>',
  contacts: '<rect x="4" y="4.5" width="16" height="15" rx="2"/><circle cx="12" cy="10.5" r="2.6"/><path d="M8 16.5a4.2 4.2 0 0 1 8 0"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>',
  bell: '<path d="M5 17.5h14l-1.7-2.2V10a5.3 5.3 0 0 0-10.6 0v5.3z"/><path d="M10 20a2.2 2.2 0 0 0 4 0"/>',
  /* User management, permissions and integrations. */
  userPlus: '<circle cx="9.5" cy="8.5" r="3.4"/><path d="M3.5 19.5a6 6 0 0 1 12 0"/><path d="M18.5 8v6M15.5 11h6"/>',
  userCheck: '<circle cx="9.5" cy="8.5" r="3.4"/><path d="M3.5 19.5a6 6 0 0 1 12 0"/><path d="m15.5 11.5 2 2 4-4"/>',
  shieldUser: '<path d="M12 3.5 5 6v6c0 4 3 7 7 8.5 4-1.5 7-4.5 7-8.5V6z"/><circle cx="12" cy="10.5" r="2.3"/><path d="M8.5 16.5a3.8 3.8 0 0 1 7 0"/>',
  team: '<circle cx="12" cy="8" r="3"/><path d="M6.5 19.5a5.5 5.5 0 0 1 11 0"/><circle cx="5" cy="10" r="2"/><path d="M2 17.5a3.6 3.6 0 0 1 3.3-3"/><circle cx="19" cy="10" r="2"/><path d="M22 17.5a3.6 3.6 0 0 0-3.3-3"/>',
  badgeCheck: '<path d="M12 3.5 14.2 5l2.6-.2.8 2.5 2.2 1.5-.9 2.4.9 2.4-2.2 1.5-.8 2.5-2.6-.2L12 19.5l-2.2-1.5-2.6.2-.8-2.5-2.2-1.5.9-2.4-.9-2.4 2.2-1.5.8-2.5 2.6.2z"/><path d="m9 11.8 2 2 4-4"/>',
  workflow: '<rect x="3.5" y="4" width="6" height="5" rx="1.2"/><rect x="14.5" y="15" width="6" height="5" rx="1.2"/><path d="M6.5 9v3.5a2 2 0 0 0 2 2h6"/><path d="m12.5 12.5 2 2-2 2"/>',
  book: '<path d="M4.5 5.5A1.5 1.5 0 0 1 6 4h5v15H6a1.5 1.5 0 0 0-1.5 1.5z"/><path d="M19.5 5.5A1.5 1.5 0 0 0 18 4h-5v15h5a1.5 1.5 0 0 1 1.5 1.5z"/>',
  trash: '<path d="M4.5 6.5h15"/><path d="M9.5 6.5V4.5h5v2"/><path d="M6.5 6.5 7.5 20h9l1-13.5"/><path d="M10 10.5v6M14 10.5v6"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4" rx="1"/><path d="M5 8.5v10a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-10"/><path d="M10 12.5h4"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4.5V9h4.5"/><path d="m9.5 12.5 2 2 3.5-4"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  layers: '<path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5"/><path d="m3.5 16.5 8.5 4.5 8.5-4.5"/>',
  braces: '<path d="M8 4.5H7a2 2 0 0 0-2 2v3a2.5 2.5 0 0 1-2 2.5 2.5 2.5 0 0 1 2 2.5v3a2 2 0 0 0 2 2h1"/><path d="M16 4.5h1a2 2 0 0 1 2 2v3a2.5 2.5 0 0 0 2 2.5 2.5 2.5 0 0 0-2 2.5v3a2 2 0 0 1-2 2h-1"/><path d="m13.5 7-3 10"/>',
  webChat: '<rect x="2.5" y="3.5" width="19" height="17" rx="3"/><path d="M2.5 8h19"/><circle cx="5.6" cy="5.8" r=".7" fill="currentColor" stroke="none"/><circle cx="8" cy="5.8" r=".7" fill="currentColor" stroke="none"/><path d="M8.5 10.8h7a1.8 1.8 0 0 1 1.8 1.8v1.6a1.8 1.8 0 0 1-1.8 1.8h-4.2l-2.8 2.2V16h0a1.8 1.8 0 0 1-1.8-1.8v-1.6a1.8 1.8 0 0 1 1.8-1.8z"/><circle cx="9.9" cy="13.4" r=".6" fill="currentColor" stroke="none"/><circle cx="12" cy="13.4" r=".6" fill="currentColor" stroke="none"/><circle cx="14.1" cy="13.4" r=".6" fill="currentColor" stroke="none"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

const DIRECTIONAL_ICONS: ReadonlySet<IconName> = new Set(['chevronEnd', 'chevronStart']);

export function icon(name: IconName, size = 16, attrs: Attrs = {}): SVGElement {
  if (!DIRECTIONAL_ICONS.has(name)) return svgIcon(ICON_PATHS[name], size, attrs);
  const suppliedClass = typeof attrs['class'] === 'string' ? attrs['class'] : '';
  return svgIcon(ICON_PATHS[name], size, {
    ...attrs,
    class: `icon--directional${suppliedClass === '' ? '' : ` ${suppliedClass}`}`,
  });
}
