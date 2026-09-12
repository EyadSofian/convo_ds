/**
 * The permission catalogue, as types.
 *
 * The authoritative list lives in PostgreSQL — `permissions`, seeded by
 * migration `0003_permission_catalogue.sql`. This module mirrors it so the
 * domain can be checked at compile time, and `iam.test.ts` fails if the two
 * ever disagree by parsing the migration.
 *
 * Authorization is checked by KEY. A role's display name is a label for
 * humans; it never appears in a decision (business-rules.md §7, IAM-08).
 */

export const PERMISSION_KEYS = [
  'conversation.read',
  'conversation.unassigned.preview',
  'conversation.reply',
  'conversation.note',
  'conversation.claim',
  'conversation.assign',
  /**
   * Offer your own conversation to a named colleague, who may decline.
   *
   * Deliberately not `conversation.assign` (ADR-0017). Requesting a handoff from
   * work you are holding is a different act from putting work on somebody
   * else's desk, and business-rules.md §7 gives an Agent the first and denies
   * them the second. Borrowing the assign key would have handed every agent the
   * authority Supervisor exists to hold.
   */
  'conversation.handoff.request',
  'conversation.close',
  'contact.read',
  'contact.edit',
  'contact.merge',
  'contact.export',
  'consent.read',
  'consent.record',
  'suppression.write',
  'campaign.read',
  'campaign.draft',
  'campaign.approve',
  'campaign.launch',
  'campaign.control',
  'channel.manage',
  'credential.rotate',
  'member.manage',
  'role.manage',
  'catalog.read',
  'catalog.manage',
  'integration.manage',
  'api_key.manage',
  'report.read',
  'audit.read',
  'retention.manage',
  'tenant.delete',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSION_KEYS);

/** Narrows an untrusted string to a catalogue key. */
export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_SET.has(value);
}

/**
 * Keys that may never be delegated to a service principal, an API key or a
 * custom role built by a non-Owner (IAM-14, IAM-19). Mirrors `delegable = false`
 * in `0003_permission_catalogue.sql`.
 *
 * The rule behind the list: anything that can approve spend, move money-adjacent
 * state, change who can do what, or reach a provider credential is not
 * delegable. Holding an API key must never be a way to acquire those.
 */
export const NON_DELEGABLE_PERMISSIONS: readonly PermissionKey[] = [
  'campaign.approve',
  'campaign.launch',
  'campaign.control',
  'channel.manage',
  'credential.rotate',
  'member.manage',
  'role.manage',
  'catalog.manage',
  'api_key.manage',
  'audit.read',
  'retention.manage',
  'tenant.delete',
];

const NON_DELEGABLE_SET: ReadonlySet<string> = new Set<string>(NON_DELEGABLE_PERMISSIONS);

export function isDelegable(key: PermissionKey): boolean {
  return !NON_DELEGABLE_SET.has(key);
}
