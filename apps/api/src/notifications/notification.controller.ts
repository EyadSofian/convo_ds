import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { ApiHttpError } from '../http-error.js';
import { pageEnvelope } from '../pagination.js';
import { NotificationService } from './notification.service.js';
import { NotificationDeviceService } from './device.service.js';

@Controller('tenants/:tenantId/notifications')
export class NotificationController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(NotificationDeviceService) private readonly devices: NotificationDeviceService,
  ) {}

  @Get()
  async list(@Param('tenantId') tenantId: string, @Query() query: Record<string, unknown>, @Req() request: FastifyRequest) {
    if (Object.keys(query).some((key) => key !== 'cursor' && key !== 'limit') ||
        (query['cursor'] !== undefined && typeof query['cursor'] !== 'string') ||
        (query['limit'] !== undefined && typeof query['limit'] !== 'string')) {
      throw new ApiHttpError(400, 'invalid_query', 'Invalid notification query.');
    }
    const session = await this.auth.authenticate(request.headers.cookie);
    const page = await this.notifications.list(session, tenantId, query['cursor'] as string | undefined,
      query['limit'] as string | undefined);
    return pageEnvelope(page.items, page.nextCursor, request.id);
  }

  @Get('unread-count')
  async unreadCount(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return { data: { count: await this.notifications.unreadCount(session, tenantId) }, request_id: request.id };
  }

  @Get('push-config')
  async pushConfig(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    // The ordinary member check is required even though the key itself is public.
    await this.notifications.unreadCount(session, tenantId);
    return { data: { publicKey: this.devices.publicKey() }, request_id: request.id };
  }

  @Get('devices')
  async devicesList(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return { data: await this.devices.list(session, tenantId), request_id: request.id };
  }

  @Post('devices/:deviceId')
  @HttpCode(200)
  async registerDevice(@Param('tenantId') tenantId: string, @Param('deviceId') deviceId: string,
    @Body() body: unknown, @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrf);
    const subscription = typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)['subscription'] : undefined;
    await this.devices.register(session, tenantId, deviceId, subscription);
    return { data: { registered: true }, request_id: request.id };
  }

  @Post('devices/:deviceId/revoke')
  @HttpCode(200)
  async revokeDevice(@Param('tenantId') tenantId: string, @Param('deviceId') deviceId: string,
    @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrf);
    await this.devices.revoke(session, tenantId, deviceId);
    return { data: { revoked: true }, request_id: request.id };
  }

  @Post(':notificationId/read')
  @HttpCode(200)
  async markRead(@Param('tenantId') tenantId: string, @Param('notificationId') notificationId: string,
    @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrf);
    await this.notifications.markRead(session, tenantId, notificationId);
    return { data: { read: true }, request_id: request.id };
  }

  @Post('read-all')
  @HttpCode(200)
  async markAllRead(@Param('tenantId') tenantId: string,
    @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrf);
    return { data: { changed: await this.notifications.markAllRead(session, tenantId) }, request_id: request.id };
  }
}
