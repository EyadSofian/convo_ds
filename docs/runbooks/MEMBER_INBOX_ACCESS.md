# Restricting users to inboxes

In **Users → Invite User**, choose the role and **Inbox access**:

- **Selected inboxes only**: allow one or more individual channel connections (each WhatsApp number, Facebook Page or Instagram account is its own inbox).
- **All current and future inboxes**: grant the workspace scope. Available to managers who hold that scope.
- **No inbox access**: invite without conversation access for scoped/own roles.

For an existing user, open **Users → Actions → Manage inboxes → Save access**. Selected inboxes replace previous workspace and team scopes; team membership itself is not edited. Legacy team scopes can be retained explicitly. Unavailable existing inbox grants remain visible and can be removed explicitly. Self-editing is disabled in this menu to avoid accidental lockout.

Use Agent for assigned conversations and claimable unassigned cards inside the allowed inboxes. Use Supervisor for scoped oversight. Owner/Admin role permissions are workspace-wide and cannot be narrowed by a membership scope; choose an appropriate restricted role before selecting individual inboxes. Custom roles with a tenant-wide conversation read grant also cannot be represented as restricted access in this form.

The picker loads `GET /tenants/{tenantId}/people/inboxes`. It requires `member.manage`, returns no credentials, and lists only active inboxes the actor can delegate. Invitations carry the selected `scopes`; updates replace them through the existing membership PATCH. Both mutations retain server-side delegation checks. Existing conversation authorization, list filtering and reply checks enforce scope on each request; this feature does not widen Agent access to colleagues' assigned conversations.
