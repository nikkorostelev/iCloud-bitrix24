import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {plan,upsertPair} from '../src/planner.mjs';

const temp=await mkdtemp(`${tmpdir()}/bitrix-recurrence-`);
process.env.DATA_DIR=temp;process.env.ENCRYPTION_KEY=randomBytes(32).toString('base64');
const {accountId,context}=await import('../src/config.mjs');
const {normalizeBitrix,lookupBitrix,updateBitrix,deleteBitrix}=await import('../src/bitrix.mjs');
const {icalString}=await import('../src/icloud.mjs');
const {runSync}=await import('../src/sync.mjs');
test.after(()=>rm(temp,{recursive:true,force:true}));
const row=(day=5)=>({ID:'10',NAME:'Weekly meeting',CAL_TYPE:'user',OWNER_ID:'1',SECTION_ID:'2',DATE_FROM:`${String(day).padStart(2,'0')}.11.2026 11:00:00`,DATE_TO:`${String(day).padStart(2,'0')}.11.2026 12:30:00`,TZ_OFFSET_FROM:'10800',TZ_OFFSET_TO:'10800',RRULE:{FREQ:'WEEKLY',BYDAY:{TH:'TH'}},IS_MEETING:true});
const value=name=>({id:accountId('native-recurrence',name),portal:'example.bitrix24.ru',user:{id:1},config:{},state:{pairs:[]},oauth:{accessToken:'test',expiresAt:Date.now()+3600000}});

test('provider-expanded dates get distinct stable identities despite sharing the series ID',()=>{
  const first=normalizeBitrix(row(5)),next=normalizeBitrix(row(12));
  assert.equal(first.id,'10#occurrence=2026-11-05');
  assert.notEqual(first.id,next.id);
  assert.equal(first.unsupported,null);assert.equal(first.sourceOnly,true);assert.equal(first.isMeeting,true);
  assert.equal(normalizeBitrix({...row(5),DATE_FROM:'05.11.2026 13:00:00',DATE_TO:'05.11.2026 14:30:00'}).id,first.id);
  assert.equal(plan([first,next],[],{pairs:[]}).filter(a=>a.kind==='createApple').length,2);
});

test('detached reschedules retain original date identity and remember their own API record',()=>{
  const moved=normalizeBitrix({...row(6),ID:'20',RECURRENCE_ID:10,ORIGINAL_DATE_FROM:'05.11.2026 11:00:00',RRULE:''});
  assert.equal(moved.id,'10#occurrence=2026-11-05');assert.equal(moved.sourceRecordId,'20');assert.equal(moved.unsupported,null);
});

test('personal Apple copies contain no recurrence rules, invitation method, organizer or attendees',()=>{
  const source=normalizeBitrix(row());
  const data=icalString(source,'native-copy');
  assert.ok(data.includes('SUMMARY:Weekly meeting'));
  assert.doesNotMatch(data,/ATTENDEE|ORGANIZER|METHOD:|RRULE:/);
});

test('native recurrence changes update Apple; changes or deletions in Apple never edit the Bitrix series',()=>{
  const b=normalizeBitrix({...row(),IS_MEETING:false});
  const a={...b,id:'https://caldav.icloud.com/copy.ics',side:'apple',sourceOnly:false};
  const state={pairs:[],deletedAppleUrls:new Set([a.id])};upsertPair(state,b,a);
  assert.equal(plan([{...b,title:'Changed at source'}],[a],state)[0].kind,'updateApple');
  assert.equal(plan([b],[{...a,title:'Changed in Apple'}],state)[0].kind,'conflict');
  assert.equal(plan([b],[],state)[0].kind,'conflict');
  assert.equal(state.pairs[0].bitrixRecordId,'10');assert.equal(state.pairs[0].bitrixSourceOnly,true);
});

test('getbyid definitions are resolved through provider date expansion; EXDATE confirms exclusions',async t=>{
  const account=value('lookup');let excluded=false,queries=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const body=JSON.parse(options.body);
    if(url.includes('calendar.event.getbyid'))return {ok:true,status:200,json:async()=>({result:{...row(1),EXDATE:excluded?'05.11.2026':''}})};
    queries++;assert.deepEqual(body.section,[2]);assert.equal(body.from,'2026-11-05');assert.equal(body.to,'2026-11-05');
    return {ok:true,status:200,json:async()=>({result:excluded?[]:[row(5),row(12)]})};
  });
  await context.run(account,async()=>{
    assert.equal((await lookupBitrix('10#occurrence=2026-11-05','2')).start,normalizeBitrix(row(5)).start);
    excluded=true;assert.equal(await lookupBitrix('10#occurrence=2026-11-05','2'),null);
  });assert.equal(queries,2);
});

test('a known detached exception moved outside the query window is looked up by its real record',async t=>{
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    assert.equal(JSON.parse(options.body).id,20);
    return {ok:true,status:200,json:async()=>({result:{...row(5),ID:'20',DATE_FROM:'05.12.2026 11:00:00',DATE_TO:'05.12.2026 12:30:00',RRULE:'',RECURRENCE_ID:10,ORIGINAL_DATE_FROM:'05.11.2026 11:00:00'}})};
  });
  await context.run(value('exception'),async()=>{
    const found=await lookupBitrix('10#occurrence=2026-11-05','2',{bitrixRecordId:'20'});
    assert.equal(found.id,'10#occurrence=2026-11-05');assert.equal(new Date(found.start).getUTCMonth(),11);
  });
});

test('ending a series confirms removal of later dates; unexplained omissions preserve the copy',async t=>{
  let until='01.01.2038';
  t.mock.method(globalThis,'fetch',async url=>({ok:true,status:200,json:async()=>({result:url.includes('calendar.event.getbyid')?{...row(),RRULE:{FREQ:'WEEKLY',UNTIL:until}}:[]})}));
  await context.run(value('termination'),async()=>{
    const unconfirmed=await lookupBitrix('10#occurrence=2026-11-12','2');
    assert.match(unconfirmed.unsupported,/Копия сохранена/);
    until='05.11.2026';
    assert.equal(await lookupBitrix('10#occurrence=2026-11-12','2'),null);
  });
});

test('synthetic IDs can never reach calendar.event.update or calendar.event.delete',async t=>{
  let deletes=0;
  t.mock.method(globalThis,'fetch',async url=>{
    if(url.includes('calendar.event.delete'))deletes++;
    return {ok:true,status:200,json:async()=>({result:url.includes('calendar.event.getbyid')?{...row(),IS_MEETING:false}:[{...row(),IS_MEETING:false}]})};
  });
  await context.run(value('guards'),async()=>{
    const event=normalizeBitrix({...row(),IS_MEETING:false});
    await assert.rejects(updateBitrix(event.id,event,'2'),/только для чтения/);
    await assert.rejects(deleteBitrix(event,'2'),/перед удалением/);
  });assert.equal(deletes,0);
});

test('provider offsets preserve local meeting time across DST dates',()=>{
  const a=normalizeBitrix({...row(),DATE_FROM:'24.10.2026 09:00:00',DATE_TO:'24.10.2026 10:00:00',TZ_OFFSET_FROM:'7200',TZ_OFFSET_TO:'7200'});
  const b=normalizeBitrix({...row(),DATE_FROM:'25.10.2026 09:00:00',DATE_TO:'25.10.2026 10:00:00',TZ_OFFSET_FROM:'3600',TZ_OFFSET_TO:'3600'});
  assert.deepEqual([new Date(a.start).getUTCHours(),new Date(b.start).getUTCHours()],[7,8]);
});

test('copy creation preserves per-occurrence mappings and does not mark Apple copies as source series',async()=>{
  const account=value('routing');const bitrix=[normalizeBitrix(row(5)),normalizeBitrix(row(12))];
  const actions=plan(bitrix,[],account.state);
  await context.run(account,()=>runSync(null,{snapshot:async()=>({groups:[{link:{id:'work',bitrixId:'2'},calendar:{},bitrix,apple:[],actions}],actions}),createApple:async(_client,_calendar,event)=>`https://caldav.icloud.com/${encodeURIComponent(event.id)}.ics`}));
  assert.equal(account.state.pairs.length,2);assert.equal(new Set(account.state.pairs.map(p=>p.appleUrl)).size,2);
  assert.ok(account.state.pairs.every(p=>p.bitrixSourceOnly && p.bitrixRecordId==='10'));
});
