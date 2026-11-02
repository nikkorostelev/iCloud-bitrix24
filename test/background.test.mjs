import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';

const temp=await mkdtemp(`${tmpdir()}/icloud-fast-worker-`);
process.env.DATA_DIR=temp;
process.env.ENCRYPTION_KEY=randomBytes(32).toString('base64');
const {accountId}=await import('../src/config.mjs');
const {backgroundRun,enqueue}=await import('../src/background.mjs');
test.after(()=>rm(temp,{recursive:true,force:true}));
const now=Date.parse('2026-11-02T20:00:00Z');
function fixture(name){
  const value={id:accountId('fast-worker',name),config:{autoEnabled:true,appleEmail:'test@example.com',calendarLinks:[
    {id:'work',bitrixId:'1',appleUrl:'https://caldav.icloud.com/work/',enabled:true},
    {id:'family',bitrixId:'2',appleUrl:'https://caldav.icloud.com/family/',enabled:true}
  ]},applePassword:'abcd-efgh-ijkl-mnop',state:{pairs:[],initializedLinks:{work:true,family:true},lastFullScan:new Date(now).toISOString(),appleRevisions:{'https://caldav.icloud.com/work/':'w1','https://caldav.icloud.com/family/':'f1'}}};
  const scans=[];
  const services={now:()=>now,appleClient:async()=>({}),appleRevisions:async()=>({...value.state.appleRevisions}),
    snapshot:async options=>{scans.push(options.linkIds);},runSync:async(_preview,providers)=>{await providers.snapshot();value.state.lastAutoError=null;}};
  return {value,services,scans};
}
test('unchanged calendars need no event downloads; only changed calendars are scanned',async()=>{
  const {value,services,scans}=fixture('differential');
  await backgroundRun(value,services); assert.deepEqual(scans,[]);
  services.appleRevisions=async()=>({'https://caldav.icloud.com/work/':'w2','https://caldav.icloud.com/family/':'f1'});
  await backgroundRun(value,services); assert.deepEqual(scans,[['work']]);
  await backgroundRun(value,services); assert.equal(scans.length,1);
  services.now=()=>now+31000;
  await backgroundRun(value,services); assert.deepEqual(scans[1],['work','family']);
});
test('Bitrix notifications select mapped or newly discovered event calendars',async()=>{
  const {value,services,scans}=fixture('callbacks');
  value.state.pairs=[{bitrixId:'123',calendarLinkId:'work'}];
  enqueue(value,600000,{eventId:'123'});
  services.eventSection=async()=>{throw new Error('Mapped events need no extra lookup');};
  await backgroundRun(value,services); assert.deepEqual(scans,[['work']]);
  enqueue(value,600000,{eventId:'456'});
  services.eventSection=async id=>{assert.equal(id,'456');return '2';};
  await backgroundRun(value,services); assert.deepEqual(scans[1],['family']);
});
test('failed requests retain forced retry and honor provider cooldown',async()=>{
  const {value,services,scans}=fixture('retry');
  services.appleRevisions=async()=>{const e=new Error('Rate limited');e.code='ICLOUD_RATE_LIMITED';e.retryAfterMs=120000;throw e;};
  await backgroundRun(value,services);
  assert.equal(value.state.nextRetryAt,now+120000);
  assert.equal(value.state.lastAutoErrorCode,'ICLOUD_RATE_LIMITED');
  services.appleRevisions=async()=>({...value.state.appleRevisions});
  await backgroundRun(value,services); assert.equal(scans.length,0);
  services.now=()=>now+120001;
  await backgroundRun(value,services); assert.deepEqual(scans,[['work','family']]);
  assert.equal(value.state.lastAutoError,null);
});
test('one account cannot start overlapping revision checks',async()=>{
  const {value,services}=fixture('overlap');
  let release, checks=0;
  services.appleRevisions=async()=>{checks++;await new Promise(r=>{release=r;});return {...value.state.appleRevisions};};
  const first=backgroundRun(value,services);
  while(!release)await new Promise(r=>setImmediate(r));
  await backgroundRun(value,services); assert.equal(checks,1);
  release();await first;
});
