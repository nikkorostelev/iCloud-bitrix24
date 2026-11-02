import { randomUUID } from 'node:crypto';
import { accountIds, readAccount, context } from '../src/config.mjs';
import { b24, createBitrixCalendar, createBitrix, updateBitrix, events, normalizeBitrix } from '../src/bitrix.mjs';
import { appleClient, appleCalendars, createAppleCalendar, createApple, normalizeApple } from '../src/icloud.mjs';

if (!process.argv.includes('--live')) throw new Error('Use --live to test temporary calendars on the connected account');
const accounts = await accountIds();
if (accounts.length !== 1) throw new Error('Expected exactly one account for this personal deployment');
const value = await readAccount(accounts[0]);
await context.run(value, async () => {
  const name = `BZShow sync test ${randomUUID().slice(0,8)}`;
  const client = await appleClient(value.config.appleEmail);
  let bitrixId, appleUrl;
  try {
    bitrixId = await createBitrixCalendar(name, '#127f85');
    appleUrl = await createAppleCalendar(client, name, '#127f85');
    const all = await appleCalendars(client, true);
    const calendar = all.find(c=>c.url === appleUrl || c.displayName === name);
    if (!calendar) {
      const own = await client.propfind({url:appleUrl,props:{'d:displayname':{},'d:resourcetype':{},'c:supported-calendar-component-set':{}},depth:'0'});
      console.log(JSON.stringify({testCalendar:own.map(x=>({status:x.status,props:x.props})),listCount:all.length}));
      throw new Error('New Apple calendar not found');
    }
    console.log(JSON.stringify({canonicalUrlMatches:calendar.url === appleUrl}));
    appleUrl = calendar.url;
    const source = { title:name, start:Date.now()+3600000, end:Date.now()+7200000, allDay:false, location:'Sync test' };
    source.start = Math.floor(source.start / 60000) * 60000;
    source.end = source.start + 3600000;
    const eventId = await createBitrix(source, bitrixId);
    const raw = await events(bitrixId, new Date().toISOString().slice(0,10), new Date(Date.now()+86400000).toISOString().slice(0,10));
    const bitrix = raw.map(normalizeBitrix).find(e=>e.id === eventId);
    if (!bitrix || bitrix.start !== source.start || bitrix.unsupported) {
      const e=raw.find(e=>String(e.ID)===eventId);
      console.log(JSON.stringify({expected:source.start,actual:bitrix?.start,reason:bitrix?.unsupported,from:e?.DATE_FROM,to:e?.DATE_TO,ts:e?.DATE_FROM_TS_UTC,rrule:e?.RRULE,skip:e?.DT_SKIP_TIME}));
      throw new Error('Bitrix event time/format mismatch');
    }
    const url = await createApple(client, calendar, bitrix);
    const objects = await client.fetchCalendarObjects({calendar,objectUrls:[url]});
    const apple = objects.map(normalizeApple).find(e=>e?.id === url);
    if (!apple || apple.title !== name || apple.start !== source.start) throw new Error('Apple copy mismatch');
    await updateBitrix(eventId, {...apple,title:`${name} reverse`}, bitrixId);
    const verified = await b24('calendar.event.getbyid',{id:Number(eventId)});
    const target = Array.isArray(verified) ? verified[0] : verified;
    if (target.NAME !== `${name} reverse`) throw new Error('Reverse update mismatch');
    console.log('PASS: calendar creation and Bitrix -> iCloud -> Bitrix event round trip');
  } finally {
    const cleanupErrors=[];
    if (appleUrl) {
      try { const result=await client.deleteObject({url:appleUrl}); if (!result.ok) throw new Error(`HTTP ${result.status}`); }
      catch(e){cleanupErrors.push(`Apple test calendar ${appleUrl}: ${e.message}`);}
    }
    if (bitrixId) { try { await b24('calendar.section.delete',{type:'user',ownerId:value.user.id,id:Number(bitrixId)}); } catch(e){cleanupErrors.push(`Bitrix test calendar ${bitrixId}: ${e.message}`);} }
    if (cleanupErrors.length) throw new Error(cleanupErrors.join('; '));
    console.log('Temporary test calendars removed');
  }
});
