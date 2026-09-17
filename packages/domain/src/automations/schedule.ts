export type ScheduleKind = 'one_time' | 'daily' | 'weekly' | 'monthly' | 'custom_recurrence' | 'relative';
export interface ScheduleIssue { readonly path: string; readonly code: string }
export interface ScheduleDefinition { readonly kind: ScheduleKind; readonly at?: string; readonly time?: string; readonly daysOfWeek?: readonly number[]; readonly dayOfMonth?: number; readonly everyMinutes?: number; readonly startAt?: string; readonly endAt?: string; readonly offsetMinutes?: number }
const KINDS: readonly ScheduleKind[] = ['one_time','daily','weekly','monthly','custom_recurrence','relative'];
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validateScheduleDefinition(input: unknown): readonly ScheduleIssue[] {
  const value=record(input); if(value===null||!member(value['kind'],KINDS))return[{path:'$.schedule.kind',code:'invalid_kind'}];
  const kind=value['kind'];const issues:ScheduleIssue[]=[];
  if(kind==='one_time'&&!instant(value['at']))issues.push({path:'$.schedule.at',code:'invalid_instant'});
  if((kind==='daily'||kind==='weekly'||kind==='monthly')&&(typeof value['time']!=='string'||!CLOCK.test(value['time'])))issues.push({path:'$.schedule.time',code:'invalid_time'});
  if(kind==='weekly'&&(!Array.isArray(value['daysOfWeek'])||value['daysOfWeek'].length===0||value['daysOfWeek'].some((day)=>!integer(day,0,6))))issues.push({path:'$.schedule.daysOfWeek',code:'invalid_days'});
  if(kind==='monthly'&&!integer(value['dayOfMonth'],1,31))issues.push({path:'$.schedule.dayOfMonth',code:'invalid_day'});
  if(kind==='custom_recurrence'&&!integer(value['everyMinutes'],1,525600))issues.push({path:'$.schedule.everyMinutes',code:'invalid_interval'});
  if(kind==='relative'&&!integer(value['offsetMinutes'],-525600,525600))issues.push({path:'$.schedule.offsetMinutes',code:'invalid_offset'});
  for(const key of ['startAt','endAt'] as const)if(value[key]!==undefined&&!instant(value[key]))issues.push({path:`$.schedule.${key}`,code:'invalid_instant'});
  if(instant(value['startAt'])&&instant(value['endAt'])&&Date.parse(value['endAt'])<=Date.parse(value['startAt']))issues.push({path:'$.schedule.endAt',code:'before_start'});
  return issues;
}

export function nextScheduledAt(definition:ScheduleDefinition,after:Date,timezone:string):Date|null {
  if(definition.kind==='relative')return null;const end=definition.endAt===undefined?null:new Date(definition.endAt);let candidate:Date|null;
  if(definition.kind==='one_time')candidate=definition.at===undefined?null:new Date(definition.at);
  else if(definition.kind==='custom_recurrence')candidate=recurring(definition,after);
  else candidate=calendar(definition,after,timezone);
  if(candidate===null||candidate.getTime()<=after.getTime()||(end!==null&&candidate>end))return null;return candidate;
}
function recurring(definition:ScheduleDefinition,after:Date):Date|null{const minutes=definition.everyMinutes;if(minutes===undefined)return null;const period=minutes*60000;const start=definition.startAt===undefined?after.getTime()+period:Date.parse(definition.startAt);const elapsed=after.getTime()-start;return new Date(elapsed<0?start:start+(Math.floor(elapsed/period)+1)*period);}
function calendar(definition:ScheduleDefinition,after:Date,timezone:string):Date|null{const match=definition.time?.match(CLOCK);if(match===undefined||match===null)return null;const hour=Number(match[1]);const minute=Number(match[2]);const local=localParts(after,timezone);const start=new Date(Date.UTC(local.year,local.month-1,local.day));for(let offset=0;offset<=370;offset+=1){const date=new Date(start.getTime()+offset*86400000);const day=date.getUTCDate();const weekDay=date.getUTCDay();if(definition.kind==='weekly'&&!definition.daysOfWeek?.includes(weekDay))continue;if(definition.kind==='monthly'&&day!==definition.dayOfMonth)continue;const candidate=zonedInstant(date.getUTCFullYear(),date.getUTCMonth()+1,day,hour,minute,timezone);if(candidate>after&&(definition.startAt===undefined||candidate>=new Date(definition.startAt)))return candidate;}return null;}
function zonedInstant(year:number,month:number,day:number,hour:number,minute:number,timezone:string):Date{const wall=Date.UTC(year,month-1,day,hour,minute);let guess=wall;for(let attempt=0;attempt<3;attempt+=1){const p=localParts(new Date(guess),timezone);const represented=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute);guess=wall-(represented-guess);}return new Date(guess);}
function localParts(value:Date,timezone:string):{year:number;month:number;day:number;hour:number;minute:number}{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(value);const get=(type:string)=>Number(parts.find((part)=>part.type===type)?.value);return{year:get('year'),month:get('month'),day:get('day'),hour:get('hour'),minute:get('minute')}}
function instant(value:unknown):value is string{return typeof value==='string'&&Number.isFinite(Date.parse(value));}function integer(value:unknown,min:number,max:number):boolean{return typeof value==='number'&&Number.isInteger(value)&&value>=min&&value<=max;}function member<T extends string>(value:unknown,values:readonly T[]):value is T{return typeof value==='string'&&(values as readonly string[]).includes(value);}function record(value:unknown):Record<string,unknown>|null{return typeof value==='object'&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:null;}
