import type { ApiResult, PagedData } from './client.js';
import type { ApiClient } from './client.js';

export type NotificationKind = 'new_message' | 'assignment' | 'handoff' | 'campaign' | 'automation_failure';
export interface Notification {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly targetType: 'conversation' | 'handoff' | 'campaign' | 'automation';
  readonly targetId: string;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly senderName?: string | null;
  readonly messagePreview?: string | null;
}

export class NotificationsApi {
  constructor(private readonly client: ApiClient) {}

  list(tenantId: string, cursor: string | null = null): Promise<ApiResult<PagedData<Notification>>> {
    const query = new URLSearchParams({ limit: '25' });
    if (cursor !== null) query.set('cursor', cursor);
    return this.client.page<Notification>(`/tenants/${tenantId}/notifications?${query}`);
  }

  unreadCount(tenantId: string): Promise<ApiResult<{ readonly count: number }>> {
    return this.client.get(`/tenants/${tenantId}/notifications/unread-count`);
  }

  markRead(tenantId: string, id: string): Promise<ApiResult<{ readonly read: boolean }>> {
    return this.client.post(`/tenants/${tenantId}/notifications/${id}/read`);
  }

  markAllRead(tenantId: string): Promise<ApiResult<{ readonly changed: number }>> {
    return this.client.post(`/tenants/${tenantId}/notifications/read-all`);
  }

  pushConfig(tenantId: string): Promise<ApiResult<{ readonly publicKey: string | null }>> {
    return this.client.get(`/tenants/${tenantId}/notifications/push-config`);
  }

  registerDevice(tenantId: string, deviceId: string, subscription: PushSubscriptionJSON): Promise<ApiResult<{ readonly registered: boolean }>> {
    return this.client.post(`/tenants/${tenantId}/notifications/devices/${deviceId}`, { body: { subscription } });
  }

  revokeDevice(tenantId: string, deviceId: string, signal?: AbortSignal): Promise<ApiResult<{ readonly revoked: boolean }>> {
    return this.client.post(`/tenants/${tenantId}/notifications/devices/${deviceId}/revoke`, { signal });
  }
}
