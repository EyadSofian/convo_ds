import { Inject, Injectable } from '@nestjs/common';
import type {
  CustomFieldTarget,
  CustomFieldType,
  CustomFieldValue,
  Principal,
  SqlExecutor,
} from '@convo/domain';
import { authorize, reachFor, validateFieldValue } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ApiHttpError } from '../http-error.js';
import { unlessConstraint } from '../pg-error.js';
import { requireRow } from '../require-row.js';
import { readDetail, resourceOf } from '../conversations/record.js';
import { recordConversationAudit } from '../conversations/routing.service.js';

export interface Label {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly state: 'active' | 'retired';
  readonly version: number;
}

export interface CustomField {
  readonly id: string;
  readonly target: CustomFieldTarget;
  readonly key: string;
  readonly name: string;
  readonly type: CustomFieldType;
  readonly options: readonly string[];
  readonly state: 'active' | 'retired';
  readonly version: number;
}

export interface CustomFieldEntry {
  readonly fieldId: string;
  readonly value: CustomFieldValue;
}

export interface EntityMetadata {
  readonly labels: readonly Label[];
  readonly customFields: readonly CustomFieldEntry[];
}

export interface MetadataMutation {
  readonly version: number;
  readonly addLabels: readonly string[];
  readonly removeLabels: readonly string[];
  readonly fields: readonly { readonly fieldId: string; readonly value: unknown | null }[];
}

interface RawLabel {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly state: 'active' | 'retired';
  readonly version: number;
}

interface RawField {
  readonly id: string;
  readonly target: CustomFieldTarget;
  readonly key: string;
  readonly name: string;
  readonly type: CustomFieldType;
  readonly options: readonly string[];
  readonly state: 'active' | 'retired';
  readonly version: number;
}

interface MutationEffects {
  readonly addedLabels: readonly string[];
  readonly removedLabels: readonly string[];
  readonly changedFields: readonly string[];
}

interface MutableMutationEffects {
  readonly addedLabels: string[];
  readonly removedLabels: string[];
  readonly changedFields: string[];
}

@Injectable()
export class MetadataService {
  constructor(@Inject(AuthorizationService) private readonly authorization: AuthorizationService) {}

  listLabels(
    session: AuthenticatedSession,
    tenantId: string,
    includeRetired: boolean,
  ): Promise<readonly Label[]> {
    return this.authorization.authorized(session, tenantId, 'catalog.read', async ({ sql }) => {
      const rows = await sql.query<RawLabel>(
        `SELECT id::text, name, color, state, version FROM labels
          WHERE ($1::boolean OR state = 'active') ORDER BY lower(name), id`,
        [includeRetired],
      );
      return rows.rows.map(labelOf);
    });
  }

  createLabel(
    session: AuthenticatedSession,
    tenantId: string,
    input: { readonly name: string; readonly color: string },
  ): Promise<Label> {
    return this.authorization.authorized(session, tenantId, 'catalog.manage', async ({ sql, principal }) =>
      unlessConstraint('labels_active_name_uq', duplicateLabel(), async () => {
        const rows = await sql.query<RawLabel>(
          `INSERT INTO labels (tenant_id, name, color) VALUES ($1, $2, $3)
           RETURNING id::text, name, color, state, version`,
          [tenantId, input.name, input.color],
        );
        const label = labelOf(requireRow(rows.rows, 'label insert returned no row'));
        await audit(sql, tenantId, principal.membershipId, 'label_created', 'catalog', label.id, label.id, null, label);
        return label;
      }),
    );
  }

  updateLabel(
    session: AuthenticatedSession,
    tenantId: string,
    labelId: string,
    input: { readonly version: number; readonly name?: string; readonly color?: string },
  ): Promise<Label> {
    this.authorization.assertTenantId(labelId);
    return this.authorization.authorized(session, tenantId, 'catalog.manage', async ({ sql, principal }) =>
      unlessConstraint('labels_active_name_uq', duplicateLabel(), async () => {
        await findLabel(sql, labelId);
        const rows = await sql.query<RawLabel>(
          `UPDATE labels SET name = coalesce($3, name), color = coalesce($4, color),
                  version = version + 1, updated_at = now()
            WHERE id = $1 AND version = $2 AND state = 'active'
            RETURNING id::text, name, color, state, version`,
          [labelId, input.version, input.name ?? null, input.color ?? null],
        );
        const label = versioned(rows.rows, 'label');
        await audit(sql, tenantId, principal.membershipId, 'label_updated', 'catalog', label.id, label.id, null, label);
        return label;
      }),
    );
  }

  async retireLabel(
    session: AuthenticatedSession,
    tenantId: string,
    labelId: string,
    version: number,
  ): Promise<Label> {
    this.authorization.assertTenantId(labelId);
    return this.authorization.authorized(session, tenantId, 'catalog.manage', async ({ sql, principal }) => {
      await findLabel(sql, labelId);
      const rows = await sql.query<RawLabel>(
        `UPDATE labels SET state = 'retired', version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2 AND state = 'active'
          RETURNING id::text, name, color, state, version`,
        [labelId, version],
      );
      const label = versioned(rows.rows, 'label');
      await audit(sql, tenantId, principal.membershipId, 'label_retired', 'catalog', label.id, label.id, null, label);
      return label;
    });
  }

  listFields(
    session: AuthenticatedSession,
    tenantId: string,
    target: CustomFieldTarget | null,
    includeRetired: boolean,
  ): Promise<readonly CustomField[]> {
    return this.authorization.authorized(session, tenantId, 'catalog.read', async ({ sql }) => {
      const rows = await sql.query<RawField>(
        `SELECT id::text, target, key, name, type, options, state, version FROM custom_fields
          WHERE ($1::text IS NULL OR target = $1) AND ($2::boolean OR state = 'active')
          ORDER BY target, name, id`,
        [target, includeRetired],
      );
      return rows.rows.map(fieldOf);
    });
  }

  createField(
    session: AuthenticatedSession,
    tenantId: string,
    input: {
      readonly target: CustomFieldTarget;
      readonly key: string;
      readonly name: string;
      readonly type: CustomFieldType;
      readonly options: readonly string[];
    },
  ): Promise<CustomField> {
    return this.authorization.authorized(session, tenantId, 'catalog.manage', async ({ sql, principal }) =>
      unlessConstraint('custom_fields_key_uq', duplicateField(), async () => {
        const rows = await sql.query<RawField>(
          `INSERT INTO custom_fields (tenant_id, target, key, name, type, options)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           RETURNING id::text, target, key, name, type, options, state, version`,
          [tenantId, input.target, input.key, input.name, input.type, JSON.stringify(input.options)],
        );
        const field = fieldOf(requireRow(rows.rows, 'field insert returned no row'));
        await audit(sql, tenantId, principal.membershipId, 'field_created', 'catalog', field.id, field.id, null, field);
        return field;
      }),
    );
  }

  updateField(
    session: AuthenticatedSession,
    tenantId: string,
    fieldId: string,
    input: { readonly version: number; readonly name?: string; readonly options?: readonly string[] },
  ): Promise<CustomField> {
    this.authorization.assertTenantId(fieldId);
    return this.authorization.authorized(session, tenantId, 'catalog.manage', async ({ sql, principal }) => {
      const before = await findField(sql, fieldId);
      await assertOptionsUpdateSafe(sql, before, input.options);
      const options = input.options === undefined ? null : JSON.stringify(input.options);
      const rows = await sql.query<RawField>(
        `UPDATE custom_fields SET name = coalesce($3, name), options = coalesce($4::jsonb, options),
                version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2 AND state = 'active'
          RETURNING id::text, target, key, name, type, options, state, version`,
        [fieldId, input.version, input.name ?? null, options],
      );
      const field = versionedField(rows.rows, before);
      await audit(sql, tenantId, principal.membershipId, 'field_updated', 'catalog', field.id, field.id, null, field);
      return field;
    });
  }

  async retireField(
    session: AuthenticatedSession,
    tenantId: string,
    fieldId: string,
    version: number,
  ): Promise<CustomField> {
    this.authorization.assertTenantId(fieldId);
    return this.authorization.authorized(session, tenantId, 'catalog.manage', async ({ sql, principal }) => {
      const before = await findField(sql, fieldId);
      const rows = await sql.query<RawField>(
        `UPDATE custom_fields SET state = 'retired', version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2 AND state = 'active'
          RETURNING id::text, target, key, name, type, options, state, version`,
        [fieldId, version],
      );
      const field = versionedField(rows.rows, before);
      await audit(sql, tenantId, principal.membershipId, 'field_retired', 'catalog', field.id, field.id, null, field);
      return field;
    });
  }

  async conversationMetadata(
    sql: SqlExecutor,
    conversationId: string,
  ): Promise<EntityMetadata> {
    return readMetadata(sql, 'conversation', conversationId);
  }

  async mutateConversation(
    session: AuthenticatedSession,
    tenantId: string,
    conversationId: string,
    mutation: MetadataMutation,
  ): Promise<{ readonly version: number; readonly metadata: EntityMetadata }> {
    this.authorization.assertTenantId(conversationId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const detail = await readDetail(sql, conversationId);
      if (detail === null) throw notFound();
      if (!authorize(principal, 'conversation.note', resourceOf(detail)).allowed) throw denied();
      await ensureVersion(sql, 'conversations', conversationId, mutation.version);
      const effects = await this.apply(sql, tenantId, principal, 'conversation', conversationId, mutation.version + 1, mutation);
      if (effectCount(effects) === 0) return { version: mutation.version, metadata: await readMetadata(sql, 'conversation', conversationId) };
      const version = await bump(sql, 'conversations', conversationId, mutation.version);
      for (const labelId of effects.addedLabels) {
        await recordConversationAudit(sql, tenantId, { conversationId, actorMembershipId: principal.membershipId, act: 'label_added', fromValue: null, toValue: labelId, atVersion: version });
      }
      for (const labelId of effects.removedLabels) {
        await recordConversationAudit(sql, tenantId, { conversationId, actorMembershipId: principal.membershipId, act: 'label_removed', fromValue: labelId, toValue: null, atVersion: version });
      }
      for (const fieldId of effects.changedFields) {
        await recordConversationAudit(sql, tenantId, { conversationId, actorMembershipId: principal.membershipId, act: 'custom_field_changed', fromValue: null, toValue: fieldId, atVersion: version });
      }
      return { version, metadata: await readMetadata(sql, 'conversation', conversationId) };
    });
  }

  async mutateContact(
    session: AuthenticatedSession,
    tenantId: string,
    contactId: string,
    mutation: MetadataMutation,
  ): Promise<{ readonly version: number; readonly metadata: EntityMetadata }> {
    this.authorization.assertTenantId(contactId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      if (!(await canReachContact(sql, principal, contactId))) throw denied();
      await ensureVersion(sql, 'contacts', contactId, mutation.version);
      const effects = await this.apply(sql, tenantId, principal, 'contact', contactId, mutation.version + 1, mutation);
      if (effectCount(effects) === 0) return { version: mutation.version, metadata: await readMetadata(sql, 'contact', contactId) };
      const version = await bump(sql, 'contacts', contactId, mutation.version);
      return { version, metadata: await readMetadata(sql, 'contact', contactId) };
    });
  }

  private async apply(
    sql: SqlExecutor,
    tenantId: string,
    principal: Principal,
    target: CustomFieldTarget,
    entityId: string,
    entityVersion: number,
    mutation: MetadataMutation,
  ): Promise<MutationEffects> {
    const labelTable = target === 'contact' ? 'contact_labels' : 'conversation_labels';
    const entityColumn = target === 'contact' ? 'contact_id' : 'conversation_id';
    const valueTable = target === 'contact' ? 'contact_custom_field_values' : 'conversation_custom_field_values';

    const effects: MutableMutationEffects = { addedLabels: [], removedLabels: [], changedFields: [] };
    await assertLabels(sql, mutation.addLabels, true);
    await assertLabels(sql, mutation.removeLabels, false);
    for (const labelId of mutation.addLabels) {
      const inserted = await sql.query(
        `INSERT INTO ${labelTable} (tenant_id, ${entityColumn}, label_id, assigned_by_membership_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
        [tenantId, entityId, labelId, principal.membershipId],
      );
      if (inserted.rows.length > 0) {
        effects.addedLabels.push(labelId);
        await audit(sql, tenantId, principal.membershipId, 'label_assigned', target, entityId, labelId, entityVersion, labelId);
      }
    }
    for (const labelId of mutation.removeLabels) {
      const removed = await sql.query(
        `UPDATE ${labelTable} SET removed_at = now(), removed_by_membership_id = $4
          WHERE tenant_id = $1 AND ${entityColumn} = $2 AND label_id = $3
            AND removed_at IS NULL RETURNING id`,
        [tenantId, entityId, labelId, principal.membershipId],
      );
      if (removed.rows.length > 0) {
        effects.removedLabels.push(labelId);
        await audit(sql, tenantId, principal.membershipId, 'label_removed', target, entityId, labelId, entityVersion, labelId);
      }
    }
    for (const entry of mutation.fields) {
      if (entry.value === null) {
        await fieldFor(sql, entry.fieldId, target, false);
        const cleared = await sql.query(
          `DELETE FROM ${valueTable} WHERE ${entityColumn} = $1 AND field_id = $2 RETURNING value_json`,
          [entityId, entry.fieldId],
        );
        if (cleared.rows.length > 0) {
          effects.changedFields.push(entry.fieldId);
          await audit(sql, tenantId, principal.membershipId, 'field_value_cleared', target, entityId, entry.fieldId, entityVersion, cleared.rows[0]);
        }
        continue;
      }
      const field = await fieldFor(sql, entry.fieldId, target, true);
      const checked = validateFieldValue(field, entry.value);
      if (!checked.ok) throw invalidValue(entry.fieldId, checked.code);
      const written = await sql.query(
        `INSERT INTO ${valueTable}
           (tenant_id, ${entityColumn}, field_id, value_json, search_value, updated_by_membership_id)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (tenant_id, ${entityColumn}, field_id) DO UPDATE
           SET value_json = excluded.value_json, search_value = excluded.search_value,
               updated_by_membership_id = excluded.updated_by_membership_id, updated_at = now()
           WHERE ${valueTable}.value_json IS DISTINCT FROM excluded.value_json
         RETURNING field_id`,
        [tenantId, entityId, entry.fieldId, JSON.stringify(checked.value), checked.search, principal.membershipId],
      );
      if (written.rows.length > 0) {
        effects.changedFields.push(entry.fieldId);
        await audit(sql, tenantId, principal.membershipId, 'field_value_set', target, entityId, entry.fieldId, entityVersion, checked.value);
      }
    }
    return effects;
  }
}

export async function readMetadata(
  sql: SqlExecutor,
  target: CustomFieldTarget,
  entityId: string,
): Promise<EntityMetadata> {
  const labelTable = target === 'contact' ? 'contact_labels' : 'conversation_labels';
  const entityColumn = target === 'contact' ? 'contact_id' : 'conversation_id';
  const valueTable = target === 'contact' ? 'contact_custom_field_values' : 'conversation_custom_field_values';
  const [labels, fields] = await Promise.all([
    sql.query<RawLabel>(
      `SELECT l.id::text, l.name, l.color, l.state, l.version FROM labels l
       JOIN ${labelTable} x ON x.label_id = l.id
       WHERE x.${entityColumn} = $1 AND x.removed_at IS NULL ORDER BY lower(l.name), l.id`,
      [entityId],
    ),
    sql.query<{ field_id: string; value_json: CustomFieldValue }>(
      `SELECT field_id::text, value_json FROM ${valueTable} WHERE ${entityColumn} = $1 ORDER BY field_id`,
      [entityId],
    ),
  ]);
  return {
    labels: labels.rows.map(labelOf),
    customFields: fields.rows.map((row) => ({ fieldId: row.field_id, value: row.value_json })),
  };
}

async function findLabel(sql: SqlExecutor, id: string): Promise<Label> {
  const rows = await sql.query<RawLabel>(
    'SELECT id::text, name, color, state, version FROM labels WHERE id = $1',
    [id],
  );
  if (rows.rows.length === 0) throw notFound();
  return labelOf(rows.rows[0] as RawLabel);
}

async function findField(sql: SqlExecutor, id: string): Promise<CustomField> {
  const rows = await sql.query<RawField>(
    'SELECT id::text, target, key, name, type, options, state, version FROM custom_fields WHERE id = $1',
    [id],
  );
  if (rows.rows.length === 0) throw notFound();
  return fieldOf(rows.rows[0] as RawField);
}

async function fieldFor(
  sql: SqlExecutor,
  id: string,
  target: CustomFieldTarget,
  activeOnly: boolean,
): Promise<{ readonly type: CustomFieldType; readonly options: readonly string[] }> {
  const rows = await sql.query<{ type: CustomFieldType; options: readonly string[] }>(
    `SELECT type, options FROM custom_fields
      WHERE id = $1 AND target = $2 AND ($3::boolean = false OR state = 'active')`,
    [id, target, activeOnly],
  );
  const field = rows.rows[0];
  if (field === undefined) throw new ApiHttpError(422, 'custom_field_unavailable', 'The custom field is retired, missing, or belongs to another record type.');
  return field;
}

async function assertLabels(
  sql: SqlExecutor,
  ids: readonly string[],
  activeOnly: boolean,
): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const rows = await sql.query<{ id: string }>(
    `SELECT id::text FROM labels
      WHERE id = ANY($1::uuid[]) AND ($2::boolean = false OR state = 'active')`,
    [unique, activeOnly],
  );
  if (rows.rows.length !== unique.length) throw new ApiHttpError(422, 'label_unavailable', 'A label is retired or does not exist.');
}

async function ensureVersion(
  sql: SqlExecutor,
  table: 'contacts' | 'conversations',
  id: string,
  version: number,
): Promise<void> {
  const rows = await sql.query<{ version: number }>(
    `SELECT version FROM ${table} WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (rows.rows[0]?.version !== version) {
    throw new ApiHttpError(409, 'entity_version_conflict', 'This record changed. Reload it and try again.');
  }
}

function effectCount(effects: MutationEffects): number {
  return effects.addedLabels.length + effects.removedLabels.length + effects.changedFields.length;
}

async function assertOptionsUpdateSafe(
  sql: SqlExecutor,
  field: CustomField,
  options: readonly string[] | undefined,
): Promise<void> {
  if (options === undefined) return;
  const select = field.type === 'single_select' || field.type === 'multi_select';
  if ((select && options.length === 0) || (!select && options.length !== 0)) {
    throw new ApiHttpError(400, 'validation_failed', 'Options must match the custom field type.');
  }
  if (!select) return;
  const table = field.target === 'contact' ? 'contact_custom_field_values' : 'conversation_custom_field_values';
  const values = await sql.query<{ value_json: CustomFieldValue }>(
    `SELECT value_json FROM ${table} WHERE field_id = $1`,
    [field.id],
  );
  const definition = { type: field.type, options } as const;
  if (values.rows.some((row) => !validateFieldValue(definition, row.value_json).ok)) {
    throw new ApiHttpError(409, 'field_options_in_use', 'Existing records use an option that would be removed.');
  }
}

async function bump(sql: SqlExecutor, table: 'contacts' | 'conversations', id: string, version: number): Promise<number> {
  const touch = table === 'contacts' ? ', updated_at = now()' : '';
  const rows = await sql.query<{ version: number }>(
    `UPDATE ${table} SET version = version + 1${touch} WHERE id = $1 AND version = $2 RETURNING version`,
    [id, version],
  );
  return requireRow(rows.rows, 'locked entity update returned no row').version;
}

async function canReachContact(
  sql: SqlExecutor,
  principal: Principal,
  contactId: string,
): Promise<boolean> {
  const exists = await sql.query('SELECT 1 FROM contacts WHERE id = $1 AND deleted_at IS NULL', [contactId]);
  if (exists.rows.length === 0) throw notFound();
  const reach = reachFor(principal, 'contact.edit');
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

async function audit(
  sql: SqlExecutor,
  tenantId: string,
  actorId: string,
  act: string,
  entityType: 'catalog' | CustomFieldTarget,
  entityId: string,
  subjectId: string,
  version: number | null,
  after: unknown,
): Promise<void> {
  await sql.query(
    `INSERT INTO metadata_audit
       (tenant_id, actor_membership_id, act, entity_type, entity_id, subject_id, entity_version, after_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [tenantId, actorId, act, entityType, entityId, subjectId, version, JSON.stringify(after)],
  );
}

function labelOf(row: RawLabel): Label { return { id: row.id, name: row.name, color: row.color, state: row.state, version: row.version }; }
function fieldOf(row: RawField): CustomField { return { id: row.id, target: row.target, key: row.key, name: row.name, type: row.type, options: row.options, state: row.state, version: row.version }; }
function versioned(rows: readonly RawLabel[], noun: string): Label {
  const row = rows[0];
  if (row === undefined) throw new ApiHttpError(409, `${noun}_version_conflict`, `This ${noun} changed or was retired. Reload it and try again.`);
  return labelOf(row);
}
function versionedField(rows: readonly RawField[], before: CustomField): CustomField {
  if (before.state === 'retired') throw new ApiHttpError(409, 'field_version_conflict', 'This field changed or was retired. Reload it and try again.');
  const row = rows[0];
  if (row === undefined) throw new ApiHttpError(409, 'field_version_conflict', 'This field changed or was retired. Reload it and try again.');
  return fieldOf(row);
}
function duplicateLabel(): ApiHttpError { return new ApiHttpError(409, 'label_exists', 'An active label already has that name.'); }
function duplicateField(): ApiHttpError { return new ApiHttpError(409, 'custom_field_exists', 'That field key already exists for this record type.'); }
function invalidValue(fieldId: string, code: string): ApiHttpError { return new ApiHttpError(422, 'custom_field_value_invalid', 'The value does not match the field definition.', [{ field: fieldId, code, message: 'Use the field type and declared options.' }]); }
function denied(): ApiHttpError { return new ApiHttpError(403, 'permission_denied', 'You do not have permission to perform this action.'); }
function notFound(): ApiHttpError { return new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.'); }
