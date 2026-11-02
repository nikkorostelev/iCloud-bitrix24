import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, context, account, saveAccount, getApplePassword } from './config.mjs';
import { acceptLaunch, sessionAccount, loadedAccount, portalOf } from './auth.mjs';
import { profile, sections } from './bitrix.mjs';
import { appleClient, appleCalendars, normalizeApplePassword } from './icloud.mjs';
import { disconnectPreview, disconnectApple } from './connection.mjs';
import { calendarLinks, configureCalendars, saveDeferredPreferences } from './calendars.mjs';
import { snapshot, previewSignature, runSync, exclusive, isBusy } from './sync.mjs';
import { pollSeconds, fullScanSeconds, bindEvents, callbackUrl, validCallback, enqueue, startBackground, autoWaitingReason } from './background.mjs';

const port = Number(process.env.PORT || 8766);
const origin = process.env.APP_URL || `http://127.0.0.1:${port}`;
function response(res, status, body, type = 'application/json; charset=utf-8', framePortal = null) {
  const embeddingPortal=context.getStore()?.portal || framePortal;
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'content-security-policy': `frame-ancestors ${embeddingPortal ? `https://${embeddingPortal}` : "'none'"}` });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
async function requestBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 65536) throw new Error('Слишком большой запрос'); }
  return raw;
}
const jsonBody = async req => JSON.parse(await requestBody(req) || '{}');
function progress() {
  const value = account(), state = value.state;
  return {
    autoEnabled: !!value.config.autoEnabled, busy: isBusy(), pollSeconds, eventsBound: !!value.config.eventsBound,
    autoWaitingReason: autoWaitingReason(value),
    lastRun: state.lastRun || null, lastSuccess: state.lastSuccess || null, lastAttempt: state.lastAttempt || null,
    lastAutoError: state.lastAutoError || null, eventBindingError: state.eventBindingError || null,
    nextRetryAt: state.nextRetryAt || null, pairCount: state.pairs?.length || 0,
    lastResults: state.lastResults || [], conflicts: state.lastConflicts || 0, skipped: state.lastSkipped || 0,
    initializedLinks: state.initializedLinks || {},
    syncProgress: state.syncProgress || null,
    fullScanSeconds, lastCheckDurationMs: state.lastCheckDurationMs ?? null,
  };
}
export async function handle(req, res) {
  try {
    const url = new URL(req.url, origin);
    if (req.method === 'HEAD' && ['/', '/install', '/health'].includes(url.pathname)) return response(res, 200, '');
    if (req.method === 'GET' && url.pathname === '/health') return response(res, 200, { ok: true, version: 2 });
    if (req.method === 'POST' && url.pathname.startsWith('/events/')) {
      const match = url.pathname.match(/^\/events\/([a-f0-9]{64})\/([a-f0-9]{64})$/);
      if (!match || callbackUrl(match[1]) !== `${origin}${url.pathname}`) return response(res, 403, { error: 'Forbidden' });
      const fields = Object.fromEntries(new URLSearchParams(await requestBody(req)));
      const value = await loadedAccount(match[1]);
      if (!validCallback(match[1], match[2], fields, value)) return response(res, 403, { error: 'Forbidden' });
      value.state.lastEventReceived = new Date().toISOString();
      enqueue(value, 200, {eventId:fields['data[id]'],forceFull:!/^\d+$/.test(fields['data[id]'] || '')});
      return response(res, 200, { ok: true });
    }
    if (req.method === 'POST' && ['/', '/install'].includes(url.pathname)) {
      const fields = Object.fromEntries(new URLSearchParams(await requestBody(req)));
      fields.DOMAIN ||= fields['auth[domain]'] || url.searchParams.get('DOMAIN');
      fields.AUTH_ID ||= fields['auth[access_token]'];
      fields.REFRESH_ID ||= fields['auth[refresh_token]'];
      fields.member_id ||= fields['auth[member_id]'];
      const token = await acceptLaunch(fields);
      const launched=await sessionAccount({headers:{authorization:`Bearer ${token}`}});
      let html = await readFile(resolve(root, 'public/index.html'), 'utf8');
      html = html.replace('<!-- SESSION -->', `<meta name="session-token" content="${token}"><meta name="installation" content="${url.pathname === '/install'}">`);
      return response(res, 200, html, 'text/html; charset=utf-8',portalOf(launched));
    }
    if (req.method === 'GET' && ['/', '/install'].includes(url.pathname)) return response(res, 200,
      '<!doctype html><html lang="ru"><meta charset="utf-8"><title>iCloud · Битрикс24</title><p>Откройте приложение «iCloud Календарь» из меню вашего Битрикс24.</p></html>', 'text/html; charset=utf-8');
    const assets = { '/app.js': 'text/javascript', '/styles.css': 'text/css', '/auto.css': 'text/css' };
    if (req.method === 'GET' && assets[url.pathname]) return response(res, 200, await readFile(resolve(root, `public${url.pathname}`), 'utf8'), `${assets[url.pathname]}; charset=utf-8`);
    const userAccount = await sessionAccount(req);
    if (!userAccount) return response(res, 401, { error: 'Сессия истекла. Откройте приложение заново из Битрикс24' });
    if (req.method === 'POST' && req.headers.origin && req.headers.origin !== origin) return response(res, 403, { error: 'Неверный источник запроса' });
    return await context.run(userAccount, async () => {
      const value = account(), config = value.config;
      if (req.method === 'GET' && url.pathname === '/api/disconnect-preview') return response(res,200,await disconnectPreview());
      if (req.method === 'POST' && url.pathname === '/api/disconnect') return exclusive(async()=>response(res,200,await disconnectApple(await jsonBody(req))));
      if (req.method === 'POST' && url.pathname === '/api/calendar-preferences') return exclusive(async()=>response(res,200,await saveDeferredPreferences(await jsonBody(req))));
      if (req.method === 'GET' && url.pathname === '/api/progress') return response(res, 200, progress());
      if (req.method === 'GET' && url.pathname === '/api/status') {
        let list = [], calendars = [], bitrixUser = null, bitrixError = null, appleError = null;
        try { bitrixUser = await profile(); list = await sections(); } catch (error) { bitrixError = error.message; }
        if (config.appleEmail && getApplePassword(config.appleEmail)) {
          try { calendars = (await appleCalendars(await appleClient(config.appleEmail), true)).map(c => ({ url: c.url, name: String(c.displayName || c.url), color: c.calendarColor })); }
          catch (error) { appleError = `iCloud: ${error.message}`; }
        }
        const links = calendarLinks(config).map(link => ({ ...link,
          eventCount: (value.state.pairs || []).filter(pair => (pair.calendarLinkId || 'legacy') === link.id).length,
          bitrixName: list.find(c => c.id === link.bitrixId)?.name || link.bitrixName || link.bitrixId,
          appleName: calendars.find(c => c.url === link.appleUrl)?.name || link.appleName || 'Недоступен',
          available: list.some(c => c.id === link.bitrixId) && calendars.some(c => c.url === link.appleUrl),
        }));
        return response(res, 200, { ...progress(), portal:portalOf(value), sections: list, calendars, calendarLinks: links,
          bitrixReady: !!bitrixUser && !bitrixError, bitrixUser, bitrixError, appleError,
          appleEmail: config.appleEmail || '', appleReady: !!getApplePassword(config.appleEmail), horizonDays: config.horizonDays || 30, pendingBitrixIds: config.pendingBitrixIds || [] });
      }
      if (req.method === 'POST' && url.pathname === '/api/apple') return exclusive(async () => {
        const body = await jsonBody(req);
        const email = String(body.email || '').trim();
        const password = normalizeApplePassword(body.password);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '') || !password) throw new Error('Укажите Apple ID и пароль приложения');
        if (calendarLinks(config).length && config.appleEmail && config.appleEmail !== email) throw new Error('Для смены Apple ID сначала нужна отдельная настройка связей календарей');
        const calendars = await appleCalendars(await appleClient(email, password), true);
        value.applePassword = password; config.appleEmail = email;
        value.state.nextRetryAt = 0; value.state.failureCount = 0;
        value.state.lastAutoError = null; value.state.lastAutoErrorCode = null;
        await saveAccount(value);
        enqueue(value, 0, {forceFull:true});
        return response(res, 200, { count: calendars.length });
      });
      if (req.method === 'POST' && url.pathname === '/api/config') return exclusive(async () => {
        const body = await jsonBody(req);
        await configureCalendars(body);
        // The worker waits for the first confirmed run of every enabled link.
        await saveAccount(value);
        return response(res, 200, { ok: true });
      });
      if (req.method === 'GET' && url.pathname === '/api/preview') return exclusive(async () => {
        if (config.pendingBitrixIds?.length) throw new Error('Есть сохранённый выбор календарей Битрикса. После восстановления iCloud нажмите «Сохранить календари» для применения');
        const data = await snapshot();
        return response(res, 200, { bitrixCount: data.bitrixCount, appleCount: data.appleCount, previewToken: previewSignature(data),
          actions: data.actions.map(({ kind, title, reason, source, calendarName }) => ({ kind, title, reason, calendarName, start: source?.start })) });
      });
      if (req.method === 'POST' && url.pathname === '/api/run') {
        const { confirm, previewToken } = await jsonBody(req);
        if (confirm !== true || !/^[a-f0-9]{64}$/.test(previewToken || '')) throw new Error('Сначала откройте предпросмотр');
        return response(res, 200, await runSync(previewToken));
      }
      if (req.method === 'POST' && url.pathname === '/api/auto') {
        const { enabled } = await jsonBody(req);
        if (typeof enabled !== 'boolean') throw new Error('Неверный режим');
        config.autoEnabled = enabled;
        value.state.nextRetryAt = 0;
        await saveAccount(value);
        if (enabled) { if (!autoWaitingReason(value)) await bindEvents(); enqueue(value, 0, {forceFull:true}); }
        return response(res, 200, progress());
      }
      return response(res, 404, { error: 'Не найдено' });
    });
  } catch (error) { response(res, 400, { error: error.message }); }
}
if (process.env.NODE_ENV !== 'test') {
  const server = createServer(handle);
  server.listen(port, '127.0.0.1', () => console.log(`Bitrix24 iCloud Sync: http://127.0.0.1:${port}`));
  startBackground();
}
