import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { account, accountId, readAccount, saveAccount } from './config.mjs';
import { normalizePortal, verifiedEndpoint, portalFetch } from './portal.mjs';

export const accounts = new Map();
const sessionLifetime = 12 * 3600000;
function sessionSignature(payload) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32) throw new Error('Не настроен ключ шифрования сервера');
  return createHmac('sha256', key).update(`browser-session:v1:${payload}`).digest('base64url');
}
const refreshes = new Map();
let nextRequestAt = 0;
const legacyPortal = process.env.BITRIX_PORTAL || 'bazabzshow.bitrix24.ru';
export const portalOf = (value=account()) => normalizePortal(value.portal || legacyPortal);
export async function loadedAccount(id) {
  if (!accounts.has(id)) {
    const value=await readAccount(id);
    if (value.memberId && !value.portal) value.portal=legacyPortal;
    accounts.set(id,value);
  }
  return accounts.get(id);
}
async function call(endpoint, token, method, params = {}) {
  const slot = Math.max(Date.now(), nextRequestAt);
  nextRequestAt = slot + 550;
  if (slot > Date.now()) await new Promise(resolve => setTimeout(resolve, slot - Date.now()));
  const response = await portalFetch(`${endpoint}${method}.json`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...params, auth: token }), signal: AbortSignal.timeout(25000),
  });
  const data = response.data;
  if (!response.ok || data.error) {
    const error = new Error(`Bitrix24: ${data.error_description || data.error || response.status}`);
    error.code = data.error;
    throw error;
  }
  return data.result;
}
export async function acceptLaunch(fields) {
  const portal=normalizePortal(fields.DOMAIN);
  if (!fields.AUTH_ID || !fields.REFRESH_ID || !fields.member_id) throw new Error('Откройте приложение из меню вашего Битрикс24');
  const expected = process.env.BITRIX_APP_CODE;
  if (!expected || !process.env.BITRIX_CLIENT_ID || !process.env.BITRIX_CLIENT_SECRET) throw new Error('Регистрация приложения ещё не завершена');
  // The central OAuth response proves both the installation and its REST endpoint.
  const oauth=await exchangeToken(fields.REFRESH_ID);
  if (oauth.member_id !== fields.member_id) throw new Error('Портал OAuth не совпадает');
  const endpoint=verifiedEndpoint(oauth.client_endpoint,portal);
  const [user, info] = await Promise.all([call(endpoint,oauth.access_token, 'profile'), call(endpoint,oauth.access_token, 'app.info')]);
  if (String(info.CODE) !== expected || !Number(user.ID)) throw new Error('Не удалось подтвердить приложение Bitrix24');
  if (oauth.user_id != null && Number(oauth.user_id)!==Number(user.ID)) throw new Error('Пользователь OAuth не совпадает');
  const value = await loadedAccount(accountId(fields.member_id, user.ID));
  value.memberId = fields.member_id;
  value.portal=portal;
  value.clientEndpoint=endpoint;
  value.user = { id: Number(user.ID), name: [user.NAME, user.LAST_NAME].filter(Boolean).join(' '), timeZone: user.TIME_ZONE || 'Europe/Moscow' };
  value.oauth = {accessToken:oauth.access_token,refreshToken:oauth.refresh_token,expiresAt:Date.now()+Number(oauth.expires_in || 3600)*1000};
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
  if (session.v !== 1 || !/^[a-f0-9]{64}$/.test(session.id || '') || !Number.isFinite(session.exp) || session.exp <= Date.now() || session.exp > Date.now()+sessionLifetime) return null;
  const value=await loadedAccount(session.id);
  if (!value.user?.id || !value.memberId || session.portal!==portalOf(value) || accountId(value.memberId,value.user.id)!==session.id) return null;
  return value;
}
async function exchangeToken(refreshToken) {
    const response = await fetch('https://oauth.bitrix24.tech/oauth/token/', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: process.env.BITRIX_CLIENT_ID,
        client_secret: process.env.BITRIX_CLIENT_SECRET, refresh_token: refreshToken }),
      signal: AbortSignal.timeout(25000), redirect:'error',
    });
    const data = await response.json();
    if (!response.ok || !data.access_token || !data.refresh_token) {
      const error=new Error('Не удалось подтвердить OAuth-подключение Битрикс24. Откройте приложение из портала заново');
      error.code=data.error;
      throw error;
    }
    return data;
}
async function refresh(value) {
  if (refreshes.has(value.id)) return refreshes.get(value.id);
  const promise = (async () => {
    let data;
    try { data=await exchangeToken(value.oauth.refreshToken); }
    catch(error) { if (['invalid_grant','invalid_token'].includes(error.code)) {value.oauth.reconnect=true;await saveAccount(value);} throw error; }
    if (data.member_id && data.member_id !== value.memberId) throw new Error('Портал OAuth не совпадает');
    if (data.user_id != null && Number(data.user_id)!==value.user.id) throw new Error('Пользователь OAuth не совпадает');
    if (data.client_endpoint) value.clientEndpoint=verifiedEndpoint(data.client_endpoint,portalOf(value));
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
  const endpoint=value.clientEndpoint || `https://${portalOf(value)}/rest/`;
  try { return await call(endpoint, value.oauth.accessToken, method, params); }
  catch (error) {
    if (error.code !== 'expired_token') throw error;
    await refresh(value);
    return call(value.clientEndpoint || endpoint, value.oauth.accessToken, method, params);
  }
}
