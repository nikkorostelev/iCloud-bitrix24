import { createHash } from 'node:crypto';
import { account, saveAccount } from './config.mjs';
import { calendarLinks, inventory } from './calendars.mjs';
import { events, normalizeBitrix, createBitrix, updateBitrix } from './bitrix.mjs';
import { appleObjects, expandApple, createApple, updateApple } from './icloud.mjs';
import { plan, upsertPair, fingerprint } from './planner.mjs';

const busyAccounts = new Set();
export const isBusy = () => busyAccounts.has(account().id);
export async function exclusive(callback) {
  if (isBusy()) throw new Error('Синхронизация уже выполняется');
  const id = account().id;
  busyAccounts.add(id);
  try { return await callback(); } finally { account().state.syncProgress = null; busyAccounts.delete(id); }
}
export function previewSignature(data) {
  return createHash('sha256').update(JSON.stringify({
    horizonDays: account().config.horizonDays,
    groups: data.groups.map(group => ({
      link: group.link,
      events: [...group.bitrix, ...group.apple].map(e => [e.side, e.id, fingerprint(e), e.etag || '']).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
    })), pairs: account().state.pairs,
  })).digest('hex');
}
export async function snapshot({linkIds, revisions} = {}) {
  const value = account();
  const links = calendarLinks(value.config).filter(link => link.enabled && (!linkIds || linkIds.includes(link.id)));
  if (!links.length) throw new Error('Выберите календари для синхронизации');
  const data = await inventory();
  const from = Date.now() - 7 * 86400000;
  const to = Date.now() + (value.config.horizonDays || 30) * 86400000;
  const bitrixEvents = await events(links.map(link=>link.bitrixId), new Date(from).toISOString().slice(0,10), new Date(to).toISOString().slice(0,10));
  const groups = [];
  for (let offset=0; offset<links.length; offset+=3) {
    const batch = await Promise.all(links.slice(offset,offset+3).map(async (link, index) => {
    value.state.syncProgress = { phase: 'reading', calendarName: link.bitrixName, calendarsDone: offset+index, calendarsTotal: links.length, from, to };
    const calendar = data.apple.find(c => c.url === link.appleUrl);
    const section = data.bitrix.find(c => c.id === link.bitrixId);
    if (!calendar || !section) throw new Error(`Календарь недоступен: ${link.bitrixName || link.appleName || link.id}`);
    const a = await appleObjects(data.client, calendar, from, to, revisions?.[calendar.url]);
    const bitrix = bitrixEvents.filter(e=>String(e.SECTION_ID)===link.bitrixId).map(normalizeBitrix).filter(e => e.end >= from && e.start <= to);
    const apple = a.flatMap(object => expandApple(object, from, to));
    const idsB = new Set(bitrix.map(e => e.id)), idsA = new Set(apple.map(e => e.id));
    const state = { pairs: (value.state.pairs || []).filter(pair => (pair.calendarLinkId || 'legacy') === link.id && (idsB.has(pair.bitrixId) || idsA.has(pair.appleUrl))) };
    const actions = plan(bitrix, apple, state).map(action => ({ ...action, calendarName: section.name, calendarLinkId: link.id }));
    return { link, calendar, bitrix, apple, actions };
    }));
    groups.push(...batch);
  }
  return { client: data.client, groups, actions: groups.flatMap(g => g.actions), bitrixCount: groups.reduce((n,g)=>n+g.bitrix.length,0), appleCount: groups.reduce((n,g)=>n+g.apple.length,0) };
}
export async function runSync(expectedPreview = null, overrides = {}) {
  const providers = { snapshot, createApple, createBitrix, updateApple, updateBitrix, ...overrides };
  return exclusive(async () => {
    const value = account();
    let data;
    try { data = await providers.snapshot(); }
    catch (error) { value.state.syncProgress = null; throw error; }
    if (expectedPreview && previewSignature(data) !== expectedPreview) throw new Error('Календари изменились. Обновите предпросмотр');
    const results = [];
    const total = data.actions.filter(a => !['conflict', 'skip'].includes(a.kind)).length;
    value.state.syncProgress = { phase: 'writing', done: 0, total };
    value.state.initializedLinks ||= {};
    for (const group of data.groups) {
      const byB = new Map(group.bitrix.map(e => [e.id, e]));
      const byA = new Map(group.apple.map(e => [e.id, e]));
      let failed = false;
      for (const action of group.actions) {
        if (['conflict', 'skip'].includes(action.kind)) continue;
        value.state.syncProgress = { phase: 'writing', done: results.length, total, calendarName: action.calendarName, title: action.title };
        try {
          let b, a;
          if (action.kind === 'link') { b = byB.get(action.source.id); a = byA.get(action.target.id); }
          if (action.kind === 'createApple') { b = byB.get(action.source.id); a = { ...b, side: 'apple', id: await providers.createApple(data.client, group.calendar, b) }; }
          if (action.kind === 'createBitrix') { a = byA.get(action.source.id); b = { ...a, side: 'bitrix', id: await providers.createBitrix(a, group.link.bitrixId) }; }
          if (action.kind === 'updateApple') { b = byB.get(action.source.id); const target = byA.get(action.target.id); await providers.updateApple(data.client, target, b); a = { ...b, side: 'apple', id: target.id }; }
          if (action.kind === 'updateBitrix') { a = byA.get(action.source.id); const target = byB.get(action.target.id); await providers.updateBitrix(target.id, a, group.link.bitrixId); b = { ...a, side: 'bitrix', id: target.id }; }
          const scoped = { pairs: (value.state.pairs || []).filter(pair => (pair.calendarLinkId || 'legacy') === group.link.id) };
          upsertPair(scoped, b, a);
          value.state.pairs = [...(value.state.pairs || []).filter(pair => (pair.calendarLinkId || 'legacy') !== group.link.id), ...scoped.pairs.map(pair => ({ ...pair, calendarLinkId: group.link.id }))];
          await saveAccount(value);
          results.push({ kind: action.kind, title: action.title, start: action.source?.start, calendarName: action.calendarName, ok: true });
        } catch (error) {
          results.push({ kind: action.kind, title: action.title, start: action.source?.start, calendarName: action.calendarName, ok: false, error: error.message, code:error.code, retryAfterMs:error.retryAfterMs });
          failed = true; break;
        }
      }
      if (!failed) value.state.initializedLinks[group.link.id] = true;
    }
    value.state.lastRun = new Date().toISOString();
    if (results.length) value.state.lastResults = results;
    value.state.syncProgress = null;
    value.state.linkDiagnostics ||= {};
    for (const group of data.groups) value.state.linkDiagnostics[group.link.id] = {
      conflicts:group.actions.filter(a=>a.kind==='conflict').length,
      skipped:group.actions.filter(a=>a.kind==='skip').length,
    };
    value.state.lastConflicts = Object.values(value.state.linkDiagnostics).reduce((n,x)=>n+x.conflicts,0);
    value.state.lastSkipped = Object.values(value.state.linkDiagnostics).reduce((n,x)=>n+x.skipped,0);
    value.state.lastAutoError = results.find(r => !r.ok)?.error || null;
    value.state.lastAutoErrorCode = results.find(r => !r.ok)?.code || null;
    value.state.retryAfterMs = results.find(r => !r.ok)?.retryAfterMs || 0;
    if (!value.state.lastAutoError) value.state.lastSuccess = value.state.lastRun;
    await saveAccount(value);
    return { results, conflicts: value.state.lastConflicts, skipped: value.state.lastSkipped };
  });
}
