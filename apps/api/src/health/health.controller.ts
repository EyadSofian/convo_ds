import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { HealthService } from './health.service.js';

/**
 * The two probe routes, outside the versioned API.
 *
 * They live at `/live` and `/ready` rather than under `/api/v1` because they are
 * addressed by the platform, not by a client: a health check that moves when the
 * API version moves is a health check that silently starts returning 404 on the
 * next major, and a 404 is indistinguishable from "unhealthy" to most probes.
 *
 * Neither route authenticates. That is deliberate and safe as long as neither
 * says anything an attacker could use: the answers below are a status word, the
 * process role, and per-check booleans with typed codes. No version, no host, no
 * dependency address, no driver message.
 */
@Controller()
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /**
   * Alive. Touches nothing.
   *
   * If this ever consults a dependency, a dependency blip becomes a restart
   * storm across every instance at once.
   */
  @Get('live')
  live(@Res() reply: FastifyReply): void {
    void reply
      .status(200)
      .header('cache-control', 'no-store')
      .send({ status: 'alive' });
  }

  /**
   * Ready for traffic.
   *
   * `503` rather than a 200 carrying `ready: false`, because a probe reads the
   * status line and most never look at the body.
   */
  @Get('ready')
  async ready(@Res() reply: FastifyReply): Promise<void> {
    const report = await this.health.readiness();
    await reply
      .status(report.ready ? 200 : 503)
      .header('cache-control', 'no-store')
      .send({
        status: report.ready ? 'ready' : 'not_ready',
        role: report.role,
        checks: report.checks,
      });
  }
}
