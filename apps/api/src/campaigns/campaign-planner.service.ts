import { Inject, Injectable } from '@nestjs/common';
import { asExecutor, withTenant } from '@convo/database';
import type { SqlExecutor } from '@convo/domain';
import type { Pool } from 'pg';
import { prepareTemplate } from '../channels/template-send.js';
import { API_POOL } from '../tokens.js';
import { campaignCommandContent } from './campaign-dispatch.js';

interface QueueRow {
  readonly execution_id: string;
  readonly stop_version: string;
  readonly execution_stop_version: string;
  readonly state: string;
  readonly scheduled_for: Date | null;
  readonly campaign_id: string;
}

interface RecipientRow {
  readonly id: string;
  readonly campaign_id: string;
  readonly execution_id: string;
  readonly external_id: string;
  readonly connection_id: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly rendered_variables: Readonly<Record<string, unknown>>;
  readonly stop_version: string;
}

/** Turns frozen campaign recipients into ordinary fenced bulk send commands. */
@Injectable()
export class CampaignPlannerService {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  async pendingTenants(limit = 100): Promise<readonly string[]> {
    const result = await asExecutor(this.pool).query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id::text FROM campaign_work_queue
        WHERE available_at <= now() ORDER BY tenant_id LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => row.tenant_id);
  }

  async plan(tenantId: string, limit = 100): Promise<number> {
    return withTenant(this.pool, tenantId, async (client) => {
      const sql = asExecutor(client);
      const candidate = await sql.query<{ execution_id: string }>(
        `SELECT execution_id::text FROM campaign_work_queue
          WHERE tenant_id=$1 AND available_at <= now()
          ORDER BY available_at,execution_id LIMIT 1`,
        [tenantId],
      );
      const executionId = candidate.rows[0]?.execution_id;
      if (executionId === undefined) return 0;

      // The control path locks campaign -> execution -> queue. Matching that
      // order prevents pause/cancel from deadlocking with a planner that is
      // starting a scheduled execution at the same instant.
      const execution = await sql.query<Omit<QueueRow, 'stop_version' | 'execution_id'>>(
        `SELECT e.stop_version::text AS execution_stop_version,e.state,e.scheduled_for,
                e.campaign_id::text
           FROM campaign_executions e JOIN campaigns c ON c.id=e.campaign_id
          WHERE e.id=$1 FOR UPDATE OF c,e`,
        [executionId],
      );
      const queue = await sql.query<{ stop_version: string }>(
        `SELECT stop_version::text FROM campaign_work_queue
          WHERE execution_id=$1 AND tenant_id=$2 AND available_at <= now()
          FOR UPDATE SKIP LOCKED`,
        [executionId, tenantId],
      );
      const executionRow = execution.rows[0]!;
      const queueRow = queue.rows[0];
      if (queueRow === undefined) return 0;
      const work: QueueRow = { execution_id: executionId, stop_version: queueRow.stop_version, ...executionRow };
      if (!(await makeRunnable(sql, work))) return 1;

      const recipients = await sql.query<RecipientRow>(
        `SELECT cr.id::text,e.campaign_id::text,e.id::text AS execution_id,i.external_id,c.connection_id::text,r.content,cr.rendered_variables,e.stop_version::text
           FROM campaign_recipients cr JOIN campaign_executions e ON e.id=cr.execution_id
           JOIN campaigns c ON c.id=e.campaign_id JOIN campaign_revisions r ON r.id=e.revision_id
           JOIN contact_identities i ON i.id=cr.identity_id
          WHERE cr.execution_id=$1 AND cr.state='planned'
          ORDER BY cr.id LIMIT $2 FOR UPDATE OF cr SKIP LOCKED`,
        [work.execution_id, limit],
      );

      let planned = 0;
      for (const recipient of recipients.rows) {
        const message = campaignCommandContent(recipient.content, recipient.rendered_variables);
        // A catalogue template is filled now, against the catalogue as it is:
        // one paused since the freeze, or values that no longer fit it, is not sent.
        const template = message?.templateId === undefined ? undefined : await prepareTemplate(sql, message.templateId, message.templateValues!);
        if (message === null || template === null) {
          await skipInvalid(sql, recipient.id);
          planned += 1;
          continue;
        }
        const inserted = await sql.query<{ id: string }>(
          `INSERT INTO outbound_messages
             (tenant_id,connection_id,peer_identity,message_type,text_body,template_name,
              template_language,template_provider_id,template_components,template_preview,client_message_id,campaign_stop_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12) RETURNING id::text`,
          [tenantId, recipient.connection_id, recipient.external_id, message.type, message.text,
            template?.name ?? message.templateName, template?.language ?? message.templateLanguage,
            template?.providerId ?? null, JSON.stringify(template?.components ?? []), template?.preview ?? null,
            `campaign:${recipient.id}`, recipient.stop_version],
        );
        const messageId = inserted.rows[0]!.id;
        await sql.query(
          `INSERT INTO outbox (message_id,tenant_id,connection_id,peer_identity,traffic_class)
           VALUES ($1,$2,$3,$4,'bulk')`,
          [messageId, tenantId, recipient.connection_id, recipient.external_id],
        );
        await sql.query(`UPDATE campaign_recipients SET command_id=$2,state='queued',updated_at=now() WHERE id=$1`, [recipient.id, messageId]);
        // Outreach never calls ConversationService.ensure: a campaign send is
        // not customer intent and must not manufacture inbox work. If a live
        // conversation already exists, bind it; otherwise leave durable
        // evidence for the next customer-created conversation to claim.
        await sql.query(
          `INSERT INTO campaign_conversation_attributions
             (tenant_id,campaign_id,execution_id,recipient_id,outbound_message_id,connection_id,peer_identity,sent_at,conversation_id,bound_at)
           SELECT $1,$2,$3,$4,outbound.id,$5,$6,outbound.created_at,live.id,
                  CASE WHEN live.id IS NULL THEN NULL ELSE now() END
             FROM outbound_messages outbound
             LEFT JOIN LATERAL (
               SELECT id FROM conversations
                WHERE tenant_id=$1 AND connection_id=$5 AND peer_identity=$6 AND status <> 'archived'
                ORDER BY created_at DESC LIMIT 1
             ) live ON TRUE
            WHERE outbound.tenant_id=$1 AND outbound.id=$7`,
          [tenantId, recipient.campaign_id, recipient.execution_id, recipient.id, recipient.connection_id, recipient.external_id, messageId],
        );
        planned += 1;
      }

      const remaining = await sql.query(`SELECT 1 FROM campaign_recipients WHERE execution_id=$1 AND state='planned' LIMIT 1`, [work.execution_id]);
      if (remaining.rowCount === 0) await sql.query(`DELETE FROM campaign_work_queue WHERE execution_id=$1`, [work.execution_id]);
      return planned;
    });
  }
}

async function makeRunnable(sql: SqlExecutor, work: QueueRow): Promise<boolean> {
  if (work.stop_version !== work.execution_stop_version) {
    await sql.query(`DELETE FROM campaign_work_queue WHERE execution_id=$1`, [work.execution_id]);
    return false;
  }
  if (work.state === 'scheduled') {
    await sql.query(`UPDATE campaign_executions SET state='running',started_at=coalesce(started_at,now()) WHERE id=$1`, [work.execution_id]);
    await sql.query(`UPDATE campaigns SET control_state='running',version=version+1,updated_at=now() WHERE id=$1`, [work.campaign_id]);
    return true;
  }
  if (work.state === 'running') return true;
  await sql.query(`DELETE FROM campaign_work_queue WHERE execution_id=$1`, [work.execution_id]);
  return false;
}

async function skipInvalid(sql: SqlExecutor, recipientId: string): Promise<void> {
  await sql.query(
    `UPDATE campaign_recipients SET state='skipped',last_error=$2::jsonb,updated_at=now() WHERE id=$1`,
    [recipientId, JSON.stringify({ code: 'invalid_campaign_content' })],
  );
  await sql.query(
    `UPDATE budget_reservations SET state='released',released_at=now(),reserved_amount_minor=0
      WHERE recipient_id=$1 AND state='reserved'`,
    [recipientId],
  );
}
