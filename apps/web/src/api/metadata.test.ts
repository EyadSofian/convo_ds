import { describe, expect, it } from 'vitest';
import { ApiClient } from './client.js';
import { MetadataApi, type QuickReplyInput } from './metadata.js';

/** The quick reply calls name the right route, method and body. */
describe('quick reply requests', () => {
  it('lists, creates, updates with a version, and deletes with a version', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const client = new ApiClient({
      baseUrl: '/api/v1',
      readCsrfToken: () => 'csrf',
      fetch: async (url, init) => {
        calls.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) as unknown : null });
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const api = new MetadataApi(client);
    const input: QuickReplyInput = { shortcut: 'hi', title: 'Hi', kind: 'text', body: 'Hello', location: null };
    await api.quickReplies('t');
    await api.createQuickReply('t', input);
    await api.updateQuickReply('t', 'q', 4, input);
    await api.deleteQuickReply('t', 'q', 5);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/v1/tenants/t/quick-replies',
      'POST /api/v1/tenants/t/quick-replies',
      'PATCH /api/v1/tenants/t/quick-replies/q',
      'DELETE /api/v1/tenants/t/quick-replies/q',
    ]);
    expect(calls.map((call) => call.body)).toEqual([null, input, { ...input, version: 4 }, { version: 5 }]);
  });
});
