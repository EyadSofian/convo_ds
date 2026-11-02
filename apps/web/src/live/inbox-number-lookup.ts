import type { LiveContext } from './actions.js';
import { quickWhatsAppNumber } from './quick-whatsapp-phone.js';
import { failed, forTenant, LOADING, ready } from './store.js';

/** Exact-number discovery adds assignment metadata, never a colleague's thread. */
export async function lookupInboxNumber(context: LiveContext, search: string): Promise<void> {
  const peerIdentity = quickWhatsAppNumber(search);
  context.live.inboxNumberLookup = null;
  if (peerIdentity === null || context.live.supervisorAgentId !== null) return;
  await forTenant(context, undefined, async (tenantId) => {
    const pending = { key: search, result: LOADING };
    context.live.inboxNumberLookup = pending;
    context.refresh();
    const options = await context.live.channels.quickWhatsAppOptions(tenantId);
    if (context.live.inboxNumberLookup !== pending) return;
    if (!options.ok) {
      context.live.inboxNumberLookup = { key: search, result: failed(options.error) };
    } else {
      const connection = options.data.connections[0];
      if (connection === undefined) { context.live.inboxNumberLookup = null; context.refresh(); return; }
      const result = await context.live.channels.lookupQuickWhatsApp(tenantId, connection.id, peerIdentity);
      if (context.live.inboxNumberLookup !== pending) return;
      context.live.inboxNumberLookup = { key: search, result: result.ok ? ready(result.data, context.now()) : failed(result.error) };
    }
    context.refresh();
  });
}
