import { randomUUID, createHash } from 'node:crypto';
import { DAVClient } from 'tsdav';
import ICAL from 'ical.js';
import { getApplePassword, context, saveAccount } from './config.mjs';
import { fingerprint } from './planner.mjs';

const clients = new Map();
export function forgetAppleClients() {
  for (const [key, entry] of clients) if (entry.accountId === context.getStore()?.id) clients.delete(key);
}
export function normalizeApplePassword(password) {
  const letters = String(password || '').replace(/\s/g, '').replace(/[-\u2010-\u2015\u2212]/g, '');
  if (!/^[a-z]{16}$/i.test(letters)) throw new Error('Проверьте формат пароля приложения Apple: 16 букв, обычно xxxx-xxxx-xxxx-xxxx. Можно включить «Показать пароль».');
  return letters.match(/.{4}/g).join('-');
}
function authenticationError() {
  const error = new Error('Apple отклонил авторизацию CalDAV (401). Это не позволяет определить причину: проверьте Apple ID и вставку пароля, затем повторите подключение позже. Сохранённые настройки не удалены.');
  error.code = 'ICLOUD_AUTH_REJECTED';
  return error;
}
export async function icloudFetch(input, init = {}) {
  let url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const headers = new Headers(init.headers || input.headers);
  for (let hop = 0; hop < 6; hop++) {
    if (url.protocol !== 'https:' || !/^(caldav|p\d+-caldav)\.icloud\.com$/.test(url.hostname) || url.port || url.username || url.password) throw new Error('Недоверенный адрес CalDAV iCloud');
    const response = await fetch(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    if (response.status === 401) { await response.body?.cancel(); throw authenticationError(); }
    if ([429, 503].includes(response.status)) {
      const retry = response.headers.get('retry-after');
      const seconds = Number(retry);
      const error = new Error(`iCloud временно ограничил запросы (HTTP ${response.status}). Обмен повторится автоматически.`);
      error.code = 'ICLOUD_RATE_LIMITED';
      error.retryAfterMs = Math.min(3600000, Math.max(5000, retry ? Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now() || 30000 : 30000));
      await response.body?.cancel(); throw error;
    }
    if (![301,302,307,308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    await response.body?.cancel();
    url = new URL(location, url);
  }
  throw new Error('Слишком много перенаправлений iCloud');
}
export async function appleClient(email, password = getApplePassword(email)) {
  if (!email || !password) throw new Error('Укажите Apple ID и пароль для приложения');
  password = normalizeApplePassword(password);
  const value = context.getStore();
  const cacheKey = createHash('sha256').update(JSON.stringify([value?.id || '', email, password])).digest('hex');
  const existing = clients.get(cacheKey);
  if (existing?.expiresAt > Date.now()) return existing.promise;
  let authRejected = false;
  const client = new DAVClient({
    serverUrl: 'https://caldav.icloud.com',
    credentials: { username: email, password },
    authMethod: 'Basic', defaultAccountType: 'caldav',
    fetch: async (...args) => { try { return await icloudFetch(...args); } catch (error) { if (error.code === 'ICLOUD_AUTH_REJECTED') authRejected = true; throw error; } },
  });
  const promise = (async () => {
    const remembered = value?.config.appleDiscovery;
    if (remembered?.email === email) {
      await client.authenticate(true);
      client.account = { accountType:'caldav', serverUrl:'https://caldav.icloud.com', rootUrl:remembered.rootUrl, homeUrl:remembered.homeUrl, principalUrl:remembered.principalUrl };
      try {
        const calendars = await client.fetchCalendars();
        calendarCache.set(client,{expiresAt:Date.now()+60000,value:calendars});
        return client;
      } catch (error) { if (authRejected) throw authenticationError(); if (error.code === 'ICLOUD_RATE_LIMITED') throw error; client.account = undefined; }
    }
    let lastError;
    for (let attempt=0;attempt<3;attempt++) {
      try {
        await client.login({loadCollections:false});
        if (value) {
          value.config.appleDiscovery={email,rootUrl:client.account.rootUrl,homeUrl:client.account.homeUrl,principalUrl:client.account.principalUrl};
          await saveAccount(value);
        }
        return client;
      } catch (error) { if (authRejected) throw authenticationError(); if (error.code === 'ICLOUD_RATE_LIMITED') throw error; lastError=error; if(attempt<2) await new Promise(resolve=>setTimeout(resolve,700*(attempt+1))); }
    }
    if (/cannot find (homeUrl|principalUrl)/i.test(lastError?.message || '')) {
      throw new Error('Apple не вернул адрес календарей. Проверьте подключение и повторите позже; если ошибка сохраняется, подключите iCloud заново с паролем приложения.');
    }
    throw lastError;
  })().catch(error => { if (clients.get(cacheKey)?.promise === promise) clients.delete(cacheKey); throw error; });
  for (const [key, entry] of clients) if (entry.expiresAt <= Date.now()) clients.delete(key);
  clients.set(cacheKey, { promise, accountId: value?.id, expiresAt: Date.now() + 5 * 60000 });
  return promise;
}

export async function createAppleCalendar(client, name, color) {
  if (!client.account?.homeUrl) throw new Error('Не найден адрес календарей iCloud');
  const before = new Set((await appleCalendars(client)).map(c=>c.url));
  const home = client.account.homeUrl.endsWith('/') ? client.account.homeUrl : `${client.account.homeUrl}/`;
  const url = new URL(`${randomUUID()}/`, home).href;
  const result = await client.makeCalendar({ url, props: {
    'd:displayname': name,
    'c:supported-calendar-component-set': { 'c:comp': { _attributes: { name: 'VEVENT' } } },
    ...(color ? { 'ca:calendar-color': color.length === 7 ? `${color}FF` : color } : {}),
  } });
  if (!result.length || result.some(item => item.status < 200 || item.status >= 300)) throw new Error('iCloud не разрешил создание календаря');
  calendarCache.delete(client);
  const calendars = await appleCalendars(client, true);
  const created = calendars.find(c=>new URL(c.url).pathname.toLowerCase() === new URL(url).pathname.toLowerCase())
    || calendars.find(c=>!before.has(c.url) && String(c.displayName) === name);
  if (!created) throw new Error('Календарь создан, но iCloud ещё не вернул его адрес. Обновите список календарей');
  return created.url;
}

const calendarCache = new WeakMap();
export async function appleCalendars(client, force = false) {
  const cached = calendarCache.get(client);
  if (!force && cached?.expiresAt > Date.now()) return cached.value;
  const calendars = await client.fetchCalendars();
  const value = calendars.filter(calendar => !calendar.components?.length || calendar.components.includes('VEVENT'));
  calendarCache.set(client, { expiresAt: Date.now() + 60000, value });
  return value;
}

export async function appleRevisions(client) {
  const responses = await client.propfind({url:client.account.homeUrl,depth:'1',props:{
    'd:resourcetype':{},'cs:getctag':{},'d:sync-token':{},
  }});
  const revisions = {};
  const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : value?._cdata ?? value?._text;
  for (const response of responses) {
    if (!response.ok || !response.href || !response.props?.resourcetype) throw new Error('iCloud не вернул состояние календарей');
    if (!Object.hasOwn(response.props.resourcetype, 'calendar')) continue;
    const url = new URL(response.href, client.account.rootUrl).href;
    revisions[url] = text(response.props.syncToken) || text(response.props.getctag) || null;
  }
  return revisions;
}

const objectCache = new WeakMap();
export async function appleObjects(client, calendar, from, to, revision) {
  const cache = objectCache.get(client) || new Map();
  const previous = cache.get(calendar.url);
  if (revision && previous?.revision === revision && previous.from <= from && previous.to >= to) return previous.objects;
  // Cache only revision-checked worker reads, with a day of window coverage for rolling boundaries.
  const requestedFrom = revision ? Math.floor(from / 86400000) * 86400000 : from;
  const requestedTo = revision ? Math.ceil(to / 86400000) * 86400000 : to;
  const objects = await client.fetchCalendarObjects({
    calendar,
    timeRange: { start: new Date(requestedFrom).toISOString(), end: new Date(requestedTo).toISOString() },
  });
  if (revision) {cache.set(calendar.url,{revision,from:requestedFrom,to:requestedTo,objects});objectCache.set(client,cache);}
  return objects;
}

export function normalizeApple(object) {
  try {
    const component = new ICAL.Component(ICAL.parse(object.data));
    const vevent = component.getFirstSubcomponent('vevent');
    if (!vevent) return null;
    const event = new ICAL.Event(vevent);
    const start = event.startDate.toJSDate().getTime();
    const end = event.endDate.toJSDate().getTime();
    const unsupported = event.startDate.isDate ? 'Событие на весь день пока не переносится'
      : start % 60000 || end % 60000 ? 'Bitrix24 поддерживает время с точностью до минуты; событие с секундами пропущено'
      : vevent.getFirstProperty('rrule') || vevent.getFirstProperty('recurrence-id')
      || vevent.getAllProperties('attendee').length || !Number.isFinite(start) || !Number.isFinite(end)
      ? 'Повторяющееся событие или приглашение' : null;
    return {
      side: 'apple', id: object.url, title: event.summary || '', start, end,
      allDay: event.startDate.isDate, location: vevent.getFirstPropertyValue('location') || '',
      unsupported, etag: object.etag, object,
    };
  } catch { return null; }
}

export function expandApple(object, from, to) {
  const root = new ICAL.Component(ICAL.parse(object.data));
  const components = root.getAllSubcomponents('vevent');
  const masters = components.filter(c => !c.hasProperty('recurrence-id'));
  const output = [];
  const append = (event, startDate, endDate, recurrenceId) => {
    if (event.component.getFirstPropertyValue('status') === 'CANCELLED') return;
    const start = startDate.toJSDate().getTime(), end = endDate.toJSDate().getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('Некорректная дата iCloud');
    if (end < from || start > to) return;
    const unsupported = startDate.isDate ? 'Событие на весь день пока не переносится'
      : start % 60000 || end % 60000 ? 'Bitrix24 поддерживает время с точностью до минуты; событие с секундами пропущено'
      : event.component.hasProperty('attendee') ? 'Приглашение iCloud пока не переносится' : null;
    output.push({ side: 'apple', id: recurrenceId ? `${object.url}#occurrence=${encodeURIComponent(recurrenceId.toString())}` : object.url,
      title: event.summary || '', start, end, allDay: startDate.isDate,
      location: event.component.getFirstPropertyValue('location') || '', unsupported,
      sourceOnly: !!recurrenceId, etag: object.etag, object });
  };
  for (const component of masters) {
    const event = new ICAL.Event(component, { exceptions: components.filter(c => c.hasProperty('recurrence-id') && c.getFirstPropertyValue('uid') === component.getFirstPropertyValue('uid')) });
    if (!event.isRecurring()) { append(event, event.startDate, event.endDate); continue; }
    const seen = new Set();
    const iterator = event.iterator();
    const backwardShift = Math.max(0, ...Object.values(event.exceptions)
      .filter(exception => exception.component.getFirstProperty('recurrence-id')?.getParameter('range') === 'THISANDFUTURE')
      .map(exception => exception.recurrenceId.toJSDate().getTime() - exception.startDate.toJSDate().getTime()));
    // Start at the original DTSTART so COUNT, EXDATE and recurrence identities remain correct.
    for (let count = 0; ; count++) {
      if (count >= 200000) throw new Error('Слишком большая серия повторов iCloud');
      const occurrence = iterator.next();
      if (!occurrence || occurrence.toJSDate().getTime() > to + backwardShift) break;
      const details = event.getOccurrenceDetails(occurrence);
      seen.add(occurrence.toString());
      append(details.item, details.startDate, details.endDate, occurrence);
    }
    // An exception may move into the window from an original date beyond its end.
    for (const exception of Object.values(event.exceptions)) {
      if (!seen.has(exception.recurrenceId.toString()) && !excluded(component,exception.recurrenceId)) append(exception, exception.startDate, exception.endDate, exception.recurrenceId);
    }
  }
  for (const component of components.filter(c => c.hasProperty('recurrence-id') && !masters.some(m => m.getFirstPropertyValue('uid') === c.getFirstPropertyValue('uid')))) {
    const event = new ICAL.Event(component);
    append(event, event.startDate, event.endDate, event.recurrenceId);
  }
  return output;
}

export function icalString(event, uid = randomUUID()) {
  const root = new ICAL.Component(['vcalendar', [], []]);
  root.updatePropertyWithValue('version', '2.0');
  root.updatePropertyWithValue('prodid', '-//BZShow iCloud Sync//EN');
  const vevent = new ICAL.Component('vevent');
  vevent.updatePropertyWithValue('uid', uid);
  vevent.updatePropertyWithValue('summary', event.title);
  vevent.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
  const start = ICAL.Time.fromJSDate(new Date(event.start), true);
  const end = ICAL.Time.fromJSDate(new Date(event.end), true);
  if (event.allDay) { start.isDate = true; end.isDate = true; }
  vevent.updatePropertyWithValue('dtstart', start);
  vevent.updatePropertyWithValue('dtend', end);
  if (event.location) vevent.updatePropertyWithValue('location', event.location);
  root.addSubcomponent(vevent);
  return root.toString();
}

export async function createApple(client, calendar, event) {
  const filename = `${randomUUID()}.ics`;
  const response = await client.createCalendarObject({ calendar, filename, iCalString: icalString(event) });
  objectCache.delete(client);
  if (!response.ok) throw new Error(`iCloud: создание события вернуло HTTP ${response.status}`);
  return new URL(filename, calendar.url).href;
}

export async function updateApple(client, event, source) {
  if (event.sourceOnly) throw new Error('Копию повтора изменяйте в исходном календаре iCloud');
  const component = new ICAL.Component(ICAL.parse(event.object.data));
  const vevent = component.getFirstSubcomponent('vevent');
  vevent.updatePropertyWithValue('summary', source.title);
  const start = ICAL.Time.fromJSDate(new Date(source.start), true);
  const end = ICAL.Time.fromJSDate(new Date(source.end), true);
  if (source.allDay) { start.isDate = true; end.isDate = true; }
  vevent.updatePropertyWithValue('dtstart', start);
  vevent.updatePropertyWithValue('dtend', end);
  if (source.location) vevent.updatePropertyWithValue('location', source.location);
  else vevent.removeAllProperties('location');
  const response = await client.updateCalendarObject({ calendarObject: {
    url: event.id, etag: event.etag, data: component.toString(),
  } });
  objectCache.delete(client);
  if (!response.ok) throw new Error(`iCloud: обновление события вернуло HTTP ${response.status}`);
}

function excluded(master, recurrenceId) {
  return master.getAllProperties('exdate').some(p=>p.getValues().some(time=>time.compare(recurrenceId)===0));
}

function occurrenceInObject(object, key) {
  const root = new ICAL.Component(ICAL.parse(object.data));
  if (!root.getFirstSubcomponent('vevent')) throw new Error('iCloud вернул неполную серию повторов');
  const master = root.getAllSubcomponents('vevent').find(c=>!c.hasProperty('recurrence-id'));
  if (!master) {
    const exception = root.getAllSubcomponents('vevent').find(c=>c.getFirstPropertyValue('recurrence-id')?.toString()===key);
    if (!exception) return null;
    const event = new ICAL.Event(exception);
    return {event,startDate:event.startDate,endDate:event.endDate,recurrenceId:event.recurrenceId};
  }
  const event = new ICAL.Event(master);
  if (master.getFirstPropertyValue('status')==='CANCELLED') return null;
  const wanted = ICAL.Time.fromString(key);
  if (wanted.zone.tzid==='floating') wanted.zone=event.startDate.zone;
  if (excluded(master,wanted)) return null;
  const exception = Object.values(event.exceptions).find(e=>e.recurrenceId.toString()===key);
  if (exception) return {event:exception,startDate:exception.startDate,endDate:exception.endDate,recurrenceId:exception.recurrenceId};
  if (!event.isRecurring()) return null;
  const iterator=event.iterator();
  for (let count=0;count<200000;count++) {
    const occurrence=iterator.next();
    if (!occurrence || occurrence.compare(wanted)>0) return null;
    if (occurrence.toString()===key) {
      const d=event.getOccurrenceDetails(occurrence);
      return {event:d.item,startDate:d.startDate,endDate:d.endDate,recurrenceId:occurrence};
    }
  }
  throw new Error('Слишком большая серия повторов iCloud');
}

export async function lookupApple(client, id, cache = new Map()) {
  const url = new URL(id);
  const key = url.hash.startsWith('#occurrence=') ? decodeURIComponent(url.hash.slice(12)) : null;
  url.hash='';
  if (!cache.has(url.href)) cache.set(url.href, (async()=>{
    const response=await icloudFetch(url.href,{method:'GET',headers:client.authHeaders});
    if ([404,410].includes(response.status)) {await response.body?.cancel();return null;}
    if (!response.ok) {await response.body?.cancel();throw new Error(`iCloud: проверка события вернула HTTP ${response.status}`);}
    return {url:url.href,etag:response.headers.get('etag'),data:await response.text()};
  })());
  const object=await cache.get(url.href);
  if (!object) return null;
  if (!key) {
    const root=new ICAL.Component(ICAL.parse(object.data));
    const component=root.getFirstSubcomponent('vevent');
    if (!component) throw new Error('iCloud вернул неполное событие');
    if (component.getFirstPropertyValue('status')==='CANCELLED') return null;
    const result=normalizeApple(object);
    if (!result) throw new Error('iCloud вернул некорректное событие');
    return {...result,id};
  }
  const d=occurrenceInObject(object,key);
  if (!d || d.event.component.getFirstPropertyValue('status')==='CANCELLED') return null;
  const start=d.startDate.toJSDate().getTime(),end=d.endDate.toJSDate().getTime();
  if (!Number.isFinite(start)||!Number.isFinite(end)) throw new Error('iCloud вернул некорректную дату повтора');
  return {side:'apple',id,title:d.event.summary||'',start,end,allDay:d.startDate.isDate,
    location:d.event.component.getFirstPropertyValue('location')||'',sourceOnly:true,object,etag:object.etag,recurrenceId:d.recurrenceId,
    unsupported:d.startDate.isDate || start%60000 || end%60000 || d.event.component.hasProperty('attendee') ? 'Неподдерживаемое вхождение повтора' : null};
}

export async function deleteApple(client, expected) {
  const current=await lookupApple(client,expected.id);
  if (!current) return;
  if (current.unsupported || fingerprint(current)!==fingerprint(expected) || !current.etag) throw new Error('Событие iCloud изменилось или не вернуло ETag. Удаление остановлено');
  let response;
  if (!current.sourceOnly) response=await client.deleteCalendarObject({calendarObject:{url:current.object.url,etag:current.etag}});
  else {
    const root=new ICAL.Component(ICAL.parse(current.object.data));
    const master=root.getAllSubcomponents('vevent').find(c=>!c.hasProperty('recurrence-id'));
    if (master) {
      const property=new ICAL.Property('exdate');property.setValue(current.recurrenceId.clone());
      const zone=current.recurrenceId.zone.tzid;
      if (!['UTC','floating'].includes(zone)) property.setParameter('tzid',zone);
      master.addProperty(property);
    }
    for (const c of root.getAllSubcomponents('vevent')) if (c.getFirstPropertyValue('recurrence-id')?.toString()===current.recurrenceId.toString() && c.getFirstProperty('recurrence-id')?.getParameter('range')!=='THISANDFUTURE') root.removeSubcomponent(c);
    response = root.getAllSubcomponents('vevent').length
      ? await client.updateCalendarObject({calendarObject:{...current.object,data:root.toString()}})
      : await client.deleteCalendarObject({calendarObject:current.object});
  }
  objectCache.delete(client);
  if (!response.ok && ![404,410].includes(response.status)) throw new Error(`iCloud: удаление вернуло HTTP ${response.status}`);
}
