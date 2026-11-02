import { oauthCall } from './auth.mjs';
import { account } from './config.mjs';
import { fingerprint } from './planner.mjs';

export async function b24(method, params = {}) {
  return oauthCall(method, params);
}

export async function profile() {
  const result = await b24('profile');
  if (!result || !Number(result.ID)) throw new Error('Не удалось определить пользователя Битрикс24');
  return {
    id: Number(result.ID), name: [result.NAME, result.LAST_NAME].filter(Boolean).join(' '),
    timeZone: result.TIME_ZONE || 'Europe/Moscow',
  };
}

export async function sections() {
  const user = account().user;
  const result = await b24('calendar.section.get', { type: 'user', ownerId: user.id });
  return result.filter(section => Number(section.OWNER_ID) === user.id)
    .map(section => ({ id: String(section.ID), name: section.NAME, color: section.COLOR || '#127f85', external: !!section.EXTERNAL_TYPE }));
}

export async function createBitrixCalendar(name, color) {
  const user = account().user;
  return String(await b24('calendar.section.add', { type: 'user', ownerId: user.id, name, color: color?.slice(0, 7) || '#127f85' }));
}

export async function deleteBitrixCalendar(id) {
  const owned = await sections();
  if (!owned.some(section => section.id === String(id))) throw new Error('Календарь недоступен для удаления');
  await b24('calendar.section.delete', {type:'user',ownerId:account().user.id,id:Number(id)});
}

export async function events(sectionId, from, to) {
  const user = account().user;
  const ids = new Set((Array.isArray(sectionId) ? sectionId : [sectionId]).map(String));
  const result = await b24('calendar.event.get', {
    type: 'user', ownerId: user.id, section: [...ids].map(Number), from, to,
  });
  return result.filter(event => ids.has(String(event.SECTION_ID)) && event.DELETED !== 'Y');
}

export async function lookupBitrix(id, sectionId) {
  const event = await b24('calendar.event.getbyid', {id:Number(id)});
  if (event === null) return null;
  if (!event || Array.isArray(event) || String(event.ID)!==String(id)) throw new Error('Битрикс24 не подтвердил состояние события');
  if (event.CAL_TYPE !== 'user' || Number(event.OWNER_ID)!==account().user.id || String(event.SECTION_ID)!==String(sectionId)) throw new Error('Событие перемещено или больше не принадлежит выбранному календарю');
  return event.DELETED === 'Y' ? null : normalizeBitrix(event);
}

export async function deleteBitrix(event, sectionId) {
  const current = await lookupBitrix(event.id, sectionId);
  if (!current) return;
  if (current.unsupported || current.isMeeting || fingerprint(current)!==fingerprint(event)) throw new Error('Событие изменилось перед удалением. Обновите проверку');
  const result = await b24('calendar.event.delete', {id:Number(event.id)});
  if (result !== true) throw new Error('Битрикс24 не подтвердил удаление события');
}

export async function eventSection(id) {
  const event = await b24('calendar.event.getbyid', {id:Number(id)});
  return event?.SECTION_ID == null ? null : String(event.SECTION_ID);
}

function eventTimestamp(event, edge) {
  const parts = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(event[`DATE_${edge}`] || '');
  const offset = Number(event[`TZ_OFFSET_${edge}`]);
  // This portal's *_TS_UTC fields apply an extra server offset; use wall time plus its explicit offset.
  if (!parts || event[`TZ_OFFSET_${edge}`] == null || !Number.isFinite(offset)) return NaN;
  const [, day, month, year, hour, minute, second] = parts.map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second) - offset * 1000;
}

export function normalizeBitrix(event) {
  const start = eventTimestamp(event, 'FROM');
  const end = eventTimestamp(event, 'TO');
  const unsupported = event.DT_SKIP_TIME === 'Y' ? 'Событие на весь день пока не переносится'
    : event.RRULE || event.RECURRENCE_ID || !Number.isFinite(start) || !Number.isFinite(end)
      ? 'Повторяющееся или некорректное событие' : null;
  return {
    side: 'bitrix', id: String(event.ID), title: event.NAME || '', start, end,
    allDay: event.DT_SKIP_TIME === 'Y', location: typeof event.LOCATION === 'string' ? event.LOCATION : '',
    isMeeting: event.IS_MEETING === true || event.IS_MEETING === 'Y', unsupported,
  };
}

function fields(event, sectionId, user) {
  return {
    type: 'user', ownerId: user.id, section: Number(sectionId), name: event.title,
    from_ts: Math.floor(event.start / 1000), to_ts: Math.floor(event.end / 1000),
    timezone_from: user.timeZone, timezone_to: user.timeZone,
    skip_time: event.allDay ? 'Y' : 'N', location: event.location || '',
  };
}

export async function createBitrix(event, sectionId) {
  const user = account().user;
  return String(await b24('calendar.event.add', fields(event, sectionId, user)));
}

export async function updateBitrix(id, event, sectionId) {
  const user = account().user;
  await b24('calendar.event.update', { id: Number(id), ...fields(event, sectionId, user) });
}
