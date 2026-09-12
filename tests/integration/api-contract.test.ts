import { readFileSync } from 'node:fs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApplication } from '../../apps/api/src/app.js';
import { parseApiConfig } from '../../apps/api/src/config.js';
import {
  registeredApiRoutes,
  type ApiRoute,
} from '../../apps/api/src/route-inventory.js';
import { NAMES } from '../support/cluster.js';
import { clusterCredentials, scratchRuntimePool } from '../support/scratch.js';

interface OpenApiOperation {
  readonly operationId?: string;
  readonly parameters?: readonly [{ readonly $ref?: string }];
  readonly responses?: Readonly<Record<string, unknown>>;
}

interface OpenApiDocument {
  readonly openapi: string;
  readonly servers: readonly [{ readonly url: string }];
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
  readonly components: {
    readonly schemas: Readonly<
      Record<
        string,
        {
          readonly additionalProperties?: boolean;
          readonly required?: readonly string[];
          readonly properties?: Readonly<Record<string, { readonly enum?: readonly string[] }>>;
        }
      >
    >;
  };
}

const HTTP_METHODS = new Set(['delete', 'get', 'patch', 'post', 'put']);
const SPEC = JSON.parse(
  readFileSync('docs/api/openapi.v1.json', 'utf8'),
) as OpenApiDocument;

function routesFromSpec(): ApiRoute[] {
  const prefix = SPEC.servers[0].url;
  const routes: ApiRoute[] = [];
  for (const [path, item] of Object.entries(SPEC.paths)) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method)) {
        routes.push({
          method: method.toUpperCase(),
          path: (prefix + path).replace(/\{([^}]+)\}/g, ':$1'),
        });
      }
    }
  }
  return routes.sort((left, right) =>
    (left.path + left.method).localeCompare(right.path + right.method),
  );
}

describe('pinned OpenAPI contract', () => {
  let app: NestFastifyApplication;
  let server: FastifyInstance;

  beforeAll(async () => {
    const cluster = clusterCredentials();
    const pool = scratchRuntimePool(NAMES);
    const config = parseApiConfig({
      CONVO_DEPLOYMENT_MODE: 'saas',
      CONVO_INSTALLATION_NAME: 'Contract Test',
      CONVO_PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
      CONVO_PROCESS_ROLE: 'api',
      CONVO_AUTH_HASH_SECRET: 'contract-auth-hash-secret-value-00001',
      CONVO_BOOTSTRAP_TOKEN: 'contract-bootstrap-token-value-00000001',
      CONVO_IDEMPOTENCY_HASH_SECRET: 'contract-idempotency-secret-value-0001',
      CONVO_API_PORT: '0',
      CONVO_PG_HOST: cluster.host,
      CONVO_PG_PORT: String(cluster.port),
      CONVO_PG_DATABASE: NAMES.database,
      CONVO_PG_RUNTIME_ROLE: NAMES.runtimeRole,
      CONVO_PG_RUNTIME_PASSWORD: NAMES.runtimePassword,
    });
    app = await createApiApplication(config, pool);
    server = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  });

  afterAll(async () => {
    await app.close();
  });

  it('matches registered HTTP routes against the spec in both directions', () => {
    expect(registeredApiRoutes(server)).toEqual(routesFromSpec());
  });

  it('pins v1 operation IDs, responses, examples, and closed response schemas', () => {
    expect(SPEC.openapi).toBe('3.1.0');
    expect(SPEC.servers[0].url).toBe('/api/v1');
    const operations = Object.values(SPEC.paths).flatMap((item) =>
      Object.entries(item)
        .filter(([method]) => HTTP_METHODS.has(method))
        .map(([, operation]) => operation),
    );
    expect(operations.map((operation) => operation.operationId)).toEqual([
      "login",
      "logout",
      "startPasswordRecovery",
      "completePasswordRecovery",
      "getCurrentSession",
      "listSessions",
      "getSession",
      "revokeSession",
      "getInstance",
      "bootstrapInstallation",
      "acceptInvitation",
      "listMyMemberships",
      "listChannelConnections",
      "connectChannel",
      "disconnectChannel",
      "rotateChannelCredential",
      "listOutboundMessages",
      "queueOutboundMessage",
      "testChannelConnection",
      "listChannelCatalogue",
      "listContacts",
      "getContact",
      "updateContact",
      "recordConsent",
      "listConversations",
      "listUnassignedConversations",
      "getConversation",
      "claimConversation",
      "transitionConversation",
      "listConversationEpisodes",
      "listConversationNotes",
      "createConversationNote",
      "markConversationRead",
      "updateNote",
      "deleteNote",
      "listConversationMessages",
      "replyToConversation",
      "listInvitations",
      "createInvitation",
      "revokeInvitation",
      "getOutboundMessage",
      "listOwnershipTransfers",
      "offerOwnership",
      "cancelOwnership",
      "acceptOwnership",
      "declineOwnership",
      "listPeople",
      "updateMembership",
      "listPermissions",
      "catchUpRealtimeEvents",
      "streamRealtimeEvents",
      "listRoles",
      "createRole",
      "updateRole",
      "deleteRole",
      "listTeams",
      "createTeam",
      "updateTeam",
      "addTeamMember",
      "removeTeamMember",
      "receiveCustomChannelDelivery",
      "verifyMetaWebhook",
      "receiveMetaWebhook",
      "receiveWebChatDelivery",
      "assignConversation",
      "listAssignableAgents",
      "listConversationHandoffs",
      "requestHandoff",
      "settleHandoff",
      "setConversationPriority",
      "listConversationCollaborators",
      "addConversationCollaborator",
      "removeConversationCollaborator",
      "listLabels",
      "createLabel",
      "updateLabel",
      "retireLabel",
      "listCustomFields",
      "createCustomField",
      "updateCustomField",
      "retireCustomField",
      "updateConversationMetadata",
      "updateContactMetadata",
      "listCampaigns",
      "createCampaign",
      "validateCampaign",
      "approveCampaign",
      "launchCampaign",
      "controlCampaign",
      "listCampaignRecipients",
      "cloneCampaign",
    ]);
    for (const operation of operations) {
      expect(Object.keys(operation.responses ?? {}).length).toBeGreaterThan(0);
    }
    expect(SPEC.components.schemas['InstanceDescriptor']?.additionalProperties).toBe(false);
    expect(SPEC.components.schemas['BootstrapResponse']?.required).toContain('request_id');
    expect(SPEC.components.schemas['CurrentSessionResponse']?.required).toContain('request_id');
    expect(SPEC.components.schemas['SessionListResponse']?.additionalProperties).toBe(false);
    expect(SPEC.components.schemas['MembershipListResponse']?.additionalProperties).toBe(false);
    expect(SPEC.components.schemas['PermissionListResponse']?.additionalProperties).toBe(false);
    expect(SPEC.components.schemas['RoleListResponse']?.additionalProperties).toBe(false);
    expect(SPEC.components.schemas['PersonListResponse']?.additionalProperties).toBe(false);
    expect(SPEC.components.schemas['TeamListResponse']?.additionalProperties).toBe(false);
    expect(SPEC.components.schemas['QueueCardListResponse']?.additionalProperties).toBe(false);
    // The queue card is a closed shape with exactly the eight permitted fields.
    // An open one would let a future payload field become a disclosure.
    expect(SPEC.components.schemas['QueueCard']?.additionalProperties).toBe(false);
    expect(SPEC.components.schemas['QueueCard']?.required).toEqual([
      'id',
      'inboxLabel',
      'channel',
      'maskedLabel',
      'priority',
      'status',
      'waitingSinceAt',
      'claimable',
      'version',
    ]);
    expect(SPEC.components.schemas['RealtimeEvent']?.required).toContain('schemaVersion');
    expect(SPEC.components.schemas['ContactListResponse']?.additionalProperties).toBe(false);
    expect(SPEC.components.schemas['Contact']?.additionalProperties).toBe(false);
    expect(SPEC.components.schemas['Label']?.additionalProperties).toBe(false);
    expect(SPEC.components.schemas['CustomField']?.additionalProperties).toBe(false);
    expect(SPEC.components.schemas['MetadataMutationResponse']?.additionalProperties).toBe(false);
    // An identity carries the scope it is meaningful in. Without `scopeId` a
    // page-scoped id would read as a global one, which is the mistake the whole
    // contact model exists to avoid.
    expect(SPEC.components.schemas['ContactIdentity']?.required).toContain('scopeId');
    expect(SPEC.components.schemas['ContactIdentity']?.required).toContain('validTo');
    expect(SPEC.components.schemas['ConsentRecord']?.properties?.['state']?.enum).toEqual([
      'granted',
      'withdrawn',
    ]);
    expect(SPEC.components.schemas['ConversationListResponse']?.additionalProperties).toBe(false);
    expect(SPEC.components.schemas['TimelineResponse']?.additionalProperties).toBe(false);
    // A timeline row is closed too: command state and delivery state are two
    // fields on the wire because they are two facts, and an open schema would
    // let a third appear without anybody deciding it should.
    expect(SPEC.components.schemas['TimelineMessage']?.additionalProperties).toBe(false);
    // A denial is the absence of a grant, never a grant that says `none`. The
    // wire contract has to say so too, or a client will render a "none" chip.
    expect(SPEC.components.schemas['RoleGrant']?.properties?.['scope_level']?.enum).toEqual([
      'tenant',
      'scoped',
      'own',
    ]);
    expect(SPEC.components.schemas['ErrorEnvelope']?.required).toContain('request_id');
    expect(SPEC.paths['/instance/bootstrap']?.['post']?.parameters).toContainEqual({
      $ref: '#/components/parameters/BootstrapToken',
    });
    expect(SPEC.paths['/instance/bootstrap']?.['post']?.responses).toHaveProperty('401');
    expect(readFileSync('docs/api/openapi.v1.json', 'utf8')).toContain('"example"');
  });
});
