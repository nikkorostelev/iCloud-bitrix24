import test from 'node:test';
import assert from 'node:assert/strict';
import { expandApple } from '../src/icloud.mjs';
import { plan, upsertPair } from '../src/planner.mjs';

const object = lines => ({ url: 'https://caldav.icloud.com/test.ics', data: ['BEGIN:VCALENDAR','VERSION:2.0',...lines,'END:VCALENDAR'].join('\r\n') });
const master = ['BEGIN:VEVENT','UID:series','DTSTART:20200101T090000Z','DTEND:20200101T100000Z','SUMMARY:Planning','RRULE:FREQ=DAILY','EXDATE:20261103T090000Z','END:VEVENT'];
const from = Date.parse('2026-11-01T00:00:00Z'), to = Date.parse('2026-11-05T23:59:00Z');

test('old recurring masters expand inside the window with stable identities and exclusions', () => {
  const rows = expandApple(object(master), from, to);
  assert.equal(rows.length, 4);
  assert.equal(new Date(rows[0].start).toISOString(), '2026-11-01T09:00:00.000Z');
  assert.ok(rows.every(e => e.sourceOnly && !e.unsupported));
  assert.equal(new Set(rows.map(e => e.id)).size, 4);
  assert.equal(expandApple(object(master), from + 86400000, to)[0].id, rows[1].id);
});

test('moved and cancelled exceptions replace the original occurrence, including moves into the window', () => {
  const data = object([...master,
    'BEGIN:VEVENT','UID:series','RECURRENCE-ID:20261102T090000Z','DTSTART:20261102T120000Z','DTEND:20261102T130000Z','SUMMARY:Moved','END:VEVENT',
    'BEGIN:VEVENT','UID:series','RECURRENCE-ID:20261104T090000Z','DTSTART:20261104T090000Z','DTEND:20261104T100000Z','STATUS:CANCELLED','END:VEVENT',
    'BEGIN:VEVENT','UID:series','RECURRENCE-ID:20261109T090000Z','DTSTART:20261105T150000Z','DTEND:20261105T160000Z','SUMMARY:Moved in','END:VEVENT']);
  const rows = expandApple(data, from, to);
  assert.equal(rows.length, 4);
  const moved = rows.find(e => e.title === 'Moved');
  assert.equal(new Date(moved.start).getUTCHours(), 12);
  assert.ok(moved.id.includes('2026-11-02T09'));
  assert.equal(rows.filter(e => e.title === 'Moved in').length, 1);
});

test('COUNT and RDATE are honored, and malformed data fails instead of silently disappearing', () => {
  const finite = master.filter(l => !l.startsWith('RRULE:')).map(l => l.startsWith('DTSTART:') ? 'DTSTART:20261101T090000Z' : l.startsWith('DTEND:') ? 'DTEND:20261101T100000Z' : l);
  finite.splice(-1, 0, 'RRULE:FREQ=DAILY;COUNT=2','RDATE:20261105T090000Z');
  assert.equal(expandApple(object(finite), from, to).length, 3);
  assert.throws(() => expandApple({data:'invalid'}, from, to));
});

test('recurrence copies update from Apple but never rewrite the Apple master from Bitrix', () => {
  const a = expandApple(object(master), from, to)[0];
  const b = {...a, side:'bitrix', id:'1', sourceOnly:false};
  const state = {pairs:[]}; upsertPair(state,b,a);
  assert.equal(plan([b],[{...a,title:'Changed in Apple'}],state)[0].kind, 'updateBitrix');
  assert.equal(plan([{...b,title:'Changed in Bitrix'}],[a],state)[0].kind, 'conflict');
  assert.equal(plan([b],[a],state).length, 0);
});

test('embedded timezones preserve local meeting time across daylight saving transitions', () => {
  const rows = expandApple(object([
    'BEGIN:VTIMEZONE','TZID:Europe/Berlin',
    'BEGIN:STANDARD','DTSTART:19701025T030000','TZOFFSETFROM:+0200','TZOFFSETTO:+0100','RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU','END:STANDARD',
    'BEGIN:DAYLIGHT','DTSTART:19700329T020000','TZOFFSETFROM:+0100','TZOFFSETTO:+0200','RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU','END:DAYLIGHT','END:VTIMEZONE',
    'BEGIN:VEVENT','UID:dst','DTSTART;TZID=Europe/Berlin:20261024T090000','DTEND;TZID=Europe/Berlin:20261024T100000','RRULE:FREQ=DAILY;COUNT=3','SUMMARY:DST','END:VEVENT'
  ]), Date.parse('2026-10-24T00:00:00Z'), Date.parse('2026-10-27T00:00:00Z'));
  assert.deepEqual(rows.map(e => new Date(e.start).getUTCHours()), [7,8,8]);
});

test('THISANDFUTURE backward shifts include later original dates moved into the window', () => {
  const rows = expandApple(object([
    'BEGIN:VEVENT','UID:range','DTSTART:20261101T090000Z','DTEND:20261101T100000Z','RRULE:FREQ=DAILY;COUNT=10','SUMMARY:Original','END:VEVENT',
    'BEGIN:VEVENT','UID:range','RECURRENCE-ID;RANGE=THISANDFUTURE:20261106T090000Z','DTSTART:20261104T090000Z','DTEND:20261104T100000Z','SUMMARY:Shifted','END:VEVENT'
  ]), from, to);
  assert.equal(rows.filter(e => e.title === 'Shifted').length, 2);
  assert.equal(new Set(rows.map(e=>e.id)).size, rows.length);
});
