import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, upsertPair } from '../src/planner.mjs';

const b = { side: 'bitrix', id: '1', title: 'Встреча', start: 1000, end: 2000, allDay: false, location: '', isMeeting: false };
const a = { side: 'apple', id: 'https://example/1.ics', title: 'Встреча', start: 1000, end: 2000, allDay: false, location: '' };

test('existing identical events are linked rather than duplicated', () => {
  assert.equal(plan([b], [a], { pairs: [] })[0].kind, 'link');
});

test('unpaired events create on opposite side', () => {
  assert.deepEqual(plan([b], [], { pairs: [] }).map(x => x.kind), ['createApple']);
  assert.deepEqual(plan([], [a], { pairs: [] }).map(x => x.kind), ['createBitrix']);
});

test('one-sided change updates other side; two-sided change conflicts', () => {
  const state = { pairs: [] };
  upsertPair(state, b, a);
  assert.equal(plan([{ ...b, title: 'Новая' }], [a], state)[0].kind, 'updateApple');
  assert.equal(plan([b], [{ ...a, title: 'Новая' }], state)[0].kind, 'updateBitrix');
  assert.equal(plan([{ ...b, title: 'Б' }], [{ ...a, title: 'А' }], state)[0].kind, 'conflict');
});

test('unsupported and missing linked events do not get rewritten', () => {
  const state = { pairs: [] };
  upsertPair(state, b, a);
  assert.equal(plan([], [a], state)[0].kind, 'conflict');
  assert.equal(plan([{ ...b, unsupported: 'repeat' }], [], { pairs: [] })[0].kind, 'skip');
});
