import { Inject, Injectable } from '@nestjs/common';
import { normalizeSearchText } from '@convo/domain';
import type { SqlExecutor } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ApiHttpError } from '../http-error.js';

export interface LeadImportRow {
  readonly leadName: string;
  readonly mobile: string;
  readonly courseName: string;
  readonly label: string;
  readonly assignTo: string;
  readonly campaignName: string;
}

export interface LeadImportInput {
  readonly connectionId: string;
  readonly campaignName: string;
  readonly rows: readonly LeadImportRow[];
}

export interface LeadImportPreview {
  readonly totalRows: number;
  readonly validLeads: number;
  readonly newContacts: number;
  readonly existingContacts: number;
  readonly duplicateLeads: number;
  readonly invalidMobileNumbers: number;
  readonly missingRequiredFields: number;
  readonly readyToSend: number;
  readonly issues: readonly { readonly row: number; readonly code: string; readonly message: string }[];
}

export interface CampaignLeadView {
  readonly id: string; readonly contact_id: string; readonly display_name: string;
  readonly mobile: string; readonly course_name: string; readonly label: string;
  readonly assigned_to: string | null; readonly source: string; readonly status: string;
  readonly lost_reason: string | null; readonly revenue_amount_minor: string;
  readonly currency: string; readonly existing_contact: boolean; readonly repeat_lead: boolean;
  readonly imported_at: string;
}

export interface LeadOutcomeInput {
  readonly status: 'new' | 'contacted' | 'won' | 'lost' | 'unqualified';
  readonly lostReason: 'no_answer' | 'unreachable' | 'no_interest' | 'unqualified' | 'price_objection' | 'other' | null;
  readonly revenueAmountMinor: number;
  readonly currency: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Egyptian local numbers and explicit international numbers, stored as E.164 digits for WhatsApp. */
export function normalizeLeadMobile(input: string): string | null {
  const raw = input.trim().replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(raw)) return null;
  let digits = raw.replace(/^\+/, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^01[0125]\d{8}$/.test(digits)) digits = `2${digits}`;
  if (!raw.startsWith('+') && !raw.startsWith('00') && /^1[0125]\d{8}$/.test(digits)) digits = `20${digits}`; // Excel numeric cell lost the leading zero.
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  // Unprefixed national numbers outside Egypt are ambiguous and unsafe.
  if (!raw.startsWith('+') && !raw.startsWith('00') && !digits.startsWith('20')) return null;
  return digits;
}

function variants(mobile: string): string[] {
  return [mobile, `+${mobile}`, `00${mobile}`, ...(mobile.startsWith('20') ? [`0${mobile.slice(2)}`] : [])];
}

export function parseLeadImport(body: unknown): LeadImportInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('Choose a lead sheet.');
  const value = body as Record<string, unknown>;
  if (typeof value['connectionId'] !== 'string' || !UUID.test(value['connectionId']) ||
      typeof value['campaignName'] !== 'string' || value['campaignName'].trim().length < 1 || value['campaignName'].length > 160 ||
      !Array.isArray(value['rows']) || value['rows'].length < 1 || value['rows'].length > 500) {
    throw invalid('Choose a WhatsApp connection, campaign name and 1–500 lead rows.');
  }
  const fields = ['leadName', 'mobile', 'courseName', 'label', 'assignTo', 'campaignName'] as const;
  const rows: LeadImportRow[] = value['rows'].map((candidate: unknown) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) throw invalid('A lead row is malformed.');
    const row = candidate as Record<string, unknown>;
    if (fields.some((field) => typeof row[field] !== 'string' || (row[field] as string).length > 200)) throw invalid('A lead cell is malformed or too long.');
    return Object.fromEntries(fields.map((field) => [field, (row[field] as string).trim()])) as unknown as LeadImportRow;
  });
  return { connectionId: value['connectionId'], campaignName: value['campaignName'].trim(), rows };
}

const LEAD_STATUSES = new Set(['new','contacted','won','lost','unqualified']);
const LOST_REASONS = new Set(['no_answer','unreachable','no_interest','unqualified','price_objection','other']);

export function parseLeadOutcome(body: unknown): LeadOutcomeInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('Choose a lead status.');
  const value = body as Record<string, unknown>;
  const status = value['status'];
  const lostReason = value['lostReason'] ?? null;
  const revenueAmountMinor = value['revenueAmountMinor'] ?? 0;
  const currency = value['currency'] ?? 'EGP';
  if (typeof status !== 'string' || !LEAD_STATUSES.has(status) ||
      (status === 'lost' && (typeof lostReason !== 'string' || !LOST_REASONS.has(lostReason))) ||
      (status !== 'lost' && lostReason !== null) ||
      typeof revenueAmountMinor !== 'number' || !Number.isSafeInteger(revenueAmountMinor) || revenueAmountMinor < 0 ||
      (status !== 'won' && revenueAmountMinor !== 0) || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw invalid('Provide a valid status, a reason for Lost, and revenue only for Won.');
  }
  return { status: status as LeadOutcomeInput['status'], lostReason: lostReason as LeadOutcomeInput['lostReason'], revenueAmountMinor, currency };
}

@Injectable()
export class CampaignLeadImportService {
  constructor(@Inject(AuthorizationService) private readonly authorization: AuthorizationService) {}

  async listLeads(session: AuthenticatedSession, tenantId: string, campaignId: string): Promise<readonly CampaignLeadView[]> {
    this.authorization.assertTenantId(campaignId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql }) => {
      const campaign = await sql.query<{ connection_id: string }>(`SELECT connection_id::text FROM campaigns WHERE id=$1`, [campaignId]);
      if (campaign.rows[0] === undefined) throw new ApiHttpError(404, 'resource_not_found', 'Campaign not found.');
      await this.authorization.requirePermission(sql, session, 'campaign.read', { inboxId: campaign.rows[0].connection_id });
      return (await sql.query<CampaignLeadView>(`
        SELECT l.id::text,l.contact_id::text,c.display_name,l.mobile,l.course_name,lab.name AS label,
               m.display_name AS assigned_to,l.source,l.status,l.lost_reason,l.revenue_amount_minor::text,
               l.currency,l.existing_contact,l.repeat_lead,l.imported_at::text
          FROM campaign_leads l JOIN contacts c ON c.id=l.contact_id
          JOIN labels lab ON lab.id=l.label_id
          LEFT JOIN memberships m ON m.id=l.assigned_membership_id
         WHERE l.campaign_id=$1 ORDER BY l.imported_at,l.id LIMIT 500`, [campaignId])).rows;
    });
  }

  async updateOutcome(session: AuthenticatedSession, tenantId: string, campaignId: string, leadId: string,
    input: LeadOutcomeInput): Promise<CampaignLeadView> {
    this.authorization.assertTenantId(campaignId);
    this.authorization.assertTenantId(leadId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const found = await sql.query<{ connection_id: string; status: string; lost_reason: string | null;
        revenue_amount_minor: string; currency: string; assigned_membership_id: string | null }>(`
        SELECT campaign.connection_id::text,l.status,l.lost_reason,l.revenue_amount_minor::text,l.currency,
               l.assigned_membership_id::text
          FROM campaign_leads l JOIN campaigns campaign ON campaign.id=l.campaign_id
         WHERE l.id=$1 AND l.campaign_id=$2 FOR UPDATE OF l`, [leadId,campaignId]);
      const current = found.rows[0];
      if (current === undefined) throw new ApiHttpError(404, 'resource_not_found', 'Campaign lead not found.');
      await this.authorization.requirePermission(sql, session, 'contact.edit',
        { inboxId: current.connection_id, assigneeMembershipId: current.assigned_membership_id });
      const changed = current.status !== input.status || current.lost_reason !== input.lostReason ||
        Number(current.revenue_amount_minor) !== input.revenueAmountMinor || current.currency !== input.currency;
      if (changed) {
        await sql.query(`UPDATE campaign_leads SET status=$3,lost_reason=$4,revenue_amount_minor=$5,currency=$6
          WHERE id=$1 AND campaign_id=$2`, [leadId,campaignId,input.status,input.lostReason,input.revenueAmountMinor,input.currency]);
        await sql.query(`INSERT INTO campaign_lead_events
          (tenant_id,campaign_lead_id,actor_membership_id,old_status,new_status,lost_reason,revenue_amount_minor,currency)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId,leadId,principal.membershipId,current.status,input.status,input.lostReason,input.revenueAmountMinor,input.currency]);
      }
      const refreshed = await sql.query<CampaignLeadView>(`
        SELECT l.id::text,l.contact_id::text,c.display_name,l.mobile,l.course_name,lab.name AS label,
               m.display_name AS assigned_to,l.source,l.status,l.lost_reason,l.revenue_amount_minor::text,
               l.currency,l.existing_contact,l.repeat_lead,l.imported_at::text
          FROM campaign_leads l JOIN contacts c ON c.id=l.contact_id
          JOIN labels lab ON lab.id=l.label_id LEFT JOIN memberships m ON m.id=l.assigned_membership_id
         WHERE l.id=$1`, [leadId]);
      return refreshed.rows[0]!;
    });
  }

  async preview(session: AuthenticatedSession, tenantId: string, input: LeadImportInput): Promise<LeadImportPreview> {
    this.authorization.assertTenantId(input.connectionId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql }) => {
      await this.authorization.requirePermission(sql, session, 'campaign.draft', { inboxId: input.connectionId });
      await this.authorization.requirePermission(sql, session, 'contact.edit', { inboxId: input.connectionId });
      await requireWhatsApp(sql, input.connectionId);
      await this.requireLabelCreationPermission(sql, session, input);
      return inspect(sql, tenantId, input);
    });
  }

  async commit(session: AuthenticatedSession, tenantId: string, campaignId: string, input: LeadImportInput): Promise<{
    readonly preview: LeadImportPreview; readonly contactIds: readonly string[];
  }> {
    this.authorization.assertTenantId(campaignId);
    this.authorization.assertTenantId(input.connectionId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      await this.authorization.requirePermission(sql, session, 'campaign.draft', { inboxId: input.connectionId });
      await this.authorization.requirePermission(sql, session, 'contact.edit', { inboxId: input.connectionId });
      await requireWhatsApp(sql, input.connectionId);
      await this.requireLabelCreationPermission(sql, session, input);
      const campaign = await sql.query<{ name: string; connection_id: string; control_state: string }>(
        `SELECT name,connection_id::text,control_state FROM campaigns WHERE id=$1 FOR UPDATE`, [campaignId]);
      const found = campaign.rows[0];
      if (found === undefined || found.connection_id !== input.connectionId) throw invalid('The campaign and WhatsApp number do not match.');
      if (found.control_state !== 'draft') throw new ApiHttpError(409, 'campaign_not_draft', 'Only a draft campaign can import leads.');
      if (found.name !== input.campaignName) throw invalid('The sheet Campaign Name must match the broadcast name.');
      const already = await sql.query<{ mobile: string; contact_id: string }>(
        `SELECT mobile,contact_id::text FROM campaign_leads WHERE campaign_id=$1 ORDER BY mobile`, [campaignId]);
      if (already.rows.length > 0) {
        const requested = [...new Set(input.rows.map((row) => normalizeLeadMobile(row.mobile)).filter((mobile): mobile is string => mobile !== null))].sort();
        if (requested.length !== already.rows.length || requested.some((mobile, index) => mobile !== already.rows[index]!.mobile)) {
          throw new ApiHttpError(409, 'campaign_leads_already_imported', 'This campaign already has another imported audience. Create a new broadcast for a new sheet.');
        }
        return { preview: await inspect(sql, tenantId, input), contactIds: already.rows.map((row) => row.contact_id) };
      }
      const preview = await inspect(sql, tenantId, input);
      if (preview.issues.some((issue) => issue.code !== 'duplicate') || preview.readyToSend === 0) {
        throw new ApiHttpError(422, 'lead_import_invalid', 'Fix the invalid lead rows before sending.', preview.issues.map((issue) => ({ field: `rows[${issue.row - 2}]`, code: issue.code, message: issue.message })));
      }
      const people = await assignees(sql);
      const seen = new Set<string>();
      const contactIds: string[] = [];
      // Stable lock order serializes concurrent imports of the same phone and
      // prevents a pair of overlapping sheets from deadlocking.
      const ordered = input.rows.map((row) => ({ row, mobile: normalizeLeadMobile(row.mobile)! }))
        .filter(({ mobile }) => { if (seen.has(mobile)) return false; seen.add(mobile); return true; })
        .sort((a, b) => a.mobile.localeCompare(b.mobile));
      for (const { row, mobile } of ordered) {
        await sql.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`${tenantId}:${mobile}`]);
        let contactId = await matchingContact(sql, tenantId, mobile);
        const existingContact = contactId !== null;
        const repeated = contactId !== null && (await sql.query(`SELECT 1 FROM campaign_leads WHERE contact_id=$1 LIMIT 1`, [contactId])).rows.length > 0;
        if (contactId === null) {
          const created = await sql.query<{ id: string }>(
            `INSERT INTO contacts (tenant_id,display_name,search_name) VALUES ($1,$2,$3) RETURNING id::text`,
            [tenantId, row.leadName, normalizeSearchText(row.leadName)]);
          contactId = created.rows[0]!.id;
        }
        await sql.query(`INSERT INTO contact_phone_keys (tenant_id,mobile,contact_id) VALUES ($1,$2,$3)
          ON CONFLICT (tenant_id,mobile) DO NOTHING`, [tenantId, mobile, contactId]);
        const identity = await sql.query<{ contact_id: string }>(
          `SELECT contact_id::text FROM contact_identities WHERE kind='whatsapp' AND scope_id=$1 AND external_id=ANY($2::text[]) AND valid_to IS NULL LIMIT 1`,
          [input.connectionId, variants(mobile)]);
        if (identity.rows[0] !== undefined && identity.rows[0].contact_id !== contactId) {
          throw new ApiHttpError(409, 'phone_identity_conflict', 'A WhatsApp identity for this number belongs to another contact. Resolve it before import.');
        }
        if (identity.rows.length === 0) await sql.query(
          `INSERT INTO contact_identities (tenant_id,contact_id,kind,scope_id,external_id,provenance)
           VALUES ($1,$2,'whatsapp',$3,$4,$5::jsonb)`,
          [tenantId, contactId, input.connectionId, mobile, JSON.stringify({ source: 'campaign_lead_import', campaignId, actorMembershipId: principal.membershipId })]);
        const labelId = await ensureLabel(sql, tenantId, row.label);
        const assignedMembershipId = row.assignTo === '' ? null : matchAssignee(people, row.assignTo)!;
        await sql.query(
          `INSERT INTO campaign_leads (tenant_id,campaign_id,contact_id,mobile,course_name,label_id,assigned_membership_id,existing_contact,repeat_lead)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [tenantId, campaignId, contactId, mobile, row.courseName, labelId, assignedMembershipId, existingContact, repeated]);
        contactIds.push(contactId);
      }
      return { preview, contactIds };
    });
  }

  private async requireLabelCreationPermission(sql: SqlExecutor, session: AuthenticatedSession, input: LeadImportInput): Promise<void> {
    const names = [...new Set(input.rows.map((row) => row.label.toLocaleLowerCase()).filter(Boolean))];
    const found = await sql.query<{ name: string }>(
      `SELECT lower(name) AS name FROM labels WHERE state='active' AND lower(name)=ANY($1::text[])`, [names]);
    if (found.rows.length < names.length) await this.authorization.requirePermission(sql, session, 'catalog.manage');
  }
}

async function requireWhatsApp(sql: SqlExecutor, connectionId: string): Promise<void> {
  const result = await sql.query<{ kind: string }>(
    `SELECT kind FROM channel_connections WHERE id=$1 AND disconnected_at IS NULL`, [connectionId]);
  if (result.rows[0]?.kind !== 'whatsapp') throw invalid('Choose a connected WhatsApp number.');
}

interface Assignee { readonly id: string; readonly name: string; readonly email: string }
async function assignees(sql: SqlExecutor): Promise<readonly Assignee[]> {
  return (await sql.query<Assignee>(`SELECT m.id::text,m.display_name AS name,u.email::text
    FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.status='active' AND u.status='active'`)).rows;
}

function matchAssignee(people: readonly Assignee[], value: string): string | null {
  const matches = people.filter((person) => person.name.toLocaleLowerCase() === value.toLocaleLowerCase() || person.email.toLocaleLowerCase() === value.toLocaleLowerCase());
  return matches.length === 1 ? matches[0]!.id : null;
}

async function matchingContact(sql: SqlExecutor, tenantId: string, mobile: string): Promise<string | null> {
  const result = await sql.query<{ contact_id: string }>(
    `SELECT DISTINCT hit.contact_id::text FROM (
       SELECT p.contact_id FROM contact_phone_keys p JOIN contacts c ON c.id=p.contact_id
        WHERE p.tenant_id=$1 AND p.mobile=$2 AND c.deleted_at IS NULL
       UNION ALL
       SELECT i.contact_id FROM contact_identities i JOIN contacts c ON c.id=i.contact_id
        WHERE i.tenant_id=$1 AND i.kind='whatsapp' AND i.external_id=ANY($3::text[])
          AND i.valid_to IS NULL AND c.deleted_at IS NULL
     ) hit LIMIT 2`, [tenantId, mobile, variants(mobile)]);
  if (result.rows.length > 1) throw new ApiHttpError(409, 'ambiguous_mobile', `Mobile ${mobile} belongs to multiple contacts. Resolve the duplicates before import.`);
  return result.rows[0]?.contact_id ?? null;
}

async function inspect(sql: SqlExecutor, tenantId: string, input: LeadImportInput): Promise<LeadImportPreview> {
  const people = await assignees(sql);
  const issues: { row: number; code: string; message: string }[] = [];
  const seen = new Set<string>();
  let existing = 0;
  let invalidMobile = 0;
  let missing = 0;
  let duplicate = 0;
  for (const [index, row] of input.rows.entries()) {
    const number = index + 2;
    const required = [row.leadName, row.mobile, row.courseName, row.label, row.campaignName];
    if (required.some((value) => value === '')) {
      missing += 1; issues.push({ row: number, code: 'missing', message: `Row ${number}: complete name, mobile, course, label and campaign.` }); continue;
    }
    if (row.leadName.length > 200 || row.courseName.length > 160 || row.label.length > 60 || row.campaignName.length > 160) {
      issues.push({ row: number, code: 'length', message: `Row ${number}: a value is too long.` }); continue;
    }
    const mobile = normalizeLeadMobile(row.mobile);
    if (mobile === null) { invalidMobile += 1; issues.push({ row: number, code: 'mobile', message: `Row ${number}: use an Egyptian 01… number or an international +country-code number.` }); continue; }
    if (seen.has(mobile)) { duplicate += 1; issues.push({ row: number, code: 'duplicate', message: `Row ${number}: this mobile already occurs in the sheet and will be skipped.` }); continue; }
    seen.add(mobile);
    if (row.campaignName !== input.campaignName) issues.push({ row: number, code: 'campaign', message: `Row ${number}: Campaign Name differs from the broadcast name.` });
    if (row.assignTo !== '' && matchAssignee(people, row.assignTo) === null) issues.push({ row: number, code: 'assignee', message: `Row ${number}: Assign To must exactly match one active agent name or email.` });
    if (await matchingContact(sql, tenantId, mobile) !== null) existing += 1;
  }
  const ready = seen.size;
  return { totalRows: input.rows.length, validLeads: ready, newContacts: ready - existing, existingContacts: existing,
    duplicateLeads: duplicate, invalidMobileNumbers: invalidMobile, missingRequiredFields: missing,
    readyToSend: issues.some((issue) => issue.code !== 'duplicate') ? 0 : ready, issues };
}

async function ensureLabel(sql: SqlExecutor, tenantId: string, name: string): Promise<string> {
  const existing = await sql.query<{ id: string }>(`SELECT id::text FROM labels WHERE tenant_id=$1 AND lower(name)=lower($2) AND state='active'`, [tenantId, name]);
  if (existing.rows[0] !== undefined) return existing.rows[0].id;
  const inserted = await sql.query<{ id: string }>(
    `INSERT INTO labels (tenant_id,name,color) VALUES ($1,$2,'#2563EB')
     ON CONFLICT (tenant_id,lower(name)) WHERE state='active' DO NOTHING RETURNING id::text`, [tenantId, name]);
  if (inserted.rows[0] !== undefined) return inserted.rows[0].id;
  return (await sql.query<{ id: string }>(`SELECT id::text FROM labels WHERE tenant_id=$1 AND lower(name)=lower($2) AND state='active'`, [tenantId, name])).rows[0]!.id;
}

function invalid(message: string): ApiHttpError { return new ApiHttpError(422, 'lead_import_invalid', message); }
