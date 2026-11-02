import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { account, accountId, readAccount, saveAccount } from './config.mjs';

export const accounts = new Map();
const sessionLifetime = 12 * 3600000;
function sessionSignature(payload) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32) throw new Error('Не настроен ключ шифрования сервера');
  return createHmac('sha256', key).update(`browser-session:v1:${payload}`).digest('base64url');
}
const refreshes = new Map();
let nextRequestAt = 0;
export const portal = process.env.BITRIX_PORTAL || 'bazabzshow.bitrix24.ru';
export async function loadedAccount(id) {
  if (!accounts.has(id)) accounts.set(id, await readAccount(id));
  return accounts.get(id);
}
async function call(token, method, params = {}) {
  const slot = Math.max(Date.now(), nextRequestAt);
  nextRequestAt = slot + 550;
  if (slot > Date.now()) await new Promise(resolve => setTimeout(resolve, slot - Date.now()));
  const response = await fetch(`https://${portal}/rest/${method}.json`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...params, auth: token }), signal: AbortSignal.timeout(25000),
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    const error = new Error(`Bitrix24: ${data.error_description || data.error || response.status}`);
    error.code = data.error;
    throw error;
  }
  return data.result;
}
export async function acceptLaunch(fields) {
  if (fields.DOMAIN !== portal || !fields.AUTH_ID || !fields.REFRESH_ID || !fields.member_id) throw new Error('Откройте приложение в BZShow');
  const expected = process.env.BITRIX_APP_CODE;
  if (!expected || !process.env.BITRIX_CLIENT_ID || !process.env.BITRIX_CLIENT_SECRET) throw new Error('Регистрация приложения ещё не завершена');
  const [user, info] = await Promise.all([call(fields.AUTH_ID, 'profile'), call(fields.AUTH_ID, 'app.info')]);
  if (String(info.CODE) !== expected || !Number(user.ID)) throw new Error('Не удалось подтвердить приложение Bitrix24');
  const value = await loadedAccount(accountId(fields.member_id, user.ID));
  value.memberId = fields.member_id;
  value.user = { id: Number(user.ID), name: [user.NAME, user.LAST_NAME].filter(Boolean).join(' '), timeZone: user.TIME_ZONE || 'Europe/Moscow' };
  // An already persisted refresh token may be newer than the iframe launch data.
  if (!value.oauth || value.oauth.reconnect) value.oauth = {
    accessToken: fields.AUTH_ID, refreshToken: fields.REFRESH_ID,
    expiresAt: Date.now() + Math.min(Number(fields.AUTH_EXPIRES) || 3600, 3600) * 1000,
  };
  value.config.bitrixUserId = value.user.id;
  await saveAccount(value);
  const payload = Buffer.from(JSON.stringify({v:1,id:value.id,portal,exp:Date.now()+sessionLifetime,nonce:randomBytes(16).toString('hex')})).toString('base64url');
  return `${payload}.${sessionSignature(payload)}`;
}
export async function sessionAccount(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  if (token.length > 1024) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  const expected = Buffer.from(sessionSignature(payload));
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected,supplied)) return null;
  let session;
  try { session=JSON.parse(Buffer.from(payload,'base64url').toString()); } catch { return null; }
  if (session.v !== 1 || session.portal !== portal || !/^[a-f0-9]{64}$/.test(session.id || '') || !Number.isFinite(session.exp) || session.exp <= Date.now() || session.exp > Date.now()+sessionLifetime) return null;
  const value=await loadedAccount(session.id);
  if (!value.user?.id || !value.memberId || accountId(value.memberId,value.user.id)!==session.id) return null;
  return value;
}
async function refresh(value) {
  if (refreshes.has(value.id)) return refreshes.get(value.id);
  const promise = (async () => {
    const response = await fetch('https://oauth.bitrix24.tech/oauth/token/', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: process.env.BITRIX_CLIENT_ID,
        client_secret: process.env.BITRIX_CLIENT_SECRET, refresh_token: value.oauth.refreshToken }),
      signal: AbortSignal.timeout(25000),
    });
    const data = await response.json();
    if (!response.ok || !data.access_token || !data.refresh_token) {
      if (['invalid_grant', 'invalid_token'].includes(data.error)) {
        value.oauth.reconnect = true;
        await saveAccount(value);
      }
      throw new Error('Не удалось продлить подключение Bitrix24. Откройте приложение из портала заново');
    }
    if (data.member_id && data.member_id !== value.memberId) throw new Error('Портал OAuth не совпадает');
    value.oauth = { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
    await saveAccount(value);
  })();
  refreshes.set(value.id, promise);
  try { await promise; } finally { refreshes.delete(value.id); }
}
export async function oauthCall(method, params = {}) {
  const value = account();
  if (!value.oauth || value.oauth.reconnect) throw new Error('Откройте приложение из портала для подключения Bitrix24');
  if (value.oauth.expiresAt < Date.now() + 120000) await refresh(value);
  try { return await call(value.oauth.accessToken, method, params); }
  catch (error) {
    if (error.code !== 'expired_token') throw error;
    await refresh(value);
    return call(value.oauth.accessToken, method, params);
  }
}
