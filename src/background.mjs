import { createHmac, timingSafeEqual } from 'node:crypto';
import { account, accountIds, context, saveAccount } from './config.mjs';
import { loadedAccount, oauthCall, portalOf } from './auth.mjs';
import { isBusy, runSync, snapshot } from './sync.mjs';
import { calendarLinks } from './calendars.mjs';
import { appleClient, appleRevisions, forgetAppleClients } from './icloud.mjs';
import { eventSection } from './bitrix.mjs';

export const pollSeconds = 5;
export const fullScanSeconds = 30;
export function autoWaitingReason(value) {
  if (!value.config.autoEnabled) return null;
  if (!value.config.appleEmail || !value.applePassword) return 'Ожидается подключение iCloud';
  if (value.config.pendingBitrixIds?.length) return 'Ожидается применение выбора календарей после подключения iCloud';
  const links = calendarLinks(value.config).filter(link=>link.enabled);
  if (!links.length) return 'Ожидается выбор календарей';
  if (links.some(link=>!value.state.initializedLinks?.[link.id])) return 'Ожидается первый запуск: предпросмотр и подтверждение переноса';
  return null;
}
const pending = new Map();
const eventQueues = new Map();
const forced = new Set();
const checking = new Set();
const secretFor = id => createHmac('sha256', process.env.ENCRYPTION_KEY).update(`calendar-events:${id}`).digest('hex');
export function callbackUrl(id) { return `${process.env.APP_URL}/events/${id}/${secretFor(id)}`; }
export function validCallback(id, secret, fields, value) {
  if (!/^[a-f0-9]{64}$/.test(secret) || !timingSafeEqual(Buffer.from(secret), Buffer.from(secretFor(id)))) return false;
  return fields['auth[domain]'] === portalOf(value) && fields['auth[member_id]'] === value.memberId
    && ['ONCALENDARENTRYADD', 'ONCALENDARENTRYUPDATE', 'ONCALENDARENTRYDELETE'].includes(fields.event?.toUpperCase());
}
export async function bindEvents() {
  const value = account();
  if (value.config.eventsBound) return;
  try {
    for (const event of ['ONCALENDARENTRYADD', 'ONCALENDARENTRYUPDATE', 'ONCALENDARENTRYDELETE']) {
      try { await oauthCall('event.bind', { event, handler: callbackUrl(value.id) }); }
      catch (error) { if (!/already bind|уже зарегистр|already.*started/i.test(error.message)) throw error; }
    }
    value.config.eventsBound = true;
    delete value.state.eventBindingError;
  } catch (error) { value.state.eventBindingError = error.message; }
  await saveAccount(value);
}
export async function backgroundRun(value, overrides = {}) {
  if (checking.has(value.id)) return;
  checking.add(value.id);
  const services = {appleClient, appleRevisions, eventSection, runSync, snapshot, now:Date.now, ...overrides};
  try { return await context.run(value, async () => {
    if (!value.config.autoEnabled || isBusy() || value.state.nextRetryAt > services.now()) return;
    if (autoWaitingReason(value)) {
      value.state.lastAttempt = new Date().toISOString();
      value.state.lastCheckStarted = value.state.lastAttempt;
      await saveAccount(value);
      return;
    }
    const started = services.now();
    value.state.lastCheckStarted = new Date(started).toISOString();
    try {
      const links = calendarLinks(value.config).filter(link=>link.enabled);
      const revisions = await services.appleRevisions(await services.appleClient(value.config.appleEmail));
      let full = forced.delete(value.id) || !value.state.lastFullScan || started - Date.parse(value.state.lastFullScan) >= fullScanSeconds * 1000;
      const changed = new Set(links.filter(link => !revisions[link.appleUrl] || revisions[link.appleUrl] !== value.state.appleRevisions?.[link.appleUrl]).map(link=>link.id));
      const eventIds = eventQueues.get(value.id);
      eventQueues.delete(value.id);
      for (const id of eventIds || []) {
        const pair = value.state.pairs?.find(pair=>pair.bitrixId===id || pair.bitrixRecordId===id || pair.bitrixId.startsWith(`${id}#occurrence=`));
        if (pair) { changed.add(pair.calendarLinkId || 'legacy'); continue; }
        try {
          const section = await services.eventSection(id);
          if (!section) { full = true; continue; }
          for (const link of links) if (link.bitrixId===section) changed.add(link.id);
        } catch { full = true; }
      }
      const linkIds = full ? links.map(link=>link.id) : [...changed].filter(id=>links.some(link=>link.id===id));
      if (linkIds.length) {
        if (isBusy()) { forced.add(value.id); return; }
        await services.runSync(null, {snapshot:()=>services.snapshot({linkIds,revisions})});
        if (value.state.lastAutoError) {
          const error = new Error(value.state.lastAutoError);
          error.code = value.state.lastAutoErrorCode;
          error.retryAfterMs = value.state.retryAfterMs;
          throw error;
        }
      }
      value.state.appleRevisions = revisions;
      if (full) value.state.lastFullScan = new Date(started).toISOString();
      value.state.lastAutoError = null;
      value.state.lastAutoErrorCode = null;
      value.state.failureCount = 0;
      value.state.nextRetryAt = 0;
    } catch (error) {
      forced.add(value.id);
      value.state.lastAutoError = error.message;
      value.state.lastAutoErrorCode = error.code || null;
      value.state.failureCount = Math.min((value.state.failureCount || 0) + 1, 6);
      value.state.nextRetryAt = services.now() + Math.max(error.retryAfterMs || 0, Math.min(15000 * 2 ** value.state.failureCount, 900000));
      if (error.code === 'ICLOUD_AUTH_REJECTED') forgetAppleClients();
    }
    value.state.lastAttempt = new Date(services.now()).toISOString();
    value.state.lastCheckDurationMs = services.now() - started;
    await saveAccount(value);
  }); } finally { checking.delete(value.id); }
}
export function enqueue(value, delay = 200, {eventId, forceFull = false} = {}) {
  if (eventId && /^\d+$/.test(String(eventId))) {
    const ids = eventQueues.get(value.id) || new Set();
    if (ids.size < 100) ids.add(String(eventId)); else forced.add(value.id);
    eventQueues.set(value.id, ids);
  }
  if (forceFull) forced.add(value.id);
  if (!value.config.autoEnabled || pending.has(value.id)) return;
  pending.set(value.id, setTimeout(async () => {
    pending.delete(value.id);
    try {
      if (checking.has(value.id) || await context.run(value, isBusy)) { enqueue(value, 250); return; }
      await backgroundRun(value);
    } catch { /* The periodic pass will retry disk or transient worker failures. */ }
  }, delay).unref());
}
export function startBackground() {
  const tick = async () => {
    try {
      for (const id of await accountIds()) {
        const value = await loadedAccount(id);
        if (value.state.nextRetryAt > Date.now()) continue;
        const last = Date.parse(value.state.lastCheckStarted || value.state.lastAttempt || value.state.lastRun || 0) || 0;
        if (Date.now() - last >= pollSeconds * 1000) enqueue(value, 0);
      }
    } catch (error) { console.error(`Background scheduler: ${error.message}`); }
  };
  tick();
  setInterval(tick, 1000).unref();
}
