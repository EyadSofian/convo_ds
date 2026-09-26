import type { SqlExecutor, TemplateBindings, WhatsAppTemplateSendComponent } from '@convo/domain';
import {
  buildWhatsAppTemplateComponents,
  defineWhatsAppTemplate,
  renderWhatsAppTemplatePreview,
  resolveTemplateValues,
} from '@convo/domain';

/**
 * One approved catalogue template made ready for one recipient: what the
 * outbound row stores and the dispatcher sends. Shared by broadcasts and
 * automations so a template is sent the same way whichever of them sends it.
 */
export interface PreparedTemplate {
  /** The WhatsApp number the template belongs to, which is the one it is sent from. */
  readonly connectionId: string;
  readonly name: string;
  readonly language: string;
  readonly providerId: string;
  readonly components: readonly WhatsAppTemplateSendComponent[];
  readonly preview: string;
}

/**
 * `null` when the template is gone, no longer approved, or the values do not
 * fill it exactly — each a message that must not be sent.
 */
export async function prepareTemplate(
  sql: SqlExecutor,
  templateId: string,
  values: Readonly<Record<string, string>>,
): Promise<PreparedTemplate | null> {
  const row = (await sql.query<{ connection_id: string; provider_template_id: string; template_name: string; language: string; components: unknown }>(
    `SELECT connection_id::text,provider_template_id,template_name,language,components FROM whatsapp_templates WHERE id=$1 AND status='approved'`,
    [templateId],
  )).rows[0];
  if (row === undefined) return null;
  const definition = defineWhatsAppTemplate(row.components);
  const components = buildWhatsAppTemplateComponents(definition, values);
  if (components === null) return null;
  return {
    connectionId: row.connection_id,
    name: row.template_name,
    language: row.language,
    providerId: row.provider_template_id,
    components,
    preview: renderWhatsAppTemplatePreview(definition, values),
  };
}

/**
 * The values one contact gives a template's bindings, read now. An automation
 * uses this at the moment it sends; a broadcast freezes the same values when
 * its audience is validated.
 */
export async function templateValuesFor(
  sql: SqlExecutor,
  bindings: TemplateBindings,
  contactId: string,
  phone: string,
): Promise<Readonly<Record<string, string>> | null> {
  const fieldIds = Object.values(bindings).flatMap((binding) => (binding.source === 'field' ? [binding.fieldId!] : []));
  const contact = (await sql.query<{ display_name: string; fields: Readonly<Record<string, string | null>> }>(
    `SELECT c.display_name,
            coalesce((SELECT jsonb_object_agg(fv.field_id::text, ${fieldText('fv.value_json')})
                        FROM contact_custom_field_values fv
                       WHERE fv.contact_id=c.id AND fv.field_id=ANY($2::uuid[])),'{}'::jsonb) AS fields
       FROM contacts c WHERE c.id=$1 AND c.deleted_at IS NULL`,
    [contactId, fieldIds],
  )).rows[0];
  if (contact === undefined) return null;
  return resolveTemplateValues(bindings, (_key, binding) =>
    binding.source === 'display_name' ? contact.display_name
      : binding.source === 'phone' ? phone
        : binding.source === 'field' ? contact.fields[binding.fieldId!]
          : binding.value);
}

/** A custom field's stored value as the text a template shows: a list is joined. */
export function fieldText(column: string): string {
  return `CASE jsonb_typeof(${column})
            WHEN 'array' THEN (SELECT string_agg(item, ', ') FROM jsonb_array_elements_text(${column}) item)
            WHEN 'null' THEN NULL
            ELSE ${column} #>> '{}' END`;
}
