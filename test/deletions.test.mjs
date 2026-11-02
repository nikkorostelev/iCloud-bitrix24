import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {plan,upsertPair} from '../src/planner.mjs';

const temp=await mkdtemp(`${tmpdir()}/icloud-deletions-`);
process.env.DATA_DIR=temp;process.env.ENCRYPTION_KEY=randomBytes(32).toString('base64');
const {context,accountId,readAccount}=await import('../src/config.mjs');
const {reconcileMissing,runSync}=await import('../src/sync.mjs');
const {lookupApple,deleteApple,expandApple}=await import('../src/icloud.mjs');
const {lookupBitrix,deleteBitrix}=await import('../src/bitrix.mjs');
test.after(()=>rm(temp,{recursive:true,force:true}));
const start=Date.parse('2026-11-03T09:00:00Z');
const b={side:'bitrix',id:'1',title:'Meeting',start,end:start+3600000,allDay:false,location:''};
const a={...b,side:'apple',id:'https://caldav.icloud.com/work/event.ics'};
function linked(){const state={pairs:[],deletedBitrixIds:new Set(),deletedAppleUrls:new Set()};upsertPair(state,b,a);return state;}
const ics=extra=>['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:test-series','DTSTART:20261103T090000Z','DTEND:20261103T100000Z','SUMMARY:Meeting',...extra,'END:VEVENT','END:VCALENDAR'].join('\r\n');

test('only confirmed absence schedules a deletion; edits and protected meetings conflict',()=>{
  const state=linked();
  assert.equal(plan([], [a],state)[0].kind,'conflict');
  state.deletedBitrixIds.add(b.id);
  assert.equal(plan([], [a],state)[0].kind,'deleteApple');
  assert.equal(plan([], [{...a,title:'New edit'}],state)[0].kind,'conflict');
  state.deletedAppleUrls.add(a.id);
  assert.equal(plan([b],[],state)[0].kind,'deleteBitrix');
  assert.equal(plan([{...b,isMeeting:true}],[],state)[0].kind,'conflict');
  assert.equal(plan([],[],state)[0].kind,'forgetPair');
});

test('missing range results are rechecked by id, including events moved outside the window',async()=>{
  const state=linked();
  const moved={...b,start:start+90*86400000,end:start+90*86400000+3600000};
  const verified=await reconcileMissing([], [a],state.pairs,{lookupBitrix:async()=>moved,lookupApple:async()=>{throw new Error('Already loaded');}},start-86400000,start+86400000);
  assert.equal(plan(verified.bitrix,verified.apple,verified.state)[0].kind,'updateApple');
  let calls=0;
  await reconcileMissing([],[],state.pairs,{lookupBitrix:async()=>{calls++;},lookupApple:async()=>{calls++;}},start+100*86400000,start+101*86400000);
  assert.equal(calls,0);
  await assert.rejects(reconcileMissing([], [a],state.pairs,{lookupBitrix:async()=>{throw new Error('403 Forbidden');}},start-1,start+1),/403/);
});

test('Apple absence requires 404 or cancellation, not forbidden, broken or missing data',async t=>{
  const client={authHeaders:{authorization:'Basic test'}};
  t.mock.method(globalThis,'fetch',async()=>new Response('',{status:404}));
  assert.equal(await lookupApple(client,a.id),null);
  t.mock.method(globalThis,'fetch',async()=>new Response('',{status:403}));
  await assert.rejects(lookupApple(client,a.id),/403/);
  t.mock.method(globalThis,'fetch',async()=>new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR',{status:200}));
  await assert.rejects(lookupApple(client,a.id),/неполное/);
  await assert.rejects(lookupApple(client,`${a.id}#occurrence=${encodeURIComponent('2026-11-03T09:00:00Z')}`),/неполную серию/);
  t.mock.method(globalThis,'fetch',async()=>new Response(ics([]),{status:200,headers:{etag:'"v1"'}}));
  assert.equal((await lookupApple(client,a.id)).title,'Meeting');
});

test('deleting a Bitrix recurrence copy excludes only that occurrence with ETag protection',async t=>{
  const data=ics(['RRULE:FREQ=DAILY;COUNT=3']);
  t.mock.method(globalThis,'fetch',async()=>new Response(data,{headers:{etag:'"v1"'}}));
  let changed;
  const client={authHeaders:{},updateCalendarObject:async({calendarObject})=>{changed=calendarObject;return {ok:true};},deleteCalendarObject:async()=>{throw new Error('Must never delete the master');}};
  const before=expandApple({url:a.id,data},start-1,start+4*86400000);
  await deleteApple(client,before[1]);
  assert.equal(changed.etag,'"v1"');
  const after=expandApple({url:a.id,data:changed.data},start-1,start+4*86400000);
  assert.deepEqual(after.map(e=>e.id),[before[0].id,before[2].id]);
  t.mock.method(globalThis,'fetch',async()=>new Response(changed.data,{headers:{etag:'"v2"'}}));
  assert.equal(await lookupApple(client,before[1].id),null);
});

test('cancelling the anchor of THISANDFUTURE keeps future reschedules intact',async t=>{
  const data=ics(['RRULE:FREQ=DAILY;COUNT=5']).replace('END:VCALENDAR',[
    'BEGIN:VEVENT','UID:test-series','RECURRENCE-ID;RANGE=THISANDFUTURE:20261104T090000Z','DTSTART:20261104T120000Z','DTEND:20261104T130000Z','SUMMARY:Shifted','END:VEVENT','END:VCALENDAR'
  ].join('\r\n'));
  t.mock.method(globalThis,'fetch',async()=>new Response(data,{headers:{etag:'"v1"'}}));
  let changed;
  const client={authHeaders:{},updateCalendarObject:async({calendarObject})=>{changed=calendarObject.data;return {ok:true};}};
  const before=expandApple({url:a.id,data},start-1,start+6*86400000);
  await deleteApple(client,before[1]);
  const after=expandApple({url:a.id,data:changed},start-1,start+6*86400000);
  assert.equal(after.length,4);
  assert.equal(after[1].title,'Shifted');
  assert.equal(new Date(after[1].start).getUTCHours(),12);
});

test('recurrence cancellation preserves TZID and removes a moved exception without affecting its neighbors',async t=>{
  const data=['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VTIMEZONE','TZID:Europe/Moscow','BEGIN:STANDARD','DTSTART:19700101T000000','TZOFFSETFROM:+0300','TZOFFSETTO:+0300','END:STANDARD','END:VTIMEZONE',
    'BEGIN:VEVENT','UID:tz-series','DTSTART;TZID=Europe/Moscow:20261103T120000','DTEND;TZID=Europe/Moscow:20261103T130000','SUMMARY:Meeting','RRULE:FREQ=DAILY;COUNT=3','END:VEVENT',
    'BEGIN:VEVENT','UID:tz-series','RECURRENCE-ID;TZID=Europe/Moscow:20261104T120000','DTSTART;TZID=Europe/Moscow:20261104T150000','DTEND;TZID=Europe/Moscow:20261104T160000','SUMMARY:Moved','END:VEVENT','END:VCALENDAR'].join('\r\n');
  t.mock.method(globalThis,'fetch',async()=>new Response(data,{headers:{etag:'"v1"'}}));
  let changed;
  const client={authHeaders:{},updateCalendarObject:async({calendarObject})=>{changed=calendarObject.data;return {ok:true};}};
  const before=expandApple({url:a.id,data},start-1,start+4*86400000);
  await deleteApple(client,before[1]);
  assert.match(changed,/EXDATE;TZID=Europe\/Moscow:20261104T120000/);
  assert.equal(changed.includes('SUMMARY:Moved'),false);
  assert.deepEqual(expandApple({url:a.id,data:changed},start-1,start+4*86400000).map(e=>e.id),[before[0].id,before[2].id]);
});

test('normal Apple deletion uses If-Match and rejects changes or failed preconditions',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(ics([]),{headers:{etag:'"v1"'}}));
  let deleted;
  const client={authHeaders:{},deleteCalendarObject:async({calendarObject})=>{deleted=calendarObject;return {ok:true};}};
  await deleteApple(client,a);assert.equal(deleted.etag,'"v1"');
  await assert.rejects(deleteApple(client,{...a,title:'Different'}),/изменилось/);
  client.deleteCalendarObject=async()=>({ok:false,status:412});
  await assert.rejects(deleteApple(client,a),/412/);
});

test('Bitrix direct lookup distinguishes deleted, moved, denied and changed events',async t=>{
  const value={id:accountId('delete-test','provider'),portal:'example.bitrix24.ru',user:{id:1},config:{},state:{pairs:[]},oauth:{accessToken:'test',expiresAt:Date.now()+3600000}};
  let result=null,deleted=false;
  t.mock.method(globalThis,'fetch',async(url)=>({ok:true,status:200,json:async()=>url.includes('calendar.event.delete')?(deleted=true,{result:true}):{result}}));
  await context.run(value,async()=>{
    assert.equal(await lookupBitrix('1','2'),null);
    result={ID:'1',CAL_TYPE:'user',OWNER_ID:'1',SECTION_ID:'other'};
    await assert.rejects(lookupBitrix('1','2'),/перемещено/);
    result={...result,SECTION_ID:'2',DATE_FROM:'03.11.2026 12:00:00',DATE_TO:'03.11.2026 13:00:00',TZ_OFFSET_FROM:'10800',TZ_OFFSET_TO:'10800',NAME:'Meeting'};
    await deleteBitrix(b,'2');assert.equal(deleted,true);
    result.NAME='Changed';deleted=false;
    await assert.rejects(deleteBitrix(b,'2'),/изменилось/);assert.equal(deleted,false);
  });
});

test('successful deletions remove only their scoped pair; failures and restored sources keep mappings',async()=>{
  for(const kind of ['deleteApple','deleteBitrix']) {
    const state=linked(),pair={...state.pairs[0],calendarLinkId:'work'};
    const value={id:accountId('delete-test',kind),config:{},state:{pairs:[pair,{...pair,calendarLinkId:'other'}]}};
    let fail=true,restored=false,calls=0;
    const action={kind,title:'Meeting',pair,target:kind==='deleteApple'?a:b};
    const group={link:{id:'work',bitrixId:'2'},bitrix:kind==='deleteBitrix'?[b]:[],apple:kind==='deleteApple'?[a]:[],actions:[action]};
    const services={snapshot:async()=>({groups:[group],actions:[action]}),lookupBitrix:async()=>restored?b:null,lookupApple:async()=>restored?a:null,
      deleteApple:async()=>{calls++;if(fail)throw new Error('412');},deleteBitrix:async()=>{calls++;if(fail)throw new Error('412');}};
    let result=await context.run(value,()=>runSync(null,services));
    assert.equal(result.results[0].ok,false);assert.equal(value.state.pairs.length,2);
    fail=false;restored=true;
    result=await context.run(value,()=>runSync(null,services));assert.equal(result.results[0].ok,false);assert.equal(calls,1);
    restored=false;await context.run(value,()=>runSync(null,services));
    assert.equal(value.state.pairs.length,1);assert.equal(value.state.pairs[0].calendarLinkId,'other');
    assert.equal((await readAccount(value.id)).state.deletedPairs.length,1);
  }
});
