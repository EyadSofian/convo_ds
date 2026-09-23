import { describe, expect, it } from 'vitest';
import { parseAutomation, parseAutomationEvent, parseAutomationListQuery, parseAutomationRunsQuery, parseVersion, parseVersioned } from './automation-request.js';
const workflow={version:1,trigger:{type:'manual',config:{}},target:{type:'single_customer',config:{}},steps:[{id:'notify',type:'create_internal_notification',config:{}}],safety:{approvalRequired:false,duplicateWindowSeconds:60}};
describe('automation request boundary',()=>{
 it('normalizes a valid definition and version',()=>{expect(parseAutomation({name:'  Welcome  ',description:' ',timezone:'Africa/Cairo',workflow}).name).toBe('Welcome');expect(parseVersion({version:2})).toBe(2);expect(parseVersioned({version:1,name:'A',timezone:'UTC',workflow}).version).toBe(1);});
 it('rejects invalid names, zones, workflows and versions',()=>{for(const value of [null,{name:'',timezone:'UTC',workflow},{name:'A',timezone:'Mars/Base',workflow},{name:'A',timezone:'UTC',workflow:{}},{name:'A',description:2,timezone:'UTC',workflow}])expect(()=>parseAutomation(value)).toThrowError(/invalid/i);for(const value of [null,{version:0},{version:1.2}])expect(()=>parseVersion(value)).toThrowError(/invalid/i);});
 it('accepts typed events and rejects malformed event identity',()=>{expect(parseAutomationEvent({type:'student_enrolled',payload:{id:'1'},idempotencyKey:'event-1',occurredAt:'2026-09-17T08:00:00Z'})).toMatchObject({type:'student_enrolled',idempotencyKey:'event-1'});for(const value of [null,{type:'made_up',payload:{},idempotencyKey:'x',occurredAt:'2026-09-17T08:00:00Z'},{type:'manual',payload:[],idempotencyKey:'x',occurredAt:'2026-09-17T08:00:00Z'},{type:'manual',payload:{},idempotencyKey:'',occurredAt:'2026-09-17T08:00:00Z'},{type:'manual',payload:{},idempotencyKey:'x',occurredAt:'bad'}])expect(()=>parseAutomationEvent(value)).toThrowError(/invalid/i);});
 it('keeps archived definitions hidden by default but permits an explicit review filter',()=>{expect(parseAutomationListQuery({})).toMatchObject({state:null,sort:'name_asc'});expect(parseAutomationListQuery({state:'archived',sort:'updated_desc'})).toMatchObject({state:'archived',sort:'updated_desc'});expect(()=>parseAutomationListQuery({state:'deleted'})).toThrowError(/invalid/i);});
 it('validates bounded list and run query inputs at the HTTP boundary',()=>{
  expect(parseAutomationListQuery({search:'  welcome  ',state:'paused',sort:'name_desc',cursor:'opaque',limit:'100'})).toEqual({search:'welcome',state:'paused',sort:'name_desc',cursor:'opaque',limit:100});
  expect(parseAutomationListQuery({limit:'1'})).toMatchObject({limit:1});
  expect(parseAutomationRunsQuery({cursor:'opaque',limit:'100'})).toEqual({cursor:'opaque',limit:100});
  expect(parseAutomationRunsQuery({})).toEqual({cursor:null,limit:25});
  expect(parseAutomationListQuery(null)).toMatchObject({state:null, sort:'name_asc'});
  expect(parseAutomationRunsQuery(null)).toEqual({cursor:null, limit:25});
  const invalid = [
   {search:2}, {search:''}, {search:'   '}, {search:'x'.repeat(161)},
   {state:2}, {sort:2}, {cursor:2}, {cursor:''}, {cursor:'x'.repeat(4097)},
   {sort:'unsupported'},
   {limit:''}, {limit:'0'}, {limit:'-1'}, {limit:'101'}, {limit:'1.5'}, {limit:'abc'},
   {unknown:'value'},
  ];
  for (const value of invalid) expect(() => parseAutomationListQuery(value)).toThrowError(/invalid/i);
  for (const value of [{cursor:2},{cursor:''},{cursor:'x'.repeat(4097)},{limit:''},{limit:'0'},{limit:'-1'},{limit:'101'},{limit:'1.5'},{limit:'abc'},{unknown:'value'}]) expect(() => parseAutomationRunsQuery(value)).toThrowError(/invalid/i);
 });
});
