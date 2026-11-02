import { createHmac, timingSafeEqual } from 'node:crypto';
import { account, accountIds, context, saveAccount } from './config.mjs';
import { loadedAccount, oauthCall, portal } from './auth.mjs';
import { isBusy, runSync } from './sync.mjs';
import { calendarLinks } from './calendars.mjs';

export const pollSeconds = 30;
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
const secretFor = id => createHmac('sha256', process.env.ENCRYPTION_KEY).update(`calendar-events:${id}`).digest('hex');
export function callbackUrl(id) { return `${process.env.APP_URL}/events/${id}/${secretFor(id)}`; }
export function validCallback(id, secret, fields, value) {
  if (!/^[a-f0-9]{64}$/.test(secret) || !timingSafeEqual(Buffer.from(secret), Buffer.from(secretFor(id)))) return false;
  return fields['auth[domain]'] === portal && fields['auth[member_id]'] === value.memberId
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
export async function backgroundRun(value) {
  return context.run(value, async () => {
    if (!value.config.autoEnabled || isBusy() || value.state.nextRetryAt > Date.now()) return;
    if (autoWaitingReason(value)) {
      value.state.lastAttempt = new Date().toISOString();
      await saveAccount(value);
      return;
    }
    try {
      await runSync();
      if (value.state.lastAutoError) throw new Error(value.state.lastAutoError);
      value.state.failureCount = 0;
      value.state.nextRetryAt = 0;
    } catch (error) {
      value.state.lastAutoError = error.message;
      value.state.failureCount = Math.min((value.state.failureCount || 0) + 1, 6);
      value.state.nextRetryAt = Date.now() + Math.min(15000 * 2 ** value.state.failureCount, 900000);
    }
    value.state.lastAttempt = new Date().toISOString();
    await saveAccount(value);
  });
}
export function enqueue(value, delay = 2000) {
  if (!value.config.autoEnabled || pending.has(value.id)) return;
  pending.set(value.id, setTimeout(async () => {
    pending.delete(value.id);
    try {
      if (await context.run(value, isBusy)) { enqueue(value, 3000); return; }
      await backgroundRun(value);
    } catch { /* The periodic pass will retry disk or transient worker failures. */ }
  }, delay));
}
export function startBackground() {
  const tick = async () => {
    try {
      for (const id of await accountIds()) {
        const value = await loadedAccount(id);
        const last = Date.parse(value.state.lastAttempt || value.state.lastRun || 0) || 0;
        if (Date.now() - last >= pollSeconds * 1000) enqueue(value, 0);
      }
    } catch (error) { console.error(`Background scheduler: ${error.message}`); }
  };
  tick();
  setInterval(tick, 5000).unref();
}
