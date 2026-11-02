import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const input = createInterface({ input: process.stdin });
const [line] = await once(input, 'line');
input.close();
const values = JSON.parse(line);
const allowed = ['BITRIX_CLIENT_ID', 'BITRIX_CLIENT_SECRET', 'BITRIX_APP_CODE'];
if (Object.keys(values).some(key => !allowed.includes(key)) || allowed.some(key => !values[key] || /[\r\n]/.test(values[key]))) throw new Error('Invalid OAuth configuration');
const current = (await readFile('.env', 'utf8')).split('\n').filter(line => !allowed.some(key => line.startsWith(`${key}=`)));
await writeFile('.env', [...current.filter(Boolean), ...allowed.map(key => `${key}=${values[key]}`), ''].join('\n'), { mode: 0o600 });
console.log('OAuth configuration saved');
