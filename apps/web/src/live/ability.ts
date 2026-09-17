import type { MembershipSummary } from '../api/people.js';
import type { ScreenId } from '../router.js';
import { SCREENS } from '../router.js';
import type { LiveState } from './store.js';
import { openSession } from './store.js';

/**
 * What the signed-in person may do to a conversation's routing, for drawing the
 * screen.
 *
 * Invariant I4: **a hidden button is not an authorization control.** Every act
 * below is decided again on the server against a principal read from the
 * database, and this exists only so an operator is not offered a control that
 * would always refuse — which teaches them the software is unreliable rather
 * than that they lack the authority.
 *
 * Two keys, mirrored from `business-rules.md` §7 and ADR-0017, and kept honest
 * by a unit test that regenerates this table from `BUILTIN_ROLES` in
 * `@convo/domain`. The domain is a **devDependency** of this app: a test-time
 * oracle, never a runtime import, so the bundle stays dependency-free.
 */

export interface RoutingAbility {
  /** `conversation.assign` — put work on somebody else's desk, agreed or not. */
  readonly mayAssign: boolean;
  /** `conversation.handoff.request` — offer your own conversation to a colleague. */
  readonly mayAsk: boolean;
}

/**
 * The scope level each built-in role holds for the two routing keys.
 *
 * Only presence matters here, not the level: whether a *particular*
 * conversation is in scope is a question the server answers, and answering it
 * in the browser would be a second implementation of `authorize` that could
 * disagree with the first.
 */
export const ROUTING_GRANTS: Readonly<Record<string, RoutingAbility>> = {
  owner: { mayAssign: true, mayAsk: true },
  admin: { mayAssign: true, mayAsk: true },
  supervisor: { mayAssign: true, mayAsk: true },
  // The clarification ADR-0017 exists for: an Agent may ask, and may not assign.
  agent: { mayAssign: false, mayAsk: true },
  campaign_manager: { mayAssign: false, mayAsk: false },
  analyst: { mayAssign: false, mayAsk: false },
  integration_developer: { mayAssign: false, mayAsk: false },
};

const LEGACY_ROUTING_PERMISSIONS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(ROUTING_GRANTS).map(([roleKey, ability]) => [
    roleKey,
    [
      ...(ability.mayAssign ? ['conversation.assign'] : []),
      ...(ability.mayAsk ? ['conversation.handoff.request'] : []),
    ],
  ]),
);

const NONE: RoutingAbility = { mayAssign: false, mayAsk: false };

/** The membership being used right now, or `null` when there is no session. */
export function currentMembership(
  live: LiveState,
): { readonly id: string; readonly roleKey: string; readonly permissions: readonly string[] } | null {
  if (live.session.status !== 'signed_in') {
    return null;
  }
  // A `null` tenant is left to miss the lookup rather than checked separately:
  // "no active membership" and "no membership for the company being viewed" are
  // the same answer, and two ways to say it is one of them going stale.
  const tenantId = live.session.tenantId;
  const membership = live.session.memberships.find((entry) => entry.tenant.id === tenantId);
  return membership === undefined
    ? null
    : {
        id: membership.id,
        roleKey: membership.role.key,
        // New servers always send the keys. The fallback keeps a rolling
        // deployment safe while an older API instance may still answer a new
        // browser: built-in roles use the pinned matrix and an unknown/custom
        // role gets no guessed authority until its keys arrive.
        permissions:
          membership.permissions ??
          LEGACY_ROUTING_PERMISSIONS[membership.role.key] ??
          [],
      };
}

/**
 * The membership an open workspace is using, whole, or `null` when the server
 * no longer lists it. Only asked inside the shell, which requires a session.
 */
export function activeMembership(live: LiveState): MembershipSummary | null {
  const { memberships, tenantId } = openSession(live);
  return memberships.find((entry) => entry.tenant.id === tenantId) ?? null;
}

/**
 * Whether the server granted this key to the current membership.
 *
 * Only for deciding what to *offer*. The endpoint behind every control checks
 * the same key again, with scope, against the database — this never widens
 * anything, and a missing key simply means the control is not drawn.
 */
export function hasPermission(live: LiveState, key: string): boolean {
  return currentMembership(live)?.permissions.includes(key) ?? false;
}

/**
 * The keys that make each screen worth opening. Any one is enough.
 *
 * Settings has none because it is about this person's own sessions and view
 * preferences, which every signed-in member has.
 */
export const SCREEN_KEYS: Readonly<Record<ScreenId, readonly string[]>> = {
  'accept-invitation': [],
  'reset-password': [],
  inbox: ['conversation.read', 'conversation.unassigned.preview'],
  contacts: ['contact.read'],
  channels: ['channel.manage'],
  people: ['member.manage', 'role.manage'],
  broadcasts: ['campaign.read', 'campaign.draft'],
  automations: ['automation.read', 'automation.create'],
  analytics: ['report.read'],
  settings: [],
};

/** The screens offered in the navigation, in their navigation order. */
export function allowedScreens(live: LiveState): readonly ScreenId[] {
  return SCREENS.filter((screen) => {
    if (screen === 'accept-invitation' || screen === 'reset-password') return false;
    const keys = SCREEN_KEYS[screen];
    return keys.length === 0 || keys.some((key) => hasPermission(live, key));
  });
}

/**
 * Where a membership lands when the screen it asked for is not one it can open.
 *
 * Settings is last and always available, so it is where a membership with no
 * other grant ends up.
 */
export function landingScreen(live: LiveState): ScreenId {
  for (const screen of allowedScreens(live)) {
    if (screen !== 'settings') return screen;
  }
  return 'settings';
}

/**
 * What to offer this person.
 *
 * The server returns the actual permission keys for the current membership, so
 * a custom role behaves like its grants instead of being hidden merely because
 * this browser has never heard its name. Scope remains a server-side decision.
 */
export function routingAbility(live: LiveState): RoutingAbility {
  const membership = currentMembership(live);
  return membership === null
    ? NONE
    : {
        mayAssign: membership.permissions.includes('conversation.assign'),
        mayAsk: membership.permissions.includes('conversation.handoff.request'),
      };
}
