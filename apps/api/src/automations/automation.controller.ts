import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { pageEnvelope } from '../pagination.js';
import { ApiHttpError } from '../http-error.js';
import { parseAutomation, parseAutomationEvent, parseAutomationListQuery, parseAutomationRunsQuery, parseVersion, parseVersioned } from './automation-request.js';
import { AutomationService } from './automation.service.js';
import { AutomationEventService } from './automation-event.service.js';
@Controller()
export class AutomationController {
 constructor(@Inject(AuthService)private readonly auth:AuthService,@Inject(AutomationService)private readonly service:AutomationService,@Inject(AutomationEventService)private readonly events:AutomationEventService){}
 @Get('tenants/:tenantId/automation-templates') async templates(@Param('tenantId')tenantId:string,@Req()request:FastifyRequest){return pageEnvelope(await this.service.templates(await this.auth.authenticate(request.headers.cookie),tenantId),null,request.id);}
 @Get('tenants/:tenantId/whatsapp-templates') async whatsappTemplates(@Param('tenantId')tenantId:string,@Req()request:FastifyRequest){return pageEnvelope(await this.service.whatsappTemplates(await this.auth.authenticate(request.headers.cookie),tenantId),null,request.id);}
 @Get('tenants/:tenantId/automations') async list(@Param('tenantId')tenantId:string,@Query()query:Record<string,string|undefined>,@Req()request:FastifyRequest){const page=await this.service.list(await this.auth.authenticate(request.headers.cookie),tenantId,parseAutomationListQuery(query));return pageEnvelope(page.items,page.nextCursor,request.id);}
 @Get('tenants/:tenantId/automation-runs') async runs(@Param('tenantId')tenantId:string,@Query()query:Record<string,string|undefined>,@Req()request:FastifyRequest){const page=await this.service.runs(await this.auth.authenticate(request.headers.cookie),tenantId,parseAutomationRunsQuery(query));return pageEnvelope(page.items,page.nextCursor,request.id);}
 @Post('tenants/:tenantId/automations') async create(@Param('tenantId')tenantId:string,@Body()body:unknown,@Headers('x-csrf-token')csrf:string|string[]|undefined,@Req()request:FastifyRequest){const s=await this.mutating(request,csrf);return{data:await this.service.create(s,tenantId,parseAutomation(body)),request_id:request.id};}
 @Post('tenants/:tenantId/automation-events') async event(@Param('tenantId')tenantId:string,@Body()body:unknown,@Headers('x-csrf-token')csrf:string|string[]|undefined,@Req()request:FastifyRequest){const s=await this.mutating(request,csrf);return{data:await this.events.ingest(s,tenantId,parseAutomationEvent(body)),request_id:request.id};}
 @Post('tenants/:tenantId/automation-templates/:key/use') async use(@Param('tenantId')tenantId:string,@Param('key')key:string,@Body()body:unknown,@Headers('x-csrf-token')csrf:string|string[]|undefined,@Req()request:FastifyRequest){const s=await this.mutating(request,csrf);const name=(body as {name?:unknown})?.name;if(typeof name!=='string'||name.trim()==='')throw invalid();return{data:await this.service.fromTemplate(s,tenantId,key,name.trim(),templateTimezone((body as {timezone?:unknown}).timezone)),request_id:request.id};}
 @Patch('tenants/:tenantId/automations/:id') async update(@Param('tenantId')tenantId:string,@Param('id')id:string,@Body()body:unknown,@Headers('x-csrf-token')csrf:string|string[]|undefined,@Req()request:FastifyRequest){const s=await this.mutating(request,csrf);const p=parseVersioned(body);return{data:await this.service.update(s,tenantId,id,p.version,p.value),request_id:request.id};}
 @Delete('tenants/:tenantId/automations/:id') async deleteDraft(@Param('tenantId')tenantId:string,@Param('id')id:string,@Body()body:unknown,@Headers('x-csrf-token')csrf:string|string[]|undefined,@Req()request:FastifyRequest){const s=await this.mutating(request,csrf);return{data:await this.service.deleteDraft(s,tenantId,id,parseVersion(body)),request_id:request.id};}
 @Post('tenants/:tenantId/automations/:id/:act') @HttpCode(200) async act(@Param('tenantId')tenantId:string,@Param('id')id:string,@Param('act')act:string,@Body()body:unknown,@Headers('x-csrf-token')csrf:string|string[]|undefined,@Req()request:FastifyRequest){if(!['activate','pause','resume','archive'].includes(act))throw invalid();const s=await this.mutating(request,csrf);return{data:await this.service.transition(s,tenantId,id,parseVersion(body),act as 'activate'|'pause'|'resume'|'archive'),request_id:request.id};}
 private async mutating(request:FastifyRequest,csrf:string|string[]|undefined){const s=await this.auth.authenticate(request.headers.cookie);this.auth.requireCsrf(s,request.headers.cookie,csrf);return s;}
}
function invalid():ApiHttpError{return new ApiHttpError(400,'validation_failed','The automation request is invalid.');}
/**
 * The zone a template's schedule runs in. An older client sends none and keeps
 * UTC; a newer one sends the operator's, so "every day at 9" is 9 for them.
 */
function templateTimezone(value:unknown):string{if(value===undefined||value===null)return 'UTC';if(typeof value!=='string'||value.length<1||value.length>100)throw invalid();try{new Intl.DateTimeFormat('en',{timeZone:value}).format();}catch{throw invalid();}return value;}
