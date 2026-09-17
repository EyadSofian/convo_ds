import { Inject, Injectable } from '@nestjs/common';
import type { PermissionKey, Principal, SqlExecutor } from '@convo/domain';
import { normalizeSearchText, reachFor, validateFieldValue } from '@convo/domain';
import type { CustomFieldType } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ApiHttpError } from '../http-error.js';
import { requireRow } from '../require-row.js';
import { readMetadata, readMetadataBatch } from '../metadata/metadata.service.js';
import type { CustomFieldEntry, Label } from '../metadata/metadata.service.js';

/**
 * Contacts: who the customer is, how we reach them, and what they agreed to.
 *
 * The rule that shapes every method here is that **an identity is scoped and is
 * never inferred**. A WhatsApp number and a page-scoped Messenger id are two
 * identities; whether they are one person is a question a human answers, not
 * one this service guesses from a similar name or a phone number that differs
 * by a country prefix (CT-03). So: resolution matches on the exact scoped
 * triple and creates a new contact when it finds nothing, and there is no
 * fuzzy path at all — not disabled, absent.
 *
 * Consent is evidence, not a flag. Recording it appends a row; withdrawing it
 * appends another. The current answer is the newest row, and nothing in this
 * file can edit or delete one (CT-06).
 *
 * **Suppression outranks consent** and lives elsewhere, keyed by identity
 * rather than by contact (CT-08). Granting consent here cannot clear it, and
 * the read reports both so an operator sees which one is in force.
 */

export interface ContactIdentity {
  readonly id: string;
  readonly kind: string;
  readonly scopeId: string;
  readonly externalId: string;
  readonly validFrom: string;
  readonly validTo: string | null;
}

export interface ConsentRecord {
  readonly channel: string;
  readonly purpose: string;
  readonly state: string;
  readonly source: string;
  readonly recordedAt: string;
  readonly actorMembershipId: string | null;
}

export interface ContactSummary {
  readonly id: string;
  readonly displayName: string;
  readonly attributes: Record<string, unknown>;
  readonly version: number;
  readonly createdAt: string;
  readonly identities: readonly ContactIdentity[];
  readonly labels: readonly Label[];
  readonly customFields: readonly CustomFieldEntry[];
}

export interface ContactDetail extends ContactSummary {
  /** Newest first. The current answer per channel and purpose is the first one. */
  readonly consent: readonly ConsentRecord[];
  /**
   * Identities this contact is suppressed on.
   *
   * Reported beside consent rather than folded into it: a suppression wins,
   * and an operator looking at a granted consent needs to see the thing that
   * overrides it in the same view.
   */
  readonly suppressed: readonly string[];
}

interface RawContact {
  readonly id: string;
  readonly display_name: string;
  readonly attributes: Record<string, unknown>;
  readonly version: number;
  readonly created_at: Date;
}

interface RawIdentity {
  readonly id: string;
  readonly contact_id: string;
  readonly kind: string;
  readonly scope_id: string;
  readonly external_id: string;
  readonly valid_from: Date;
  readonly valid_to: Date | null;
}

@Injectable()
export class ContactService {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  /**
   * The contact behind a scoped identity, created if this is the first time we
   * have seen it.
   *
   * Runs in the caller's transaction — the normalizer's — so a customer's first
   * message and the contact it created commit together. A contact that existed
   * without the message that created it, or a message with a dangling contact,
   * would both be worse than either.
   */
  async resolve(
    sql: SqlExecutor,
    tenantId: string,
    identity: { readonly kind: string; readonly scopeId: string; readonly externalId: string },
    provenance: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly contactId: string; readonly created: boolean }> {
    const existing = await sql.query<{ contact_id: string }>(
      `SELECT contact_id::text FROM contact_identities
        WHERE kind = $1 AND scope_id = $2 AND external_id = $3 AND valid_to IS NULL`,
      [identity.kind, identity.scopeId, identity.externalId],
    );
    const found = existing.rows[0];
    if (found !== undefined) {
      return { contactId: found.contact_id, created: false };
    }

    // Nothing matched this exact scoped triple, so this is somebody new *as far
    // as we can prove*. A search for a similar name or number would be the
    // inference CT-03 forbids; if they are the same person, a human merges them.
    const contact = await sql.query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, display_name, search_name) VALUES ($1, $2, $3) RETURNING id::text`,
      [tenantId, identity.externalId, normalizeSearchText(identity.externalId)],
    );
    const contactId = requireRow(contact.rows, 'the contact insert returned no id').id;
    await sql.query(
      `INSERT INTO contact_identities
         (tenant_id, contact_id, kind, scope_id, external_id, provenance)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        tenantId,
        contactId,
        identity.kind,
        identity.scopeId,
        identity.externalId,
        JSON.stringify(provenance),
      ],
    );
    return { contactId, created: true };
  }

  /** Contacts this caller may read, newest first, optionally filtered by name. */
  async list(
    session: AuthenticatedSession,
    tenantId: string,
    query: {
      readonly text: string | null;
      readonly labelIds: readonly string[];
      readonly fieldId: string | null;
      readonly fieldValue: string | null;
    },
  ): Promise<readonly ContactSummary[]> {
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const reach = reachFor(principal, 'contact.read');
      if (reach === 'none') throw denied();
      const field = await contactFilter(sql, query.fieldId, query.fieldValue);
      const tenantWide = principal.scopes.some((scope) => scope.type === 'tenant');
      const teams = principal.scopes.flatMap((scope) => scope.type === 'team' && scope.id !== null ? [scope.id] : []);
      const inboxes = principal.scopes.flatMap((scope) => scope.type === 'inbox' && scope.id !== null ? [scope.id] : []);
      const rows = await sql.query<RawContact>(
        `SELECT id::text, display_name, attributes, version, created_at
           FROM contacts
          WHERE deleted_at IS NULL
            AND ($1::text IS NULL OR search_name LIKE '%' || $1 || '%')
            AND (cardinality($2::uuid[]) = 0 OR (
              SELECT count(DISTINCT cl.label_id) FROM contact_labels cl
               WHERE cl.contact_id = contacts.id AND cl.removed_at IS NULL
                 AND cl.label_id = ANY($2::uuid[])
            ) = cardinality($2::uuid[]))
            AND ($3::uuid IS NULL OR EXISTS (
              SELECT 1 FROM contact_custom_field_values cfv
               WHERE cfv.contact_id = contacts.id AND cfv.field_id = $3
                 AND (($5::boolean AND cfv.search_value LIKE '%' || $4 || '%')
                   OR (NOT $5::boolean AND cfv.search_value = $4))
            ))
            AND ($6::text = 'tenant' OR EXISTS (
              SELECT 1 FROM conversations visible
               WHERE visible.contact_id = contacts.id
                 AND ($8::boolean
                   OR visible.team_id = ANY($9::uuid[])
                   OR visible.connection_id = ANY($10::uuid[]))
                 AND ($6::text = 'scoped'
                   OR visible.assignee_membership_id = $7
                   OR EXISTS (SELECT 1 FROM conversation_participants cp
                               WHERE cp.conversation_id = visible.id AND cp.membership_id = $7)
                   OR EXISTS (SELECT 1 FROM conversation_collaborators cc
                               WHERE cc.conversation_id = visible.id AND cc.membership_id = $7
                                 AND cc.removed_at IS NULL))
            ))
          ORDER BY created_at DESC, id
          LIMIT 200`,
        [
          query.text === null ? null : normalizeSearchText(query.text),
          query.labelIds,
          query.fieldId,
          field?.search ?? '',
          field?.contains ?? false,
          reach,
          principal.membershipId,
          tenantWide,
          teams,
          inboxes,
        ],
      );
      // Both lookups are batched. Reading metadata per row here was 2 queries
      // × up to 200 rows — 400 round trips for one request, and the entire cost
      // the load run attributed to contact search. See `readMetadataBatch`.
      const ids = rows.rows.map((row) => row.id);
      const [identities, metadata] = await Promise.all([
        identitiesFor(sql, ids),
        readMetadataBatch(sql, 'contact', ids),
      ]);
      return rows.rows.map((row) =>
        summaryOf(
          row,
          identities.get(row.id) ?? [],
          /* c8 ignore next -- readMetadataBatch returns an entry for every id it was given */
          metadata.get(row.id) ?? { labels: [], customFields: [] },
        ),
      );
    });
  }

  /** One contact, with its identities, its consent history and its suppressions. */
  async read(
    session: AuthenticatedSession,
    tenantId: string,
    contactId: string,
  ): Promise<ContactDetail> {
    this.authorization.assertTenantId(contactId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      await readContact(sql, contactId);
      if (!(await canReachContact(sql, principal, contactId, 'contact.read'))) throw denied();
      return detailOf(sql, contactId);
    });
  }

  /**
   * Edits the business fields.
   *
   * The display name and the attributes, and nothing else: an identity is not
   * editable here, because changing which number reaches a person is a
   * different act with different consequences and it is not this endpoint.
   */
  async update(
    session: AuthenticatedSession,
    tenantId: string,
    contactId: string,
    input: { readonly displayName: string },
  ): Promise<ContactDetail> {
    this.authorization.assertTenantId(contactId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      // Existence first: a caller who may not edit a contact that does not
      // exist should be told it does not exist, not that they may not.
      await readContact(sql, contactId);
      if (!(await canReachContact(sql, principal, contactId, 'contact.edit'))) throw denied();
      await sql.query(
        `UPDATE contacts
            SET display_name = $2,
                search_name = $3,
                updated_at = now()
          WHERE id = $1`,
        [
          contactId,
          input.displayName,
          normalizeSearchText(input.displayName),
        ],
      );
      return detailOf(sql, contactId);
    });
  }

  /**
   * Records consent, or its withdrawal, as a new row.
   *
   * Two refusals live here rather than in a comment:
   *
   * - An **import can never grant** consent. A row in a spreadsheet is not
   *   somebody agreeing to be messaged (CT-07).
   * - A grant **cannot lift a suppression**. Somebody who opted out stays opted
   *   out until an explicit opt-in workflow says otherwise, and that workflow
   *   does not exist yet — so the honest answer is a refusal, not a quiet
   *   success that leaves the suppression in place and the operator believing
   *   otherwise (CT-08, CT-13).
   */
  async recordConsent(
    session: AuthenticatedSession,
    tenantId: string,
    contactId: string,
    input: {
      readonly channel: string;
      readonly purpose: string;
      readonly state: string;
      readonly source: string;
      readonly proofRef: string | null;
    },
  ): Promise<ContactDetail> {
    this.authorization.assertTenantId(contactId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      if (!(await canReachContact(sql, principal, contactId, 'consent.record'))) throw denied();
      await readContact(sql, contactId);

      if (input.state === 'granted' && input.source === 'import') {
        throw new ApiHttpError(
          422,
          'import_is_not_consent',
          'An import cannot grant consent. Record the evidence of the customer agreeing instead.',
        );
      }

      const before = await detailOf(sql, contactId);
      if (input.state === 'granted' && before.suppressed.includes(input.channel)) {
        throw new ApiHttpError(
          409,
          'suppression_outranks_consent',
          'This customer opted out on that channel. Lifting it needs an explicit opt-in, which this build does not offer.',
        );
      }

      await sql.query(
        `INSERT INTO consents
           (tenant_id, contact_id, channel, purpose, state, source, proof_ref, actor_membership_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          tenantId,
          contactId,
          input.channel,
          input.purpose,
          input.state,
          input.source,
          input.proofRef,
          principal.membershipId,
        ],
      );

      return detailOf(sql, contactId);
    });
  }
}

async function contactFilter(
  sql: SqlExecutor,
  fieldId: string | null,
  raw: string | null,
): Promise<{ readonly search: string; readonly contains: boolean } | null> {
  if (fieldId === null && raw === null) return null;
  if (fieldId === null || raw === null) throw new ApiHttpError(400, 'validation_failed', 'fieldId and fieldValue must be sent together.');
  const rows = await sql.query<{ type: CustomFieldType; options: readonly string[] }>(
    `SELECT type, options FROM custom_fields WHERE id = $1 AND target = 'contact' AND state = 'active'`,
    [fieldId],
  );
  const field = rows.rows[0];
  if (field === undefined) throw new ApiHttpError(422, 'custom_field_unavailable', 'The contact field is retired or missing.');
  const candidate: unknown =
    field.type === 'number' ? Number(raw) :
    field.type === 'boolean' ? raw === 'true' ? true : raw === 'false' ? false : raw :
    field.type === 'multi_select' ? raw.split(',').filter(Boolean) : raw;
  const checked = validateFieldValue(field, candidate);
  if (!checked.ok) throw new ApiHttpError(422, 'custom_field_value_invalid', 'The filter value does not match the field definition.');
  return { search: checked.search, contains: field.type === 'text' };
}

/**
 * A contact and everything a reader needs beside it.
 *
 * One assembler rather than four call sites building the same object: the
 * suppressions are read from the same identities that were returned, so the
 * panel can never show a consent without the opt-out that overrides it.
 */
async function detailOf(sql: SqlExecutor, contactId: string): Promise<ContactDetail> {
  const contact = await readContact(sql, contactId);
  const identities = (await identitiesFor(sql, [contactId])).get(contactId) ?? [];
  return {
    ...summaryOf(contact, identities, await readMetadata(sql, 'contact', contactId)),
    consent: await consentFor(sql, contactId),
    suppressed: await suppressionsFor(sql, identities),
  };
}

/**
 * The ownership terms for a contact, derived from the conversations they are in.
 *
 * A contact belongs to no single inbox, so an `own`-level grant reaches one
 * through the conversation an agent holds. Passing the whole set means an agent
 * who holds *any* conversation with this person may edit their record, which is
 * what "own conversation's contact" means in the role matrix.
 */
async function canReachContact(
  sql: SqlExecutor,
  principal: Principal,
  contactId: string,
  permission: PermissionKey,
): Promise<boolean> {
  const reach = reachFor(principal, permission);
  if (reach === 'none') return false;
  if (reach === 'tenant') return true;
  const tenantWide = principal.scopes.some((scope) => scope.type === 'tenant');
  const teams = principal.scopes.flatMap((scope) => scope.type === 'team' && scope.id !== null ? [scope.id] : []);
  const inboxes = principal.scopes.flatMap((scope) => scope.type === 'inbox' && scope.id !== null ? [scope.id] : []);
  const rows = await sql.query(
    `SELECT 1 FROM conversations c
      WHERE c.contact_id = $1
        AND ($4::boolean OR c.team_id = ANY($5::uuid[]) OR c.connection_id = ANY($6::uuid[]))
        AND ($2::text = 'scoped' OR c.assignee_membership_id = $3
          OR EXISTS (SELECT 1 FROM conversation_participants p
                      WHERE p.conversation_id = c.id AND p.membership_id = $3)
          OR EXISTS (SELECT 1 FROM conversation_collaborators x
                      WHERE x.conversation_id = c.id AND x.membership_id = $3 AND x.removed_at IS NULL))
      LIMIT 1`,
    [contactId, reach, principal.membershipId, tenantWide, teams, inboxes],
  );
  return rows.rows.length > 0;
}

async function readContact(sql: SqlExecutor, contactId: string): Promise<RawContact> {
  const rows = await sql.query<RawContact>(
    `SELECT id::text, display_name, attributes, version, created_at
       FROM contacts WHERE id = $1 AND deleted_at IS NULL`,
    [contactId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
  }
  return row;
}

async function identitiesFor(
  sql: SqlExecutor,
  contactIds: readonly string[],
): Promise<Map<string, ContactIdentity[]>> {
  const map = new Map<string, ContactIdentity[]>();
  if (contactIds.length === 0) {
    return map;
  }
  const rows = await sql.query<RawIdentity>(
    `SELECT id::text, contact_id::text, kind, scope_id::text, external_id, valid_from, valid_to
       FROM contact_identities
      WHERE contact_id = ANY($1::uuid[])
      ORDER BY valid_from DESC`,
    [[...new Set(contactIds)]],
  );
  for (const row of rows.rows) {
    const existing = map.get(row.contact_id) ?? [];
    existing.push({
      id: row.id,
      kind: row.kind,
      scopeId: row.scope_id,
      externalId: row.external_id,
      validFrom: row.valid_from.toISOString(),
      validTo: row.valid_to?.toISOString() ?? null,
    });
    map.set(row.contact_id, existing);
  }
  return map;
}

async function consentFor(sql: SqlExecutor, contactId: string): Promise<readonly ConsentRecord[]> {
  const rows = await sql.query<{
    channel: string;
    purpose: string;
    state: string;
    source: string;
    recorded_at: Date;
    actor_membership_id: string | null;
  }>(
    `SELECT channel, purpose, state, source, recorded_at, actor_membership_id::text
       FROM consents WHERE contact_id = $1
      ORDER BY recorded_at DESC, id
      LIMIT 100`,
    [contactId],
  );
  return rows.rows.map((row) => ({
    channel: row.channel,
    purpose: row.purpose,
    state: row.state,
    source: row.source,
    recordedAt: row.recorded_at.toISOString(),
    actorMembershipId: row.actor_membership_id,
  }));
}

/**
 * The channels this contact is suppressed on.
 *
 * Read through the *live* identities, because a suppression is keyed by the
 * identity value rather than by the contact — which is exactly what makes it
 * survive a merge, a deletion and a CRM import (CT-08).
 */
async function suppressionsFor(
  sql: SqlExecutor,
  identities: readonly ContactIdentity[],
): Promise<readonly string[]> {
  const live = identities.filter((identity) => identity.validTo === null);
  if (live.length === 0) {
    return [];
  }
  const rows = await sql.query<{ kind: string }>(
    // Two parallel arrays rather than a composite literal: the pair has to be
    // matched as a pair, and building `(a,b)` text would put quoting rules
    // between us and a correctness question.
    `SELECT DISTINCT s.kind
       FROM channel_suppressions s
       JOIN unnest($1::text[], $2::text[]) AS wanted(kind, external_id)
         ON s.kind = wanted.kind AND s.peer_identity = wanted.external_id`,
    [live.map((identity) => identity.kind), live.map((identity) => identity.externalId)],
  );
  return rows.rows.map((row) => row.kind);
}

function summaryOf(
  row: RawContact,
  identities: readonly ContactIdentity[],
  metadata: { readonly labels: readonly Label[]; readonly customFields: readonly CustomFieldEntry[] },
): ContactSummary {
  return {
    id: row.id,
    displayName: row.display_name,
    attributes: row.attributes,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    identities,
    labels: metadata.labels,
    customFields: metadata.customFields,
  };
}

function denied(): ApiHttpError {
  return new ApiHttpError(
    403,
    'permission_denied',
    'You do not have permission to perform this action.',
  );
}
