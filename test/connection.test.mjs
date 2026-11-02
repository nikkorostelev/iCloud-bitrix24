import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
const temp = await mkdtemp(`${tmpdir()}/icloud-disconnect-`);
process.env.DATA_DIR = temp;
process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
const {context,accountId,readAccount}=await import('../src/config.mjs');
const {disconnectPreview,disconnectApple}=await import('../src/connection.mjs');
test.after(()=>rm(temp,{recursive:true,force:true}));
function fixture(label){return {id:accountId('disconnect',label),applePassword:'secret',config:{appleEmail:'test@example.com',autoEnabled:true,calendarLinks:[
  {id:'original',bitrixId:'1',enabled:true},
  {id:'mirror',bitrixId:'2',enabled:true,createdBitrix:true},
  {id:'unknown',bitrixId:'3',enabled:false},
]},state:{pairs:[{calendarLinkId:'mirror',bitrixId:'e'}]}};}
function services(deleted){return {sections:async()=>['1','2','3'].map(id=>({id,name:id})),deleteBitrixCalendar:async id=>deleted.push(id),forgetAppleClients:()=>{}};}
test('disconnect deletes only managed Bitrix calendars, never originals or unknown legacy calendars',async()=>{
  const value=fixture('managed'),deleted=[],api=services(deleted);
  await context.run(value,async()=>{
    const preview=await disconnectPreview(api);
    assert.deepEqual(preview.calendars.map(c=>c.id),['2']);
    assert.deepEqual(preview.preserved.map(c=>c.id),['1','3']);
    await disconnectApple({confirm:true,deleteCalendars:true,previewToken:preview.previewToken},api);
  });
  assert.deepEqual(deleted,['2']);
  const saved=await readAccount(value.id);
  assert.equal(saved.applePassword,undefined);
  assert.equal(saved.config.autoEnabled,false);
  assert.deepEqual(saved.config.calendarLinks,[]);
  assert.deepEqual(saved.state.pairs,[]);
});
test('disconnect without deletion keeps calendars; stale previews and failed deletions preserve connection',async()=>{
  const value=fixture('keep'),deleted=[],api=services(deleted);
  await context.run(value,async()=>{
    const preview=await disconnectPreview(api);
    await assert.rejects(disconnectApple({confirm:true,deleteCalendars:true,previewToken:'stale'},api),/изменился/);
    assert.equal(value.config.autoEnabled,true);
    await assert.rejects(disconnectApple({confirm:true,deleteCalendars:true,previewToken:preview.previewToken},{...api,deleteBitrixCalendar:async()=>{throw new Error('Provider unavailable');}}),/Provider unavailable/);
    assert.equal(value.applePassword,'secret');
    assert.equal(value.config.autoEnabled,false);
    await disconnectApple({confirm:true,deleteCalendars:false,previewToken:preview.previewToken},api);
  });
  assert.deepEqual(deleted,[]);
});
