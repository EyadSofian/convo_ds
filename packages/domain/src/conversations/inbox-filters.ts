/**
 * Closed vocabulary for conversation queries.
 *
 * It is deliberately data-only: the API compiler maps these keys to fixed SQL
 * fragments and the web app renders this catalogue. Neither side accepts a
 * browser-supplied column name or arbitrary expression.
 */
export const INBOX_FILTER_KEYS = [
  'status', 'assignment_state', 'assigned_agent_id', 'team_id', 'channel',
  'connection_id', 'label_id', 'priority', 'unread', 'unreplied', 'created_at',
  'last_activity_at', 'waiting_since', 'customer_name', 'customer_phone',
  'collaborator_id', 'participant_id', 'handoff_target_id', 'campaign_id', 'custom_field',
] as const;

export type InboxFilterKey = (typeof INBOX_FILTER_KEYS)[number];
export type InboxFilterGroup = 'assignment' | 'conversation' | 'customer' | 'channel' | 'labels' | 'dates' | 'collaboration' | 'custom_fields';
export type InboxFilterValueType = 'enum' | 'membership_id' | 'team_id' | 'connection_id' | 'label_id' | 'campaign_id' | 'boolean' | 'date' | 'text' | 'custom_field';

export interface InboxFilterDefinition {
  readonly key: InboxFilterKey;
  readonly group: InboxFilterGroup;
  readonly valueType: InboxFilterValueType;
  readonly operators: readonly string[];
  /** The API compiler's fixed implementation name, never client-provided SQL. */
  readonly compiler: string;
  readonly inbox: true;
  readonly savedView: boolean;
  readonly report: boolean;
}

export const INBOX_FILTER_CATALOGUE: readonly InboxFilterDefinition[] = [
  { key: 'status', group: 'conversation', valueType: 'enum', operators: ['eq', 'in'], compiler: 'conversation_status', inbox: true, savedView: true, report: true },
  { key: 'assignment_state', group: 'assignment', valueType: 'enum', operators: ['eq'], compiler: 'assignment_state', inbox: true, savedView: true, report: true },
  { key: 'assigned_agent_id', group: 'assignment', valueType: 'membership_id', operators: ['eq', 'in', 'not_in'], compiler: 'assignee', inbox: true, savedView: true, report: true },
  { key: 'team_id', group: 'assignment', valueType: 'team_id', operators: ['eq', 'in'], compiler: 'team', inbox: true, savedView: true, report: true },
  { key: 'channel', group: 'channel', valueType: 'enum', operators: ['eq', 'in'], compiler: 'channel_kind', inbox: true, savedView: true, report: true },
  { key: 'connection_id', group: 'channel', valueType: 'connection_id', operators: ['eq', 'in'], compiler: 'connection', inbox: true, savedView: true, report: true },
  { key: 'label_id', group: 'labels', valueType: 'label_id', operators: ['eq', 'in', 'not_in'], compiler: 'conversation_label', inbox: true, savedView: true, report: true },
  { key: 'priority', group: 'conversation', valueType: 'enum', operators: ['eq', 'in'], compiler: 'priority', inbox: true, savedView: true, report: true },
  { key: 'unread', group: 'conversation', valueType: 'boolean', operators: ['eq'], compiler: 'read_cursor', inbox: true, savedView: true, report: false },
  { key: 'unreplied', group: 'conversation', valueType: 'boolean', operators: ['eq'], compiler: 'human_response', inbox: true, savedView: true, report: false },
  { key: 'created_at', group: 'dates', valueType: 'date', operators: ['before', 'after'], compiler: 'created_at', inbox: true, savedView: true, report: true },
  { key: 'last_activity_at', group: 'dates', valueType: 'date', operators: ['before', 'after'], compiler: 'last_activity_at', inbox: true, savedView: true, report: true },
  { key: 'waiting_since', group: 'dates', valueType: 'date', operators: ['before', 'after', 'is_set'], compiler: 'waiting_since', inbox: true, savedView: true, report: false },
  { key: 'customer_name', group: 'customer', valueType: 'text', operators: ['contains', 'eq'], compiler: 'contact_name', inbox: true, savedView: true, report: false },
  { key: 'customer_phone', group: 'customer', valueType: 'text', operators: ['contains', 'eq'], compiler: 'contact_phone', inbox: true, savedView: true, report: false },
  { key: 'collaborator_id', group: 'collaboration', valueType: 'membership_id', operators: ['eq', 'in'], compiler: 'collaborator', inbox: true, savedView: false, report: false },
  { key: 'participant_id', group: 'collaboration', valueType: 'membership_id', operators: ['eq', 'in'], compiler: 'participant', inbox: true, savedView: false, report: false },
  { key: 'handoff_target_id', group: 'collaboration', valueType: 'membership_id', operators: ['eq', 'in'], compiler: 'handoff_target', inbox: true, savedView: false, report: false },
  { key: 'campaign_id', group: 'conversation', valueType: 'campaign_id', operators: ['eq', 'in'], compiler: 'campaign_attribution', inbox: true, savedView: true, report: true },
  { key: 'custom_field', group: 'custom_fields', valueType: 'custom_field', operators: ['eq', 'neq', 'contains', 'is_set', 'is_not_set'], compiler: 'typed_custom_field', inbox: true, savedView: true, report: false },
];

export function inboxFilterDefinition(key: string): InboxFilterDefinition | null {
  return INBOX_FILTER_CATALOGUE.find((definition) => definition.key === key) ?? null;
}
