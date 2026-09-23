import { isChannelKind, isConversationState, INBOX_FILTER_CATALOGUE, INBOX_SORTS, type InboxFilter, type InboxQuery, type InboxSort } from '@convo/domain';
import { isPriority } from './routing.service.js';
import { ApiHttpError } from '../http-error.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE=/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/;
const CURSOR=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
type QueryValue=string|string[]|undefined;

/** Strict HTTP boundary for the closed InboxQuery vocabulary. */
export function parseInboxQuery(query: Record<string, QueryValue>): InboxQuery {
 const allowed=new Set(['queue','sort','limit','cursor','search','filter']);
 if(Object.keys(query).some((key)=>!allowed.has(key)))throw bad('query');
 const queue=one(query['queue'])??'mine'; if(queue!=='mine'&&queue!=='all')throw bad('queue');
 const sort=one(query['sort'])??'activity_desc'; if(!(INBOX_SORTS as readonly string[]).includes(sort))throw bad('sort');
 const limit=integer(query['limit'],50,1,100,'limit');
 const cursor=one(query['cursor']); if(cursor!==undefined&&(cursor===''||cursor.length>4096||!CURSOR.test(cursor)))throw bad('cursor');
 const rawSearch=one(query['search']); const search=rawSearch===undefined?null:rawSearch.trim(); if(search!==null&&search.length>200)throw bad('search');
 const raw=query['filter']; const entries:string[]=raw===undefined?[]:Array.isArray(raw)?raw:[raw]; if(entries.length>20)throw bad('filter');
 const filters=entries.map(parseFilter);
 return {queue,filters,search:search===''?null:search,sort:sort as InboxSort,cursor:cursor??null,limit};
}

function parseFilter(raw:string):InboxFilter{
 let value:unknown;try{value=JSON.parse(raw);}catch{throw bad('filter');}
 if(value===null||typeof value!=='object'||Array.isArray(value))throw bad('filter');
 const input=value as Record<string,unknown>;const key=input['key'];const operator=input['operator'];
 if(typeof key!=='string'||typeof operator!=='string')throw bad('filter');
 const definition=INBOX_FILTER_CATALOGUE.find(item=>item.key===key);if(definition===undefined||!definition.operators.includes(operator))throw bad('filter');
 const fieldId=input['fieldId']; if(key==='custom_field'?(typeof fieldId!=='string'||!UUID.test(fieldId)):fieldId!==undefined)throw bad('filter');
 const valueless=operator==='is_set'||operator==='is_not_set'; if(valueless&&Object.hasOwn(input,'value'))throw bad('filter'); if(!valueless&&!Object.hasOwn(input,'value'))throw bad('filter');
 const parsed=valueless?undefined:parseValue(definition.valueType,input['value'],key,operator);
 const customFieldId=typeof fieldId==='string'?fieldId:undefined;
 return {...(customFieldId===undefined?{}:{fieldId:customFieldId}),key:definition.key,operator,...(parsed===undefined?{}:{value:parsed})};
}
function parseValue(type:string,input:unknown,key:string,operator:string):string|boolean|readonly string[]{
 if(type==='custom_field') return customValue(input);
 const list=operator==='in'||operator==='not_in'; if(list){if(!Array.isArray(input)||input.length===0||input.length>20)return fail();return input.map(v=>scalar(type,v,key));}
 if(type==='boolean'){if(typeof input!=='boolean')return fail();return input;}
 if(typeof input!=='string')return fail();return scalar(type,input,key);
}
function scalar(type:string,value:unknown,key:string):string{
 if(typeof value!=='string'||value.length===0||value.length>500)return fail();
 if(['membership_id','team_id','connection_id','label_id','campaign_id'].includes(type)&&!UUID.test(value))return fail();
 if(type==='enum'){
  const valid=(key==='status'&&isConversationState(value))||(key==='priority'&&isPriority(value))||(key==='channel'&&isChannelKind(value))||(key==='assignment_state'&&(value==='assigned'||value==='unassigned'));
  if(!valid)return fail();
 }
 if(type==='date'&&(!DATE.test(value)||!validDate(value)))return fail(); return value;
}
function customValue(input: unknown): string | boolean {
 if (typeof input === 'boolean') return input;
 if (typeof input !== 'string' || input.length === 0 || input.length > 500) return fail();
 return input;
}
function validDate(value: string): boolean {
 const day=value.slice(0,10);const parsed=new Date(`${day}T00:00:00.000Z`);
 if(Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==day)return false;
 return value.length===10||!Number.isNaN(new Date(value).getTime());
}
function integer(value:QueryValue,fallback:number,min:number,max:number,field:string):number{const raw=one(value);if(raw===undefined||raw==='')return fallback;const n=Number(raw);if(!Number.isInteger(n)||n<min||n>max)throw bad(field);return n;}
function one(value:QueryValue):string|undefined{if(Array.isArray(value))throw bad('query');return value;}
function fail():never{throw bad('filter');}
function bad(field:string):ApiHttpError{return new ApiHttpError(400,'validation_failed','The Inbox query is not valid.',[{field,code:'invalid',message:'Use a supported bounded query value.'}]);}
