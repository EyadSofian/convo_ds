import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { canonicalJson, type JsonValue } from '../idempotency/canonical-json.js';
import { ApiHttpError } from '../http-error.js';
import type { AutomationEventInput } from './automation-request.js';
import { AutomationRunnerService } from './automation-runner.service.js';

@Injectable()
export class AutomationEventService {
 constructor(@Inject(AuthorizationService)private readonly authorization:AuthorizationService,@Inject(AutomationRunnerService)private readonly runner:AutomationRunnerService){}
 async ingest(session:AuthenticatedSession,tenantId:string,input:AutomationEventInput):Promise<{readonly eventId:string;readonly runs:number}>{return this.authorization.authorized(session,tenantId,'automation.create',async()=>{const payloadHash=createHash('sha256').update(canonicalJson(input.payload as JsonValue)).digest('hex');try{return await this.runner.enqueueEvent(tenantId,{...input,payloadHash});}catch(error){if(error instanceof Error&&error.message==='automation_idempotency_conflict')throw new ApiHttpError(409,'automation_idempotency_conflict','This idempotency key was already used for a different event.');throw error;}});}
}
