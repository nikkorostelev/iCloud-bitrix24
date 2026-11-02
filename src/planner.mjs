export function fingerprint(event) {
  return JSON.stringify([event.title.trim(), event.start, event.end, event.allDay, event.location.trim()]);
}

function identity(event) {
  return JSON.stringify([event.title.trim(), event.start, event.end, event.allDay]);
}

function concise(event) {
  return {
    side: event.side, id: event.id, title: event.title, start: event.start, end: event.end,
    allDay: event.allDay, location: event.location, isMeeting: event.isMeeting || false,
  };
}

export function plan(bitrix, apple, state) {
  const pairs = state.pairs || [];
  const linkedB = new Set(pairs.map(pair => pair.bitrixId));
  const linkedA = new Set(pairs.map(pair => pair.appleUrl));
  const byB = new Map(bitrix.map(event => [event.id, event]));
  const byA = new Map(apple.map(event => [event.id, event]));
  const actions = [];

  for (const pair of pairs) {
    const b = byB.get(pair.bitrixId);
    const a = byA.get(pair.appleUrl);
    if (!b && !a) continue;
    if (!b || !a) {
      actions.push({ kind: 'conflict', title: (b || a).title, reason: 'Связанное событие отсутствует на одной стороне; автоматического восстановления и удаления нет' });
      continue;
    }
    if (b.unsupported || a.unsupported) {
      actions.push({ kind: 'skip', title: b.title, reason: b.unsupported || a.unsupported });
      continue;
    }
    const bf = fingerprint(b), af = fingerprint(a);
    const bc = bf !== pair.bitrixFingerprint;
    const ac = af !== pair.appleFingerprint;
    if (bc && ac) actions.push({ kind: 'conflict', title: b.title, reason: 'Событие изменено в обоих календарях' });
    else if (bc) actions.push({ kind: 'updateApple', title: b.title, source: concise(b), target: concise(a) });
    else if (ac && b.isMeeting) actions.push({ kind: 'conflict', title: b.title, reason: 'Встреча Bitrix с участниками доступна только для чтения' });
    else if (ac) actions.push({ kind: 'updateBitrix', title: a.title, source: concise(a), target: concise(b) });
  }

  const unmatchedB = bitrix.filter(event => !linkedB.has(event.id));
  const unmatchedA = apple.filter(event => !linkedA.has(event.id));
  const matchedA = new Set();
  for (const b of unmatchedB) {
    if (b.unsupported) { actions.push({ kind: 'skip', title: b.title, reason: b.unsupported }); continue; }
    const candidates = unmatchedA.filter(a => !a.unsupported && !matchedA.has(a.id) && identity(a) === identity(b));
    if (candidates.length === 1) {
      matchedA.add(candidates[0].id);
      actions.push({ kind: 'link', title: b.title, source: concise(b), target: concise(candidates[0]) });
    } else if (candidates.length > 1) {
      actions.push({ kind: 'conflict', title: b.title, reason: 'Несколько одинаковых событий в iCloud; требуется ручная проверка' });
    } else actions.push({ kind: 'createApple', title: b.title, source: concise(b) });
  }
  for (const a of unmatchedA) {
    if (matchedA.has(a.id)) continue;
    if (a.unsupported) { actions.push({ kind: 'skip', title: a.title, reason: a.unsupported }); continue; }
    if (unmatchedB.some(b => !b.unsupported && identity(b) === identity(a))) continue;
    actions.push({ kind: 'createBitrix', title: a.title, source: concise(a) });
  }
  return actions;
}

export function upsertPair(state, bitrix, apple) {
  const pairs = state.pairs || [];
  const item = {
    bitrixId: bitrix.id, appleUrl: apple.id,
    bitrixFingerprint: fingerprint(bitrix), appleFingerprint: fingerprint(apple),
  };
  const index = pairs.findIndex(pair => pair.bitrixId === bitrix.id || pair.appleUrl === apple.id);
  if (index < 0) pairs.push(item); else pairs[index] = item;
  state.pairs = pairs;
}
