import test from 'node:test';
import assert from 'node:assert/strict';
import { DAVClient } from 'tsdav';
import { icalString, normalizeApple, icloudFetch, createAppleCalendar, normalizeApplePassword, appleClient } from '../src/icloud.mjs';

test('password paste accepts whitespace and typographic separators without accepting arbitrary passwords',()=>{
  assert.equal(normalizeApplePassword(' abcd\u2011efgh ijkl-mnop\n'), 'abcd-efgh-ijkl-mnop');
  assert.equal(normalizeApplePassword('abcdefghijklmnop'), 'abcd-efgh-ijkl-mnop');
  assert.throws(()=>normalizeApplePassword('not-a-code'), /16 букв/);
});

test('Apple HTTP 401 is not mistaken for an empty calendar list or repeatedly retried',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('',{status:401});});
  await assert.rejects(icloudFetch('https://caldav.icloud.com/',{method:'PROPFIND'}),e=>e.code==='ICLOUD_AUTH_REJECTED');
  const before=calls;
  await assert.rejects(appleClient('invalid@example.com','abcd-efgh-ijkl-mnop'),e=>e.code==='ICLOUD_AUTH_REJECTED');
  assert.ok(calls-before <= 4, `Too many authorization attempts: ${calls-before}`);
});

test('failed replacement credentials do not evict a working client',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('',{status:401}));
  t.mock.method(DAVClient.prototype,'login',async function(){
    if(this.credentials.password==='abcd-efgh-ijkl-mnop') {this.account={homeUrl:'https://caldav.icloud.com/home/'};return;}
    await this.fetchOverride('https://caldav.icloud.com/',{method:'PROPFIND'});
  });
  const good=await appleClient('cache-test@example.com','abcd-efgh-ijkl-mnop');
  await assert.rejects(appleClient('cache-test@example.com','aaaa-bbbb-cccc-dddd'),e=>e.code==='ICLOUD_AUTH_REJECTED');
  assert.equal(await appleClient('cache-test@example.com','abcd-efgh-ijkl-mnop'),good);
});

test('generated iCalendar event survives parsing with exact UTC times', () => {
  const source = {
    title: 'Тестовая встреча', start: Date.parse('2026-10-21T10:00:00Z'),
    end: Date.parse('2026-10-21T11:00:00Z'), allDay: false, location: 'Онлайн',
  };
  const text = icalString(source, 'test-bzshow-1');
  const parsed = normalizeApple({ data: text, url: 'https://example.com/event.ics', etag: '1' });
  assert.equal(parsed.title, source.title);
  assert.equal(parsed.start, source.start);
  assert.equal(parsed.end, source.end);
  assert.equal(parsed.location, source.location);
  assert.equal(parsed.unsupported, null);
  const withSeconds = normalizeApple({data:icalString({...source,start:source.start+15000}),url:'https://example.com/seconds.ics'});
  assert.match(withSeconds.unsupported, /секундами/);
});

test('CalDAV redirects preserve auth only between trusted iCloud hosts', async t => {
  const visited = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    visited.push({ host: url.hostname, auth: options.headers.get('authorization') });
    return visited.length === 1 ? new Response(null, { status: 301, headers: { location: 'https://p123-caldav.icloud.com/principal/' } }) : new Response('', { status: 207 });
  });
  const result = await icloudFetch('https://caldav.icloud.com/principal/', { headers: { authorization: 'Basic test' }, method: 'PROPFIND' });
  assert.equal(result.status, 207);
  assert.deepEqual(visited.map(v=>v.auth), ['Basic test','Basic test']);
});
test('CalDAV credentials never follow an untrusted redirect', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null, { status: 301, headers: { location: 'https://example.com/steal' } }); });
  await assert.rejects(icloudFetch('https://caldav.icloud.com/', { headers: { authorization: 'Basic test' } }), /Недоверенный/);
  assert.equal(calls, 1);
});

test('new Apple calendars are children of the home collection even without a trailing slash', async()=>{
  let requested;
  const client={account:{homeUrl:'https://caldav.icloud.com/account/calendars'},fetchCalendars:async()=>requested?[{url:requested.url,displayName:'Work'}]:[],makeCalendar:async params=>{requested=params;return[{status:201}];}};
  const url=await createAppleCalendar(client,'Work','#123456');
  assert.ok(url.startsWith('https://caldav.icloud.com/account/calendars/'));
  assert.equal(requested.props['d:displayname'],'Work');
  assert.equal(requested.props['ca:calendar-color'],'#123456FF');
});
