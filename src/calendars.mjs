import { randomUUID } from 'node:crypto';
import { account, saveAccount } from './config.mjs';
import { sections, createBitrixCalendar } from './bitrix.mjs';
import { appleClient, appleCalendars, createAppleCalendar } from './icloud.mjs';

export function calendarLinks(config) {
  if (Array.isArray(config.calendarLinks)) return config.calendarLinks;
  return config.sectionId && config.calendarUrl ? [{ id: 'legacy', bitrixId: String(config.sectionId), appleUrl: config.calendarUrl, enabled: true }] : [];
}
export async function inventory() {
  const value = account();
  const client = await appleClient(value.config.appleEmail);
  const [bitrix, apple] = await Promise.all([sections(), appleCalendars(client)]);
  return { client, bitrix, apple };
}
export function validateSelection(existing, changes, additions, bitrix, apple) {
  if (!Array.isArray(changes) || !Array.isArray(additions) || additions.length > 100) throw new Error('Неверный список календарей');
  const known = new Map(existing.map(link => [link.id, link]));
  const changed = new Set();
  for (const change of changes) {
    if (!known.has(change.id) || typeof change.enabled !== 'boolean' || changed.has(change.id)) throw new Error('Неверная связь календарей');
    changed.add(change.id);
  }
  const usedB = new Set(existing.map(link => link.bitrixId));
  const usedA = new Set(existing.map(link => link.appleUrl));
  for (const addition of additions) {
    if (!['bitrix', 'apple'].includes(addition.side)) throw new Error('Неверный источник календаря');
    const source = addition.side === 'bitrix' ? bitrix.find(x => x.id === addition.sourceId) : apple.find(x => x.url === addition.sourceId);
    const target = addition.targetId ? (addition.side === 'bitrix' ? apple.find(x => x.url === addition.targetId) : bitrix.find(x => x.id === addition.targetId)) : null;
    if (!source || (addition.targetId && !target)) throw new Error('Календарь больше недоступен');
    const b = addition.side === 'bitrix' ? source.id : target?.id;
    const a = addition.side === 'apple' ? source.url : target?.url;
    if ((b && usedB.has(b)) || (a && usedA.has(a))) throw new Error('Один календарь нельзя связать с несколькими календарями');
    if (b) usedB.add(b);
    if (a) usedA.add(a);
  }
}
export async function saveDeferredPreferences({links = [], bitrixIds = [], horizonDays}, services = {sections}) {
  const value = account();
  const days = Number(horizonDays);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Горизонт должен быть от 1 до 365 дней');
  if (!Array.isArray(bitrixIds) || bitrixIds.length > 100 || new Set(bitrixIds).size !== bitrixIds.length) throw new Error('Неверный список календарей');
  const owned = await services.sections();
  const current = calendarLinks(value.config).map(link=>({...link}));
  validateSelection(current,links,bitrixIds.map(sourceId=>({side:'bitrix',sourceId})),owned,[]);
  for (const change of links) current.find(link=>link.id===change.id).enabled=change.enabled;
  value.config.calendarLinks=current;
  value.config.pendingBitrixIds=[...bitrixIds];
  value.config.horizonDays=days;
  await saveAccount(value);
  return {ok:true,deferred:true};
}
export async function configureCalendars({ links = [], additions = [], horizonDays }, services = { inventory, createBitrixCalendar, createAppleCalendar }) {
  const value = account();
  const days = Number(horizonDays);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Горизонт должен быть от 1 до 365 дней');
  const data = await services.inventory();
  let current = calendarLinks(value.config).map(link => ({ ...link }));
  validateSelection(current, links, [], data.bitrix, data.apple);
  for (const change of links) {
    if (change.remove) {
      if ((value.state.pairs || []).some(pair => (pair.calendarLinkId || 'legacy') === change.id)) throw new Error('У календарей уже есть связанные события. Отключите синхронизацию переключателем');
      current = current.filter(link => link.id !== change.id);
    } else current.find(link => link.id === change.id).enabled = change.enabled;
  }
  validateSelection(current, [], additions, data.bitrix, data.apple);
  value.config.calendarLinks = current;
  value.config.horizonDays = days;
  for (const addition of additions) {
    const b = addition.side === 'bitrix' ? data.bitrix.find(x => x.id === addition.sourceId) : data.bitrix.find(x => x.id === addition.targetId);
    const a = addition.side === 'apple' ? data.apple.find(x => x.url === addition.sourceId) : data.apple.find(x => x.url === addition.targetId);
    const bitrixId = b?.id || await services.createBitrixCalendar(String(a.displayName || 'iCloud'), a.calendarColor);
    const appleUrl = a?.url || await services.createAppleCalendar(data.client, b.name, b.color);
    current.push({ id: randomUUID(), bitrixId, appleUrl, bitrixName: b?.name || String(a.displayName), appleName: a ? String(a.displayName) : b.name, createdBitrix: !b, createdApple: !a, origin: addition.side, enabled: true });
    if (addition.side === 'bitrix') value.config.pendingBitrixIds=(value.config.pendingBitrixIds || []).filter(id=>id!==addition.sourceId);
    // Persist each created calendar mapping so a later failure cannot repeat it.
    await saveAccount(value);
  }
  value.config.pendingBitrixIds=[];
  value.state.initializedLinks ||= {};
  if (value.state.lastRun) value.state.initializedLinks.legacy = true;
  await saveAccount(value);
  return current;
}
