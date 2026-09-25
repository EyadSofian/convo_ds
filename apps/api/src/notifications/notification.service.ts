import { Inject, Injectable } from '@nestjs/common';
import type { SqlExecutor } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ApiHttpError } from '../http-error.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { readDetail, requireReadable } from '../conversations/record.js';

export type NotificationKind = 'new_message' | 'assignment' | 'handoff' | 'campaign' | 'automation_failure';
export type NotificationTarget = 'conversation' | 'handoff' | 'campaign' | 'automation';
export interface Notification {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly targetType: NotificationTarget;
  readonly targetId: string;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly senderName: string | null;
  readonly messagePreview: string | null;
}
interface NotificationRow {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly target_type: NotificationTarget;
  readonly target_id: string;
  readonly created_at: Date;
  readonly read_at: Date | null;
  readonly dedupe_key: string;
}
interface PageCursor { readonly at: string; readonly id: string; }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badQuery(): ApiHttpError {
  return new ApiHttpError(400, 'invalid_query', 'Invalid notification query.');
}
function decodeCursor(value: string | undefined): PageCursor | null {
  if (value === undefined) return null;
  if (value.length > 512) throw badQuery();
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null) throw badQuery();
    const row = decoded as Record<string, unknown>;
    if (typeof row['at'] !== 'string' || !Number.isFinite(Date.parse(row['at'])) ||
        typeof row['id'] !== 'string' || !UUID.test(row['id'])) throw badQuery();
    return { at: row['at'], id: row['id'] };
  } catch {
    throw badQuery();
  }
}
function view(row: NotificationRow, senderName: string | null = null, messagePreview: string | null = null): Notification {
  return {
    id: row.id, kind: row.kind, targetType: row.target_type, targetId: row.target_id,
    createdAt: row.created_at.toISOString(), readAt: row.read_at?.toISOString() ?? null,
    senderName, messagePreview,
  };
}

@Injectable()
export class NotificationService {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  /** Caller-owned transaction: domain effect, record, and SSE signal commit together. */
  async create(sql: SqlExecutor, tenantId: string, input: {
    readonly recipientMembershipId: string;
    readonly kind: NotificationKind;
    readonly targetType: NotificationTarget;
    readonly targetId: string;
    readonly dedupeKey: string;
  }): Promise<void> {
    const inserted = await sql.query<{ id: string }>(
      `INSERT INTO notifications
         (tenant_id, recipient_membership_id, kind, target_type, target_id, dedupe_key)
       SELECT $1, m.id, $3, $4, $5, $6 FROM memberships m
        WHERE m.tenant_id=$1 AND m.id=$2 AND m.status='active'
       ON CONFLICT (tenant_id, recipient_membership_id, dedupe_key) DO NOTHING
       RETURNING id::text`,
      [tenantId, input.recipientMembershipId, input.kind, input.targetType, input.targetId, input.dedupeKey],
    );
    const notification = inserted.rows[0];
    if (notification !== undefined) {
      await sql.query(
        `INSERT INTO notification_push_queue (tenant_id, notification_id, device_id)
         SELECT $1, $2, d.id FROM notification_devices d
          WHERE d.tenant_id=$1 AND d.membership_id=$3
            AND d.platform='web_push' AND d.enabled=true`,
        [tenantId, notification.id, input.recipientMembershipId],
      );
      await this.realtime.emitNotification(sql, tenantId, input.recipientMembershipId, notification.id);
    }
  }

  async list(session: AuthenticatedSession, tenantId: string, cursorRaw: string | undefined, limitRaw: string | undefined) {
    const cursor = decodeCursor(cursorRaw);
    const limit = limitRaw === undefined ? 25 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw badQuery();
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const rows = await sql.query<NotificationRow>(
        `SELECT id::text, kind, target_type, target_id::text, created_at, read_at, dedupe_key
           FROM notifications
          WHERE recipient_membership_id=$1
            AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $4`,
        [principal.membershipId, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
      );
      const page = rows.rows.slice(0, limit);
      const last = page.at(-1);
      const nextCursor = rows.rows.length > limit && last !== undefined
        ? Buffer.from(JSON.stringify({ at: last.created_at.toISOString(), id: last.id })).toString('base64url')
        : null;
      // A notification is not a grant. Resolve its preview against the
      // caller's *current* conversation permission on every list request.
      // Push payloads remain generic and never contain this content.
      const items = await Promise.all(page.map(async (row) => {
        if (row.target_type !== 'conversation' && row.target_type !== 'handoff') return view(row);
        const detail = await readDetail(sql, row.target_id);
        if (detail === null) return view(row);
        try { requireReadable(principal, detail); }
        catch (error) {
          if (error instanceof ApiHttpError && error.getStatus() === 403) return view(row);
          throw error;
        }
        const eventId = row.kind === 'new_message' ? row.dedupe_key.match(/^inbound:([0-9a-f-]{36})$/i)?.[1] : undefined;
        const inbound = eventId === undefined ? null : await sql.query<{ text_body: string | null }>(
          `SELECT text_body FROM inbound_events
            WHERE id=$1 AND conversation_id=$2 AND kind='message'`, [eventId, row.target_id],
        );
        return view(row, detail.contactDisplayName ?? null, inbound?.rows[0]?.text_body?.slice(0, 180) ?? null);
      }));
      return { items, nextCursor };
    });
  }

  async unreadCount(session: AuthenticatedSession, tenantId: string): Promise<number> {
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const rows = await sql.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM notifications
          WHERE recipient_membership_id=$1 AND read_at IS NULL`,
        [principal.membershipId],
      );
      return Number(rows.rows[0]?.count ?? '0');
    });
  }

  async markRead(session: AuthenticatedSession, tenantId: string, id: string): Promise<void> {
    if (!UUID.test(id)) throw badQuery();
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const changed = await sql.query<{ id: string }>(
        `UPDATE notifications SET read_at=now()
          WHERE id=$1 AND recipient_membership_id=$2 AND read_at IS NULL
        RETURNING id::text`, [id, principal.membershipId],
      );
      if (changed.rows[0] !== undefined) {
        await this.realtime.emitNotification(sql, tenantId, principal.membershipId, id);
        return;
      }
      const existing = await sql.query<{ id: string }>(
        `SELECT id::text FROM notifications WHERE id=$1 AND recipient_membership_id=$2`,
        [id, principal.membershipId],
      );
      if (existing.rows[0] === undefined) {
        throw new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
      }
    });
  }

  async markAllRead(session: AuthenticatedSession, tenantId: string): Promise<number> {
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const changed = await sql.query<{ id: string }>(
        `UPDATE notifications SET read_at=now()
          WHERE recipient_membership_id=$1 AND read_at IS NULL RETURNING id::text`,
        [principal.membershipId],
      );
      if (changed.rows[0] !== undefined) {
        await this.realtime.emitNotification(sql, tenantId, principal.membershipId, changed.rows[0].id);
      }
      return changed.rows.length;
    });
  }
}
