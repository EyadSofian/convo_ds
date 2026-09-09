import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnModuleDestroy,
} from '@nestjs/common';
import argon2 from 'argon2';
import type { Pool } from 'pg';
import type { ApiConfig } from './config.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthRateLimiter } from './auth/auth-rate-limiter.js';
import { AuthService } from './auth/auth.service.js';
import { LoggingRecoveryDelivery } from './auth/recovery-delivery.js';
import type { RecoveryDeliveryPort } from './auth/recovery-delivery.js';
import { RecoveryService } from './auth/recovery.service.js';
import { AuthorizationService } from './authorization/authorization.service.js';
import { unconfiguredBroker } from './broker/broker.port.js';
import type { BrokerPort } from './broker/broker.port.js';
import { BrokerRelayService } from './broker/relay.service.js';
import { ChannelController } from './channels/channel.controller.js';
import { ChannelService } from './channels/channel.service.js';
import { unconfiguredTransport } from './channels/channel-transport.js';
import type { ChannelTransportPort } from './channels/channel-transport.js';
import { ChannelCredentialService } from './channels/credential.service.js';
import { ChannelIngressController } from './channels/ingress.controller.js';
import { ChannelDispatcherService } from './channels/dispatcher.service.js';
import { ChannelIngressService } from './channels/ingress.service.js';
import { OutboundController } from './channels/outbound.controller.js';
import { OutboundService } from './channels/outbound.service.js';
import { SelfHostedIngressService } from './channels/self-hosted-ingress.service.js';
import { ChannelNormalizationService } from './channels/normalization.service.js';
import { ContactController } from './contacts/contact.controller.js';
import { ContactService } from './contacts/contact.service.js';
import { ConversationController } from './conversations/conversation.controller.js';
import { ConversationService } from './conversations/conversation.service.js';
import { RealtimeController } from './realtime/realtime.controller.js';
import { RealtimeService } from './realtime/realtime.service.js';
import { PermissionController } from './authorization/permission.controller.js';
import { PermissionService } from './authorization/permission.service.js';
import { IdempotencyService } from './idempotency/idempotency.service.js';
import { InstanceController } from './instance/instance.controller.js';
import { InstanceService } from './instance/instance.service.js';
import { MembershipController } from './memberships/membership.controller.js';
import { InvitationController } from './people/invitation.controller.js';
import { LoggingInvitationDelivery } from './people/invitation-delivery.js';
import type { InvitationDeliveryPort } from './people/invitation-delivery.js';
import { InvitationService } from './people/invitation.service.js';
import { PeopleController } from './people/people.controller.js';
import { PeopleService } from './people/people.service.js';
import { MembershipService } from './memberships/membership.service.js';
import {
  API_CONFIG,
  API_POOL,
  BROKER,
  CHANNEL_TRANSPORT,
  INVITATION_DELIVERY,
  PASSWORD_HASHER,
  RECOVERY_DELIVERY,
  type PasswordHasher,
} from './tokens.js';

@Injectable()
class PoolLifecycle implements OnModuleDestroy {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

const ARGON2ID_HASHER: PasswordHasher = {
  hash(plaintext) {
    return argon2.hash(plaintext, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
  },
  verify(hash, plaintext) {
    return argon2.verify(hash, plaintext);
  },
};

@Module({})
export class ApiModule {
  static register(
    config: ApiConfig,
    pool: Pool,
    adapters: {
      readonly recoveryDelivery?: RecoveryDeliveryPort | undefined;
      readonly invitationDelivery?: InvitationDeliveryPort | undefined;
      readonly channelTransport?: ChannelTransportPort | undefined;
      readonly broker?: BrokerPort | undefined;
    } = {},
  ): DynamicModule {
    return {
      module: ApiModule,
      controllers: [
        InstanceController,
        AuthController,
        MembershipController,
        PermissionController,
        InvitationController,
        PeopleController,
        ChannelController,
        ChannelIngressController,
        OutboundController,
        ConversationController,
        ContactController,
        RealtimeController,
      ],
      providers: [
        { provide: API_CONFIG, useValue: config },
        { provide: API_POOL, useValue: pool },
        { provide: PASSWORD_HASHER, useValue: ARGON2ID_HASHER },
        // No email provider is configured. The default adapter logs a redacted
        // line and never the token; it is not a working integration and the
        // ledger records it as an unconfigured port.
        {
          provide: RECOVERY_DELIVERY,
          useValue: adapters.recoveryDelivery ?? new LoggingRecoveryDelivery(),
        },
        {
          provide: INVITATION_DELIVERY,
          useValue: adapters.invitationDelivery ?? new LoggingInvitationDelivery(),
        },
        // No provider transport is configured, because no authorized Meta
        // assets exist. The default refuses every send and every connection
        // test with a typed reason rather than pretending to succeed.
        {
          provide: CHANNEL_TRANSPORT,
          useValue: adapters.channelTransport ?? unconfiguredTransport,
        },
        // No durable broker is configured. The default refuses every publish,
        // so the outbox grows visibly rather than a queue silently becoming an
        // array that loses everything on restart.
        { provide: BROKER, useValue: adapters.broker ?? unconfiguredBroker },
        IdempotencyService,
        InstanceService,
        AuthRateLimiter,
        AuthService,
        AuthorizationService,
        RecoveryService,
        InvitationService,
        PeopleService,
        ChannelCredentialService,
        ChannelService,
        ChannelIngressService,
        SelfHostedIngressService,
        BrokerRelayService,
        RealtimeService,
        ContactService,
        ConversationService,
        ChannelNormalizationService,
        ChannelDispatcherService,
        OutboundService,
        MembershipService,
        PermissionService,
        PoolLifecycle,
      ],
    };
  }
}
