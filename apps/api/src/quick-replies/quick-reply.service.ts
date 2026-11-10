import { Inject, Injectable } from '@nestjs/common';
import type { SqlExecutor } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ApiHttpError } from '../http-error.js';
import { unlessConstraint } from '../pg-error.js';
import { requireRow } from '../require-row.js';
import type { QuickReplyInput, QuickReplyKind, QuickReplyLocation } from './quick-reply-request.js';

export interface QuickReply {
  readonly id: string;
  readonly shortcut: string;
  readonly title: string;
  readonly kind: QuickReplyKind;
  readonly body: string;
  readonly location: QuickReplyLocation | null;
  readonly version: number;
  readonly updatedAt: string;
}

interface RawQuickReply {
  readonly id: string; readonly shortcut: string; readonly title: string; readonly kind: QuickReplyKind;
  readonly body: string; readonly location: QuickReplyLocation | null; readonly version: number; readonly updated_at: Date;
}

const COLUMNS = 'id::text,shortcut,title,kind,body,location,version,updated_at';

/**
 * The workspace's saved replies. Everyone who works conversations reads them;
 * only someone who manages the catalogue (labels, fields) changes them, so one
 * agent cannot rewrite what the whole team sends.
 */
@Injectable()
export class QuickReplyService {
  constructor(@Inject(AuthorizationService) private readonly authorization: AuthorizationService) {}

  list(session: AuthenticatedSession, tenantId: string): Promise<readonly QuickReply[]> {
    return this.authorization.authorized(session, tenantId, 'catalog.read', async ({ sql }) => {
      const rows = await sql.query<RawQuickReply>(`SELECT ${COLUMNS} FROM quick_replies ORDER BY shortcut,id`);
      return rows.rows.map(quickReplyOf);
    });
  }

  create(session: AuthenticatedSession, tenantId: string, input: QuickReplyInput): Promise<QuickReply> {
    return this.authorization.authorized(session, tenantId, 'catalog.manage', ({ sql, principal }) =>
      unlessConstraint('quick_replies_shortcut_uq', taken(), async () => {
        const rows = await sql.query<RawQuickReply>(
          `INSERT INTO quick_replies(tenant_id,shortcut,title,kind,body,location,created_by_membership_id,updated_by_membership_id)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$7) RETURNING ${COLUMNS}`,
          [tenantId, input.shortcut, input.title, input.kind, input.body, locationJson(input), principal.membershipId],
        );
        return quickReplyOf(requireRow(rows.rows, 'quick reply insert returned no row'));
      }),
    );
  }

  update(session: AuthenticatedSession, tenantId: string, id: string, version: number, input: QuickReplyInput): Promise<QuickReply> {
    this.authorization.assertTenantId(id);
    return this.authorization.authorized(session, tenantId, 'catalog.manage', ({ sql, principal }) =>
      unlessConstraint('quick_replies_shortcut_uq', taken(), async () => {
        const rows = await sql.query<RawQuickReply>(
          `UPDATE quick_replies SET shortcut=$3,title=$4,kind=$5,body=$6,location=$7::jsonb,updated_by_membership_id=$8,
                  version=version+1,updated_at=now()
            WHERE id=$1 AND version=$2 RETURNING ${COLUMNS}`,
          [id, version, input.shortcut, input.title, input.kind, input.body, locationJson(input), principal.membershipId],
        );
        const row = rows.rows[0];
        if (row === undefined) throw await missingOrStale(sql, id);
        return quickReplyOf(row);
      }),
    );
  }

  remove(session: AuthenticatedSession, tenantId: string, id: string, version: number): Promise<void> {
    this.authorization.assertTenantId(id);
    return this.authorization.authorized(session, tenantId, 'catalog.manage', async ({ sql }) => {
      const result = await sql.query('DELETE FROM quick_replies WHERE id=$1 AND version=$2', [id, version]);
      if (result.rowCount !== 1) throw await missingOrStale(sql, id);
    });
  }
}

/** A write that matched nothing either lost a race or names nothing at all. */
async function missingOrStale(sql: SqlExecutor, id: string): Promise<ApiHttpError> {
  const rows = await sql.query<{ found: boolean }>('SELECT true AS found FROM quick_replies WHERE id=$1', [id]);
  return rows.rows[0] === undefined
    ? new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.')
    : new ApiHttpError(409, 'quick_reply_version_conflict', 'Someone changed this quick reply. Reload and try again.');
}

function locationJson(input: QuickReplyInput): string | null {
  return input.location === null ? null : JSON.stringify(input.location);
}

function quickReplyOf(row: RawQuickReply): QuickReply {
  return {
    id: row.id, shortcut: row.shortcut, title: row.title, kind: row.kind, body: row.body,
    location: row.location, version: row.version, updatedAt: row.updated_at.toISOString(),
  };
}

function taken(): ApiHttpError {
  return new ApiHttpError(409, 'quick_reply_shortcut_taken', 'Another quick reply already uses this shortcut.');
}
