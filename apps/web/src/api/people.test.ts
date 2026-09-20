import { describe, expect, it } from 'vitest';
import { ApiClient, type FetchLike } from './client.js';
import { PeopleApi } from './people.js';

describe('PeopleApi public credential flows', () => {
  it('maps recovery, password change, and invitation operations without leaking tokens into URLs', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const fetch: FetchLike = (path, init) => {
      calls.push({ path, init });
      return Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } }));
    };
    const api = new PeopleApi(new ApiClient({ baseUrl: '/api/v1', fetch, readCsrfToken: () => 'csrf' }));
    await api.requestRecovery('person@example.test');
    await api.completeRecovery('reset token', 'new password');
    await api.changePassword('current password', 'new password value', 'new password value');
    await api.acceptInvitation('invite/token', 'new password');
    expect(calls.map((call) => [call.init.method, call.path])).toEqual([
      ['POST', '/api/v1/auth/recovery'],
      ['POST', '/api/v1/auth/recovery/complete'],
      ['POST', '/api/v1/auth/password/change'],
      ['POST', '/api/v1/invitations/invite%2Ftoken/accept'],
    ]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ email: 'person@example.test' });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ token: 'reset token', password: 'new password' });
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({
      currentPassword: 'current password', newPassword: 'new password value', confirmPassword: 'new password value',
    });
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({ password: 'new password' });
  });
});
