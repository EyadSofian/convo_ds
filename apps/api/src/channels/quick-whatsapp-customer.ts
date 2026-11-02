import { authorize } from '@convo/domain';
import type { Principal, SqlExecutor } from '@convo/domain';

export interface QuickWhatsAppCustomer {
  readonly state: 'mine' | 'other' | 'unassigned';
  readonly conversationId: string | null;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly customerName: string | null;
  readonly assigneeName: string | null;
}

/** Exact-number directory lookup. Never exposes messages or inaccessible inboxes. */
export async function findQuickWhatsAppCustomer(sql: SqlExecutor, principal: Principal, peerIdentity: string, preferredConnectionId: string): Promise<QuickWhatsAppCustomer | null> {
  const result = await sql.query<{
    id: string; connection_id: string; connection_name: string; team_id: string | null;
    assignee_membership_id: string | null; assignee_name: string | null; customer_name: string | null;
  }>(`SELECT c.id::text, c.connection_id::text, n.display_name AS connection_name,
             c.team_id::text, c.assignee_membership_id::text,
             COALESCE(NULLIF(m.display_name,''),u.email::text) AS assignee_name,
             contact.display_name AS customer_name
      FROM conversations c
      JOIN channel_connections n ON n.id=c.connection_id AND n.kind='whatsapp' AND n.disconnected_at IS NULL
      LEFT JOIN memberships m ON m.id=c.assignee_membership_id
      LEFT JOIN users u ON u.id=m.user_id
      LEFT JOIN contacts contact ON contact.id=c.contact_id AND contact.deleted_at IS NULL
      WHERE c.peer_identity=$1 AND c.deleted_at IS NULL AND c.status <> 'archived'
      ORDER BY c.last_activity_at DESC, c.id`, [peerIdentity]);
  const available = result.rows.filter((row) => authorize(principal, 'conversation.reply', {
    inboxId: row.connection_id, assigneeMembershipId: principal.membershipId,
  }).allowed);
  const row = available.find((entry) => entry.connection_id === preferredConnectionId && entry.assignee_membership_id !== null)
    ?? available.find((entry) => entry.assignee_membership_id !== null)
    ?? available.find((entry) => entry.connection_id === preferredConnectionId)
    ?? available[0];
  if (row === undefined) return null;
  const state = row.assignee_membership_id === null ? 'unassigned' : row.assignee_membership_id === principal.membershipId ? 'mine' : 'other';
  const canOpen = state === 'mine' && authorize(principal, 'conversation.read', {
    inboxId: row.connection_id, assigneeMembershipId: row.assignee_membership_id!,
    ...(row.team_id === null ? {} : { teamId: row.team_id }),
  }).allowed;
  return { state, conversationId: canOpen ? row.id : null, connectionId: row.connection_id,
    connectionName: row.connection_name, customerName: row.customer_name, assigneeName: row.assignee_name };
}
