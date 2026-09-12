import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { asExecutor, withTenant } from '@convo/database';
import type { SqlExecutor } from '@convo/domain';
import type { Pool } from 'pg';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { ApiConfig } from '../config.js';
import { ApiHttpError } from '../http-error.js';
import { requestHash, type JsonValue } from '../idempotency/canonical-json.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { API_CONFIG, API_POOL } from '../tokens.js';
import type { CampaignExportInput } from './campaign-request.js';

export interface CampaignExportView {
  readonly id: string;
  readonly campaign_id: string | null;
  readonly format: 'csv';
  readonly state: 'queued' | 'running' | 'completed' | 'failed';
  readonly row_count: number | null;
  readonly error_code: string | null;
  readonly requested_at: string;
  readonly completed_at: string | null;
  readonly expires_at: string | null;
  readonly download_url: string | null;
}

interface ExportRow {
  readonly id: string;
  readonly campaign_id: string | null;
  readonly format: 'csv';
  readonly state: CampaignExportView['state'];
  readonly row_count: number | null;
  readonly error_code: string | null;
  readonly requested_at: Date;
  readonly completed_at: Date | null;
  readonly expires_at: Date | null;
}

interface ClaimedExport { readonly id: string; readonly campaign_id: string | null }

@Injectable()
export class CampaignReportExportService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  async create(
    session: AuthenticatedSession,
    tenantId: string,
    input: CampaignExportInput,
    rawBody: unknown,
    idempotencyKey: string,
  ): Promise<CampaignExportView> {
    this.authorization.assertTenantId(tenantId);
    const outcome = await this.idempotency.execute({
      tenantContextId: tenantId,
      tenantId,
      principalId: session.userId,
      operation: 'campaign-report.export',
      key: idempotencyKey,
      requestHash: requestHash(rawBody as JsonValue, this.config.secrets.idempotencyHash),
    }, async (sql) => {
      const principal = await this.authorization.requirePermission(sql, session, 'report.read');
      if (input.campaignId !== null) await requireCampaign(sql, input.campaignId);
      const inserted = await sql.query<ExportRow>(
        `INSERT INTO campaign_report_exports
           (tenant_id,requested_by_membership_id,campaign_id,format)
         VALUES ($1,$2,$3,'csv')
         RETURNING id::text,campaign_id::text,format,state,row_count,error_code,
                   requested_at,completed_at,expires_at`,
        [tenantId, principal.membershipId, input.campaignId],
      );
      const row = inserted.rows[0]!;
      await sql.query(
        `INSERT INTO campaign_report_export_queue(export_id,tenant_id) VALUES ($1,$2)`,
        [row.id, tenantId],
      );
      return { statusCode: 202, body: exportView(row, tenantId) };
    });
    if (outcome.status === 'conflict') throw new ApiHttpError(409, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request.');
    return outcome.response.body as CampaignExportView;
  }

  status(session: AuthenticatedSession, tenantId: string, exportId: string): Promise<CampaignExportView> {
    return this.authorization.authorized(session, tenantId, 'report.read', async ({ sql, principal }) => {
      const row = await ownExport(sql, exportId, principal.membershipId);
      return exportView(row, tenantId);
    });
  }

  content(session: AuthenticatedSession, tenantId: string, exportId: string): Promise<{ readonly filename: string; readonly content: string; readonly sha256: string }> {
    return this.authorization.authorized(session, tenantId, 'report.read', async ({ sql, principal }) => {
      const result = await sql.query<ExportRow & { readonly content_text: string | null; readonly content_sha256: string | null }>(
        `SELECT id::text,campaign_id::text,format,state,row_count,error_code,requested_at,
                completed_at,expires_at,content_text,content_sha256
           FROM campaign_report_exports
          WHERE id=$1 AND requested_by_membership_id=$2`,
        [exportId, principal.membershipId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new ApiHttpError(404, 'export_not_found', 'The report export was not found.');
      if (row.state !== 'completed' || row.content_text === null || row.content_sha256 === null) {
        throw new ApiHttpError(409, 'export_not_ready', 'The report export is not ready.');
      }
      if (row.expires_at === null || row.expires_at.getTime() <= Date.now()) {
        throw new ApiHttpError(410, 'export_expired', 'The report export has expired. Create a new export.');
      }
      return { filename: `campaign-report-${row.id}.csv`, content: row.content_text, sha256: row.content_sha256 };
    });
  }

  async pendingTenants(limit = 100): Promise<readonly string[]> {
    const rows = await asExecutor(this.pool).query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id::text FROM campaign_report_export_queue
        WHERE available_at<=now() ORDER BY tenant_id LIMIT $1`,
      [limit],
    );
    return rows.rows.map((row) => row.tenant_id);
  }

  async process(tenantId: string, limit = 10, workerId: string = randomUUID()): Promise<number> {
    let handled = 0;
    for (let index = 0; index < limit; index += 1) {
      const claimed = await this.claim(tenantId, workerId);
      if (claimed === null) break;
      handled += 1;
      try {
        const result = await withTenant(this.pool, tenantId, (client) => buildCsv(asExecutor(client), claimed.campaign_id));
        await withTenant(this.pool, tenantId, async (client) => {
          const sql = asExecutor(client);
          const completed = await sql.query(
            `UPDATE campaign_report_exports
                SET state='completed',lease_owner=NULL,lease_expires_at=NULL,row_count=$3,
                    content_text=$4,content_sha256=$5,completed_at=now(),expires_at=now()+interval '24 hours'
              WHERE id=$1 AND tenant_id=$2 AND state='running' AND lease_owner=$6`,
            [claimed.id, tenantId, result.rowCount, result.content, result.sha256, workerId],
          );
          if (completed.rowCount === 1) await sql.query(`DELETE FROM campaign_report_export_queue WHERE export_id=$1`, [claimed.id]);
        });
      } catch {
        await withTenant(this.pool, tenantId, async (client) => {
          const sql = asExecutor(client);
          await sql.query(
            `UPDATE campaign_report_exports
                SET state='failed',lease_owner=NULL,lease_expires_at=NULL,error_code='export_generation_failed',completed_at=now()
              WHERE id=$1 AND tenant_id=$2 AND state='running' AND lease_owner=$3`,
            [claimed.id, tenantId, workerId],
          );
          await sql.query(`DELETE FROM campaign_report_export_queue WHERE export_id=$1`, [claimed.id]);
        });
      }
    }
    return handled;
  }

  private claim(tenantId: string, workerId: string): Promise<ClaimedExport | null> {
    return withTenant(this.pool, tenantId, async (client) => {
      const sql = asExecutor(client);
      const candidate = await sql.query<{ export_id: string }>(
        `SELECT export_id::text FROM campaign_report_export_queue
          WHERE tenant_id=$1 AND available_at<=now()
          ORDER BY available_at,export_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [tenantId],
      );
      const id = candidate.rows[0]?.export_id;
      if (id === undefined) return null;
      const claimed = await sql.query<ClaimedExport>(
        `UPDATE campaign_report_exports
            SET state='running',attempt=attempt+1,lease_owner=$3,
                lease_expires_at=now()+interval '5 minutes',started_at=coalesce(started_at,now())
          WHERE id=$1 AND tenant_id=$2
            AND (state='queued' OR (state='running' AND lease_expires_at<=now()))
            AND attempt<3
          RETURNING id::text,campaign_id::text`,
        [id, tenantId, workerId],
      );
      const row = claimed.rows[0];
      if (row === undefined) {
        await sql.query(
          `UPDATE campaign_report_exports
              SET state='failed',lease_owner=NULL,lease_expires_at=NULL,
                  error_code='export_attempts_exhausted',completed_at=now()
            WHERE id=$1 AND tenant_id=$2 AND state='running' AND attempt>=3 AND lease_expires_at<=now()`,
          [id, tenantId],
        );
        await sql.query(`DELETE FROM campaign_report_export_queue WHERE export_id=$1`, [id]);
        return null;
      }
      return row;
    });
  }
}

async function requireCampaign(sql: SqlExecutor, campaignId: string): Promise<void> {
  const result = await sql.query(`SELECT 1 FROM campaigns WHERE id=$1`, [campaignId]);
  if (result.rowCount !== 1) throw new ApiHttpError(404, 'campaign_not_found', 'The campaign was not found.');
}

async function ownExport(sql: SqlExecutor, exportId: string, membershipId: string): Promise<ExportRow> {
  const result = await sql.query<ExportRow>(
    `SELECT id::text,campaign_id::text,format,state,row_count,error_code,requested_at,completed_at,expires_at
       FROM campaign_report_exports WHERE id=$1 AND requested_by_membership_id=$2`,
    [exportId, membershipId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiHttpError(404, 'export_not_found', 'The report export was not found.');
  return row;
}

function exportView(row: ExportRow, tenantId: string): CampaignExportView {
  const live = row.state === 'completed' && row.expires_at !== null && row.expires_at.getTime() > Date.now();
  return {
    id: row.id, campaign_id: row.campaign_id, format: row.format, state: row.state,
    row_count: row.row_count, error_code: row.error_code,
    requested_at: row.requested_at.toISOString(), completed_at: row.completed_at?.toISOString() ?? null,
    expires_at: row.expires_at?.toISOString() ?? null,
    download_url: live ? `/api/v1/tenants/${tenantId}/reports/campaigns/exports/${row.id}/content` : null,
  };
}

async function buildCsv(sql: SqlExecutor, campaignId: string | null): Promise<{ readonly rowCount: number; readonly content: string; readonly sha256: string }> {
  const result = await sql.query<Record<string, string | number | boolean | Date | null>>(
    `SELECT r.campaign_id::text,c.name AS campaign_name,c.control_state AS campaign_state,
            r.channel_kind,r.current_state,
            accepted_milestone,delivered_milestone,read_milestone,
            coalesce(error_code,'') AS error_code,
            coalesce(estimated_amount_minor,0)::text AS estimated_amount_minor,
            coalesce(committed_amount_minor,0)::text AS committed_amount_minor,
            coalesce(reconciled_amount_minor,0)::text AS reconciled_amount_minor,
            coalesce(currency,'') AS currency,fresh_through
       FROM campaign_report_rows r JOIN campaigns c ON c.id=r.campaign_id
      WHERE ($1::uuid IS NULL OR r.campaign_id=$1)
      ORDER BY r.campaign_id,r.recipient_id`,
    [campaignId],
  );
  const columns = ['campaign_id','campaign_name','campaign_state','channel_kind','current_state','accepted_milestone','delivered_milestone','read_milestone','error_code','estimated_amount_minor','committed_amount_minor','reconciled_amount_minor','currency','fresh_through'];
  const lines = [columns.join(',')];
  for (const row of result.rows) lines.push(columns.map((column) => csvCell(row[column]!)).join(','));
  const content = lines.join('\r\n') + '\r\n';
  return { rowCount: result.rows.length, content, sha256: createHash('sha256').update(content).digest('hex') };
}

function csvCell(value: string | number | boolean | Date): string {
  const text = value instanceof Date ? value.toISOString() : String(value);
  const safe = /^[=+@-]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
