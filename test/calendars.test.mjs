import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const temp = await mkdtemp(`${tmpdir()}/icloud-calendars-`);
process.env.DATA_DIR = temp;
process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
const { context, accountId, readAccount } = await import('../src/config.mjs');
const { calendarLinks, validateSelection, configureCalendars, saveDeferredPreferences } = await import('../src/calendars.mjs');
const { callbackUrl, validCallback, autoWaitingReason, backgroundRun } = await import('../src/background.mjs');
const { runSync } = await import('../src/sync.mjs');
const bitrix = [{id:'1',name:'Work',color:'#123456'}, {id:'2',name:'Personal',color:'#654321'}];
const apple = [{url:'https://caldav.icloud.com/work/',displayName:'Work'}, {url:'https://caldav.icloud.com/family/',displayName:'Family'}];
test.after(()=>rm(temp,{recursive:true,force:true}));
test('legacy calendar selection is preserved',()=>{
  assert.deepEqual(calendarLinks({sectionId:'1',calendarUrl:apple[0].url}),[{id:'legacy',bitrixId:'1',appleUrl:apple[0].url,enabled:true}]);
});
test('automatic mode can be requested early but the worker never writes before first confirmation',async t=>{
  const value={id:accountId('test','auto-wait'),config:{autoEnabled:true,calendarLinks:[{id:'link',bitrixId:'1',appleUrl:apple[0].url,enabled:true}]},state:{pairs:[]}};
  let requests=0;
  t.mock.method(globalThis,'fetch',async()=>{requests++;throw new Error('Must not contact providers while waiting');});
  assert.match(autoWaitingReason(value),/подключение iCloud/);
  value.config.appleEmail='test@example.com';value.applePassword='abcd-efgh-ijkl-mnop';
  assert.match(autoWaitingReason(value),/первый запуск/);
  await backgroundRun(value);
  assert.equal(requests,0);
  assert.equal(value.config.autoEnabled,true);
  value.config.pendingBitrixIds=['2'];
  assert.match(autoWaitingReason(value),/применение выбора/);
  await backgroundRun(value);
  assert.equal(requests,0);
  value.config.pendingBitrixIds=[];
  value.state.initializedLinks={link:true};
  assert.equal(autoWaitingReason(value),null);
  value.config.calendarLinks[0].enabled=false;
  assert.match(autoWaitingReason(value),/выбор календарей/);
});
test('Bitrix selection persists offline without calling Apple and can be cleared or applied later',async()=>{
  const value={id:accountId('test','deferred'),config:{autoEnabled:true,calendarLinks:[{id:'existing',bitrixId:'1',appleUrl:apple[0].url,enabled:true}]},state:{pairs:[]}};
  const services={sections:async()=>bitrix};
  await context.run(value,()=>saveDeferredPreferences({links:[{id:'existing',enabled:false}],bitrixIds:['2'],horizonDays:60},services));
  assert.deepEqual((await readAccount(value.id)).config.pendingBitrixIds,['2']);
  assert.equal(value.config.calendarLinks[0].enabled,false);
  assert.equal(value.config.autoEnabled,true);
  await assert.rejects(context.run(value,()=>saveDeferredPreferences({bitrixIds:['foreign'],horizonDays:60},services)),/недоступен/);
  await assert.rejects(context.run(value,()=>saveDeferredPreferences({bitrixIds:['2','2'],horizonDays:60},services)),/Неверный/);
  assert.deepEqual(value.config.pendingBitrixIds,['2']);
  await context.run(value,()=>saveDeferredPreferences({bitrixIds:[],horizonDays:60},services));
  assert.deepEqual((await readAccount(value.id)).config.pendingBitrixIds,[]);
  await context.run(value,()=>saveDeferredPreferences({bitrixIds:['2'],horizonDays:60},services));
  await context.run(value,()=>configureCalendars({horizonDays:60,additions:[{side:'bitrix',sourceId:'2'}]}, {
    inventory:async()=>({client:{},bitrix,apple}),
    createAppleCalendar:async()=>apple[1].url,
  }));
  assert.deepEqual((await readAccount(value.id)).config.pendingBitrixIds,[]);
  assert.equal(value.config.calendarLinks[1].bitrixId,'2');
});
test('a source or target cannot be reused by multiple links',()=>{
  const additions = [{side:'apple',sourceId:apple[0].url,targetId:'1'}, {side:'apple',sourceId:apple[1].url,targetId:'1'}];
  assert.throws(()=>validateSelection([],[],additions,bitrix,apple),/несколькими/);
  assert.throws(()=>validateSelection([],[],[{side:'apple',sourceId:'https://untrusted.example/'}],bitrix,apple),/недоступен/);
});
test('select multiple calendars, create missing counterparts, pause and resume without recreating', async()=>{
  const value={id:accountId('test','1'),config:{},state:{pairs:[]}};
  const calls=[];
  const services={inventory:async()=>({client:{},bitrix,apple}),createBitrixCalendar:async(name)=>{calls.push(['B',name]);return '3';},createAppleCalendar:async(c,name)=>{calls.push(['A',name]);return 'https://caldav.icloud.com/personal/';}};
  await context.run(value,()=>configureCalendars({horizonDays:90,additions:[
    {side:'apple',sourceId:apple[0].url,targetId:'1'},
    {side:'apple',sourceId:apple[1].url,targetId:''},
    {side:'bitrix',sourceId:'2',targetId:''},
  ]},services));
  assert.equal(value.config.calendarLinks.length,3);
  assert.equal(value.config.calendarLinks[0].createdBitrix,false);
  assert.equal(value.config.calendarLinks[1].createdBitrix,true);
  assert.equal(value.config.calendarLinks[2].createdApple,true);
  assert.deepEqual(calls,[['B','Family'],['A','Personal']]);
  const first=value.config.calendarLinks[0];
  await context.run(value,()=>configureCalendars({horizonDays:90,links:[{id:first.id,enabled:false}]},services));
  await context.run(value,()=>configureCalendars({horizonDays:90,links:[{id:first.id,enabled:true}]},services));
  assert.equal(calls.length,2);
  assert.equal((await readAccount(value.id)).config.calendarLinks.length,3);
});
test('unlink unused legacy mapping while keeping event-bearing mappings protected',async()=>{
  const value={id:accountId('test','2'),config:{sectionId:'1',calendarUrl:apple[0].url},state:{pairs:[]}};
  const services={inventory:async()=>({bitrix,apple})};
  await context.run(value,()=>configureCalendars({horizonDays:30,links:[{id:'legacy',enabled:false,remove:true}],additions:[{side:'apple',sourceId:apple[1].url,targetId:'1'}]},services));
  assert.equal(value.config.calendarLinks[0].appleUrl,apple[1].url);
  const link=value.config.calendarLinks[0]; value.state.pairs=[{calendarLinkId:link.id,bitrixId:'event'}];
  await assert.rejects(context.run(value,()=>configureCalendars({horizonDays:30,links:[{id:link.id,enabled:false,remove:true}]},services)),/связанные события/);
});
test('calendar event callbacks authenticate account, portal and event type',()=>{
  const id=accountId('test','1'), secret=callbackUrl(id).split('/').at(-1);
  const fields={event:'ONCALENDARENTRYUPDATE','auth[domain]':'bazabzshow.bitrix24.ru','auth[member_id]':'test'};
  assert.ok(validCallback(id,secret,fields,{memberId:'test'}));
  assert.ok(!validCallback(id,'a'.repeat(64),fields,{memberId:'test'}));
  assert.ok(!validCallback(id,secret,{...fields,'auth[member_id]':'other'},{memberId:'test'}));
  assert.ok(!validCallback(id,secret,fields,{memberId:'test',portal:'delovayasreda.bitrix24.ru'}));
  assert.ok(validCallback(id,secret,{...fields,'auth[domain]':'delovayasreda.bitrix24.ru'},{memberId:'test',portal:'delovayasreda.bitrix24.ru'}));
});

test('identical events in different calendars are routed to their own counterpart and retain separate state', async()=>{
  const value={id:accountId('test','routing'),config:{},state:{pairs:[]}};
  const groups=['1','2'].map(id=>{
    const source={side:'apple',id:`https://caldav.icloud.com/${id}/event.ics`,title:'Same title',start:1,end:2,allDay:false,location:''};
    return {link:{id,bitrixId:id},calendar:{url:`https://caldav.icloud.com/${id}/`},bitrix:[],apple:[source],actions:[{kind:'createBitrix',source,title:source.title,calendarName:id}]};
  });
  const calls=[];
  await context.run(value,()=>runSync(null,{snapshot:async()=>({groups,actions:groups.flatMap(g=>g.actions)}),createBitrix:async(event,section)=>{calls.push(section);return `event-${section}`;}}));
  assert.deepEqual(calls,['1','2']);
  assert.deepEqual(value.state.pairs.map(p=>[p.calendarLinkId,p.bitrixId]),[['1','event-1'],['2','event-2']]);
  assert.ok(value.state.initializedLinks['1'] && value.state.initializedLinks['2']);
});

test('recurrence copies are idempotent and history survives subsequent unchanged passes', async()=>{
  const {plan} = await import('../src/planner.mjs');
  const value={id:accountId('test','recurring-routing'),config:{},state:{pairs:[]}};
  const apple=[1,2,3].map(day=>({side:'apple',id:`https://caldav.icloud.com/series.ics#${day}`,title:'Planning',start:day*86400000,end:day*86400000+3600000,allDay:false,location:'',sourceOnly:true}));
  const bitrix=[];
  const services={snapshot:async()=>{const actions=plan(bitrix,apple,value.state);return {groups:[{link:{id:'recurring',bitrixId:'1'},calendar:{},bitrix,apple,actions}],actions};},createBitrix:async event=>{
    assert.equal(value.state.syncProgress.phase,'writing');
    const id=String(bitrix.length+1); bitrix.push({...event,side:'bitrix',id,sourceOnly:false}); return id;
  }};
  await context.run(value,()=>runSync(null,services));
  assert.equal(bitrix.length,3);
  assert.equal(value.state.syncProgress,null);
  assert.equal(value.state.lastResults.length,3);
  const second=await context.run(value,()=>runSync(null,services));
  assert.equal(second.results.length,0);
  assert.equal(bitrix.length,3);
  assert.equal(value.state.lastResults.length,3);
  await assert.rejects(context.run(value,()=>runSync(null,{snapshot:async()=>{throw new Error('Provider unavailable');}})),/Provider unavailable/);
  assert.equal(value.state.syncProgress,null);
});
