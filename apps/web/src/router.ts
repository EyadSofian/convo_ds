/**
 * Hash routing. Every meaningful piece of screen state lives in the URL, so a
 * browser refresh, a bookmark and a shared link all land on the same screen.
 */

export const SCREENS = [
  'accept-invitation',
  'reset-password',
  'inbox',
  'contacts',
  'channels',
  'broadcasts',
  'automations',
  'analytics',
  // User management: three destinations, not one page. `people` is the Users
  // screen; its route name is kept so existing links keep working.
  'people',
  'roles',
  'teams',
  'settings',
] as const;

export type ScreenId = (typeof SCREENS)[number];

export interface Route {
  readonly screen: ScreenId;
  readonly conversationId: string | null;
  readonly params: Readonly<Record<string, string>>;
}

export const DEFAULT_ROUTE: Route = { screen: 'inbox', conversationId: null, params: {} };

function isScreen(value: string): value is ScreenId {
  return (SCREENS as readonly string[]).includes(value);
}

export function parseHash(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const segments = pathPart.split('/').filter((segment) => segment !== '');
  const screenSegment = segments[0] ?? '';
  const screen: ScreenId = isScreen(screenSegment) ? screenSegment : 'inbox';
  const second = segments[1];
  const conversationId =
    screen === 'inbox' && second !== undefined ? decodeURIComponent(second) : null;
  const params: Record<string, string> = {};
  for (const pair of queryPart.split('&')) {
    if (pair === '') continue;
    const index = pair.indexOf('=');
    const key = index === -1 ? pair : pair.slice(0, index);
    const value = index === -1 ? '' : pair.slice(index + 1);
    params[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '));
  }
  return { screen, conversationId, params };
}

export function formatHash(route: Route): string {
  const path =
    route.screen === 'inbox' && route.conversationId !== null
      ? `/inbox/${encodeURIComponent(route.conversationId)}`
      : `/${route.screen}`;
  const query = Object.entries(route.params)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return query === '' ? `#${path}` : `#${path}?${query}`;
}

export interface RouterHost {
  readonly location: { hash: string };
  addEventListener(type: 'hashchange', listener: () => void): void;
  removeEventListener(type: 'hashchange', listener: () => void): void;
}

export function readRoute(host: RouterHost): Route {
  return parseHash(host.location.hash);
}

/** Writes the route without adding a history entry loop; returns whether it changed. */
export function writeRoute(host: RouterHost, route: Route): boolean {
  const next = formatHash(route);
  if (host.location.hash === next) return false;
  host.location.hash = next;
  return true;
}

export function onRouteChange(host: RouterHost, handler: (route: Route) => void): () => void {
  const listener = (): void => handler(readRoute(host));
  host.addEventListener('hashchange', listener);
  return () => host.removeEventListener('hashchange', listener);
}
