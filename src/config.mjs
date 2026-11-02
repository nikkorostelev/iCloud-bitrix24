import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
export const context = new AsyncLocalStorage();
const directory = resolve(process.env.DATA_DIR || resolve(root, 'runtime/accounts'));
export function account() {
  const value = context.getStore();
  if (!value) throw new Error('Откройте приложение из Bitrix24');
  return value;
}
function key() {
  const value = Buffer.from(process.env.ENCRYPTION_KEY || '', 'base64');
  if (value.length !== 32) throw new Error('Не настроен ключ шифрования сервера');
  return value;
}
export function seal(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
export function unseal(value) {
  const bytes = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
}
export const accountId = (member, user) => createHash('sha256').update(`${member}:${user}`).digest('hex');
export async function readAccount(id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Неверный аккаунт');
  try { return unseal(await readFile(resolve(directory, `${id}.enc`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { id, config: {}, state: { pairs: [] } }; throw error; }
}
const writes = new Map();
export async function saveAccount(value = account()) {
  const encoded = seal(value);
  const previous = writes.get(value.id) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = resolve(directory, `${value.id}.enc`);
    const temp = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temp, encoded, { mode: 0o600 });
    await rename(temp, target);
  });
  writes.set(value.id, next);
  try { await next; } finally { if (writes.get(value.id) === next) writes.delete(value.id); }
}
export async function accountIds() {
  try { return (await readdir(directory)).filter(x => /^[a-f0-9]{64}\.enc$/.test(x)).map(x => x.slice(0, -4)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export const getConfig = async () => account().config;
export const saveConfig = async value => { account().config = value; await saveAccount(); };
export const getState = async () => account().state;
export const saveState = async value => { account().state = value; await saveAccount(); };
export const getApplePassword = email => account().config.appleEmail === email ? account().applePassword : null;
export const setApplePassword = async (email, password) => { account().applePassword = password; await saveAccount(); };
