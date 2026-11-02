# Quick WhatsApp number entry and assignment lookup

The Inbox header's **New WhatsApp message** defaults to Egypt (+20). Agents can enter a local number, paste its international form, or choose another country. Arabic and Persian digits are normalized. Invalid or incomplete phone numbers are rejected before lookup or sending.

After typing pauses, the dialog checks the normalized number against live conversations in the agent's available WhatsApp inboxes. The same exact-number lookup accompanies a phone-number search in Inbox.

- **Assigned to a colleague:** show only the customer name, sending inbox and follow-up owner's name. No message content or colleague conversation ID is returned. Sending and claiming remain blocked.
- **Assigned to the current agent:** offer **Open conversation**, using the existing thread without queueing a new template.
- **Unassigned:** use the existing conversation. If it is on another available line, the agent must select that line before sending.
- **No match:** choose an approved template and complete its parameters. No manual consent-reference field is required. Existing opt-outs remain enforced.

`POST /api/v1/tenants/:tenantId/channels/:connectionId/quick-whatsapp-lookup` requires an authenticated session, CSRF and reply permission in the selected inbox. It is an exact-number, metadata-only operation; it does not grant conversation read, assign or send permissions.

Quick sends recheck the number inside the transaction and serialize concurrent quick starts per workspace and recipient. The selected thread is locked and its current assignment revalidated before queueing. Existing message idempotency remains in effect. Tests use a stub transport and do not send messages to real customers.
