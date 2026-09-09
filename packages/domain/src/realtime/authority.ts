/**
 * The canonical form of "what this principal may reach".
 *
 * A cursor carries a digest of this so a resumed stream can be refused when the
 * caller's authority has moved (`permissions_changed`). What goes in is
 * everything a visibility decision depends on and nothing that changes without
 * one: the membership, its status, the company's status, every grant with its
 * level, and every team and inbox scope.
 *
 * Sorted on the way out, because two principals with the same authority in a
 * different row order must produce the same digest — otherwise a client is
 * reset every time PostgreSQL returns the same grants in a different order.
 *
 * Hashing happens in the API, which has `node:crypto`. The domain stays
 * runtime-independent and testable as a pure string function, which is also the
 * part worth asserting: that adding an inbox changes the form, and that
 * re-reading the same authority does not.
 */

import type { Principal } from '../iam/authorize.js';

export function canonicalAuthority(principal: Principal): string {
  const grants = Object.entries(principal.grants)
    .map(([key, level]) => `${key}=${String(level)}`)
    .sort();
  const scopes = principal.scopes
    .map((scope) => `${scope.type}:${scope.id ?? '*'}`)
    .sort();
  const ceiling =
    principal.delegationCeiling === null ? ['*'] : [...principal.delegationCeiling].sort();
  return [
    principal.membershipId,
    principal.membershipStatus,
    principal.tenantStatus,
    grants.join(','),
    scopes.join(','),
    ceiling.join(','),
  ].join('|');
}
