import { Inject, Injectable } from '@nestjs/common';
import type { Principal, SqlExecutor } from '@convo/domain';
import { authorize } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ApiHttpError } from '../http-error.js';
import { requireRow } from '../require-row.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { denied, notFound, readDetail, recordParticipation, resourceOf } from './record.js';
import type { ConversationDetail } from './record.js';

/**
 * Private notes, and the read cursor.
 *
 * They share a file because they share the one property that matters: **neither
 * touches the customer.** A note is never sent, never enters the outbound path,
 * has no provider, no delivery state and no window — and reading a conversation
 * marks *this person's* cursor, not a receipt the customer is told about.
 *
 * §18.1 is explicit about both, and both are the kind of rule that is broken by
 * convenience rather than by intent:
 *
 * - "Authoring a private note does not mark a customer reply as delivered or
 *   reset the channel window." It cannot here, because a note has nowhere to
 *   record either.
 * - "Reading a conversation updates only that user's cursor; delivery/read
 *   receipts from the customer are separate." They are separate tables, and
 *   nothing joins them.
 */

export interface NoteRow {
  readonly id: string;
  readonly conversationId: string;
  readonly authorMembershipId: string | null;
  readonly body: string;
  readonly createdAt: Date;
  readonly editedAt: Date | null;
  readonly deletedAt: Date | null;
}

interface RawNote {
  readonly id: string;
  readonly conversation_id: string;
  readonly author_membership_id: string | null;
  readonly body: string;
  readonly created_at: Date;
  readonly edited_at: Date | null;
  readonly deleted_at: Date | null;
}

/** What a deleted note says in place of its text. */
const REDACTED = '';

@Injectable()
export class NoteService {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  /**
   * Writes a note against a conversation.
   *
   * Writing one is taking part, so the author becomes a participant — which is
   * what keeps their `own`-scoped read grant working after somebody else is
   * assigned the thread.
   *
   * The conversation's state is untouched. §18.1's last rows are explicit that a
   * private note never reopens anything, and the way to guarantee that is for
   * this method to have no code that could.
   */
  async add(
    session: AuthenticatedSession,
    tenantId: string,
    conversationId: string,
    body: string,
  ): Promise<NoteRow> {
    this.authorization.assertTenantId(conversationId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const detail = await requireConversation(sql, conversationId);
      requireGrant(principal, 'conversation.note', detail);

      const inserted = await sql.query<RawNote>(
        `INSERT INTO conversation_notes (tenant_id, conversation_id, author_membership_id, body)
         VALUES ($1, $2, $3, $4)
         RETURNING id::text, conversation_id::text, author_membership_id::text, body,
                   created_at, edited_at, deleted_at`,
        [tenantId, conversationId, principal.membershipId, body],
      );
      const note = rowOf(requireRow(inserted.rows, 'the note was not written'));
      await recordParticipation(sql, tenantId, conversationId, principal.membershipId);
      await this.announce(sql, tenantId, detail, note, 'created');
      return note;
    });
  }

  /** The notes on a conversation, oldest first. */
  async list(
    session: AuthenticatedSession,
    tenantId: string,
    conversationId: string,
  ): Promise<readonly NoteRow[]> {
    this.authorization.assertTenantId(conversationId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const detail = await requireConversation(sql, conversationId);
      // Reading notes needs the note grant, not merely the read grant: an
      // analyst who may read conversations for reporting has no business
      // reading what colleagues said to each other about a customer.
      requireGrant(principal, 'conversation.note', detail);
      const rows = await sql.query<RawNote>(
        `SELECT id::text, conversation_id::text, author_membership_id::text, body,
                created_at, edited_at, deleted_at
           FROM conversation_notes
          WHERE conversation_id = $1
          ORDER BY created_at, id`,
        [conversationId],
      );
      return rows.rows.map(rowOf).map(redactDeleted);
    });
  }

  /**
   * Edits a note, leaving a marker.
   *
   * Only the author. Not because nobody else could be trusted, but because a
   * note is attributed speech: an edit by somebody else would leave a sentence
   * standing under a name that did not write it. Moderating an inappropriate
   * note is a different act with a different audit trail, and it is not built.
   */
  async edit(
    session: AuthenticatedSession,
    tenantId: string,
    noteId: string,
    body: string,
  ): Promise<NoteRow> {
    return this.mutate(session, tenantId, noteId, async (sql, detail) => {
      const updated = await sql.query<RawNote>(
        `UPDATE conversation_notes
            SET body = $2, edited_at = now()
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING id::text, conversation_id::text, author_membership_id::text, body,
                    created_at, edited_at, deleted_at`,
        [noteId, body],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new ApiHttpError(
          409,
          'note_already_deleted',
          'This note was deleted. Write a new one instead.',
        );
      }
      const note = rowOf(row);
      await this.announce(sql, tenantId, detail, note, 'edited');
      return note;
    });
  }

  /**
   * Deletes a note by marking it, not by removing it.
   *
   * The row stays. A note that vanished without trace is a note somebody can
   * deny having written, and the colleague who acted on it has no way to show
   * what they read.
   */
  async remove(session: AuthenticatedSession, tenantId: string, noteId: string): Promise<NoteRow> {
    return this.mutate(session, tenantId, noteId, async (sql, detail) => {
      const updated = await sql.query<RawNote>(
        `UPDATE conversation_notes
            SET deleted_at = coalesce(deleted_at, now())
          WHERE id = $1
          RETURNING id::text, conversation_id::text, author_membership_id::text, body,
                    created_at, edited_at, deleted_at`,
        [noteId],
      );
      const note = redactDeleted(rowOf(requireRow(updated.rows, 'the note vanished mid-delete')));
      await this.announce(sql, tenantId, detail, note, 'deleted');
      return note;
    });
  }

  /**
   * Moves this person's read cursor.
   *
   * `greatest` rather than a plain assignment: opening an old conversation must
   * not un-read the newer part of it, which is what a cursor that moves
   * backwards would do.
   */
  async markRead(
    session: AuthenticatedSession,
    tenantId: string,
    conversationId: string,
    through: Date,
  ): Promise<{ readonly readThrough: Date }> {
    this.authorization.assertTenantId(conversationId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const detail = await requireConversation(sql, conversationId);
      requireGrant(principal, 'conversation.read', detail);
      const rows = await sql.query<{ read_through: Date }>(
        `INSERT INTO conversation_reads (tenant_id, conversation_id, membership_id, read_through)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, conversation_id, membership_id)
         DO UPDATE SET read_through = greatest(conversation_reads.read_through, EXCLUDED.read_through),
                       updated_at = now()
         RETURNING read_through`,
        [tenantId, conversationId, principal.membershipId, through],
      );
      const row = requireRow(rows.rows, 'the read cursor was not recorded');
      // Deliberately no realtime event and no receipt: this is one person's
      // bookkeeping, and telling the customer about it would be a lie.
      return { readThrough: row.read_through };
    });
  }

  /** Mark unread for this membership only; it is not a customer receipt. */
  async markUnread(session: AuthenticatedSession, tenantId: string, conversationId: string): Promise<{ readonly unread: true }> {
    this.authorization.assertTenantId(conversationId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const detail = await requireConversation(sql, conversationId);
      requireGrant(principal, 'conversation.read', detail);
      await sql.query(
        'DELETE FROM conversation_reads WHERE conversation_id=$1 AND membership_id=$2',
        [conversationId, principal.membershipId],
      );
      return { unread: true };
    });
  }

  /* ----------------------------------------------------------- internals -- */

  private async mutate(
    session: AuthenticatedSession,
    tenantId: string,
    noteId: string,
    work: (sql: SqlExecutor, detail: ConversationDetail) => Promise<NoteRow>,
  ): Promise<NoteRow> {
    this.authorization.assertTenantId(noteId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const existing = await sql.query<{ conversation_id: string; author_membership_id: string | null }>(
        `SELECT conversation_id::text, author_membership_id::text
           FROM conversation_notes WHERE id = $1`,
        [noteId],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        throw notFound();
      }
      const detail = await requireConversation(sql, row.conversation_id);
      requireGrant(principal, 'conversation.note', detail);
      if (row.author_membership_id !== principal.membershipId) {
        // A 403 rather than a 404: the caller may read this note, so pretending
        // it does not exist would be a worse answer than the true one.
        throw new ApiHttpError(
          403,
          'not_the_author',
          'Only the person who wrote a note can change it.',
        );
      }
      return work(sql, detail);
    });
  }

  private async announce(
    sql: SqlExecutor,
    tenantId: string,
    detail: ConversationDetail,
    note: NoteRow,
    action: 'created' | 'edited' | 'deleted',
  ): Promise<void> {
    await this.realtime.emit(sql, tenantId, {
      type: 'conversation.note',
      entityType: 'note',
      entityId: note.id,
      // A note has no version of its own; its edit time is what orders it.
      entityVersion: 1,
      conversationId: detail.id,
      connectionId: detail.connectionId,
      teamId: detail.teamId,
      assigneeMembershipId: detail.assigneeMembershipId,
      occurredAt: note.editedAt ?? note.createdAt,
      payload: {
        noteId: note.id,
        action,
        authorMembershipId: note.authorMembershipId,
        // The body travels on its own event type precisely so a subscriber who
        // may see receipts and not notes can be filtered without reading it.
        body: note.body,
        deleted: note.deletedAt !== null,
      },
    });
  }
}

async function requireConversation(
  sql: SqlExecutor,
  conversationId: string,
): Promise<ConversationDetail> {
  const detail = await readDetail(sql, conversationId);
  if (detail === null) {
    throw notFound();
  }
  return detail;
}

function requireGrant(
  principal: Principal,
  key: 'conversation.note' | 'conversation.read',
  detail: ConversationDetail,
): void {
  const decision = authorize(principal, key, resourceOf(detail));
  if (!decision.allowed) {
    throw denied();
  }
}

/** A deleted note keeps its row and its attribution; it loses only its text. */
function redactDeleted(note: NoteRow): NoteRow {
  return note.deletedAt === null ? note : { ...note, body: REDACTED };
}

function rowOf(row: RawNote): NoteRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    authorMembershipId: row.author_membership_id,
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
  };
}
