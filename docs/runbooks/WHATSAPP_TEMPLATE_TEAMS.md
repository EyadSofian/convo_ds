# WhatsApp template library and team availability

Open **Channels → Template library & teams**. This screen requires `channel.manage`.

1. Search by template name, message text, language, category or sending-line label. Filters combine with the search. Arabic text is normalized by the shared search helper.
2. Click a template name to load its current access configuration, or select multiple cards. **Select results** selects the current filtered result set; selections outside the filter remain visibly counted. Bulk saves support up to 200 templates.
3. Choose **Everyone** or **Selected teams**. A restricted template must have at least one active team. A template may be assigned to several teams.
4. Save. The operation replaces availability for exactly the selected templates atomically and rejects stale access versions. A refusal preserves the draft so the operator can review or reload it.

Existing and newly synchronized templates default to Everyone. Synchronizing the same provider template preserves its team mappings and access version. A paused, rejected or disabled template remains unavailable for sending regardless of its team configuration.

Tenant-wide channel administrators retain access to every template. Other members may discover and submit an all-access template or a template assigned to an active team they currently belong to. This policy supplements the existing inbox, ownership and sending permissions; it does not grant access to a new inbox or a colleague's conversation.

The server filters the quick-message, conversation and shared broadcast/automation catalogues. It checks template access again for individual sends, campaign draft edits, validation, test sends, launch, and automation creation, editing and activation. Legacy name-based campaigns resolve matching catalogue records before applying the same team rule. Existing accepted work and audit/history records are preserved.

Management APIs:

- `GET /api/v1/tenants/:tenantId/template-library`
- `PATCH /api/v1/tenants/:tenantId/template-library/access`, with CSRF, `{templates:[{id,version}],visibility:"all"|"teams",teamIds:[]}`

Bulk edits write append-only `template_access.updated` audit events in the same transaction. The mapping table has forced tenant RLS and composite tenant foreign keys to templates and teams. No Meta credentials are returned by the library.
