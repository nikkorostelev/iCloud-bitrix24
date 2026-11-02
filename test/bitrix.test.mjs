import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const temp = await mkdtemp(`${tmpdir()}/icloud-auth-`);
process.env.DATA_DIR = temp;
process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.BITRIX_APP_CODE = 'test.icloud';
process.env.BITRIX_CLIENT_ID = 'test-client';
process.env.BITRIX_CLIENT_SECRET = 'test-secret';
const { seal, unseal, context, getConfig, saveConfig, readAccount } = await import('../src/config.mjs');
const { acceptLaunch, sessionAccount, oauthCall, accounts } = await import('../src/auth.mjs');
test.after(() => rm(temp, { recursive: true, force: true }));

test('encrypted settings detect tampering', () => {
  const encrypted = seal({ password: 'private' });
  assert.ok(!encrypted.includes('private'));
  assert.deepEqual(unseal(encrypted), { password: 'private' });
  const changed = Buffer.from(encrypted, 'base64'); changed[30] ^= 1;
  assert.throws(() => unseal(changed.toString('base64')));
});

test('OAuth verifies app and derives user identity; settings are isolated', async t => {
  let code = 'test.icloud';
  let refreshCalls = 0;
  const destinations=[];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/oauth/token')) {
      refreshCalls++;
      const token=options.body.get('refresh_token');
      const other=token==='other-portal', second=token==='second-refresh';
      return { ok: true, json: async () => ({ access_token: second ? 'second' : 'renewed', refresh_token: 'rotated', expires_in: 3600, member_id: other ? 'other-member' : 'member',user_id:second ? 2 : 1,client_endpoint:`https://${other ? 'delovayasreda' : 'bazabzshow'}.bitrix24.ru/rest/` }) };
    }
    destinations.push(new URL(url).hostname);
    const body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ result: url.includes('app.info') ? { CODE: code } : { ID: body.auth === 'second' ? '2' : '1', NAME: 'Test' } }) };
  });
  const launch = { DOMAIN: 'bazabzshow.bitrix24.ru', AUTH_ID: 'first', REFRESH_ID: 'refresh', member_id: 'member' };
  await assert.rejects(acceptLaunch({ ...launch, DOMAIN: 'other.bitrix24.ru' }));
  code = 'different.app'; await assert.rejects(acceptLaunch(launch)); code = 'test.icloud';
  const firstToken = await acceptLaunch(launch);
  const first = await sessionAccount({ headers: { authorization: `Bearer ${firstToken}` } });
  const second = await sessionAccount({ headers: { authorization: `Bearer ${await acceptLaunch({ ...launch, AUTH_ID: 'second', REFRESH_ID:'second-refresh' })}` } });
  assert.equal(first.user.id, 1); assert.equal(second.user.id, 2);
  await context.run(first, () => saveConfig({ ...first.config, appleEmail: 'one@example.com' }));
  assert.equal(await context.run(second, async () => (await getConfig()).appleEmail), undefined);
  assert.equal((await readAccount(first.id)).config.appleEmail, 'one@example.com');
  const other=await sessionAccount({headers:{authorization:`Bearer ${await acceptLaunch({...launch,DOMAIN:'delovayasreda.bitrix24.ru',REFRESH_ID:'other-portal',member_id:'other-member'})}`}});
  assert.equal(other.user.id,1);
  assert.equal(other.portal,'delovayasreda.bitrix24.ru');
  assert.notEqual(other.id,first.id);
  assert.equal(other.config.appleEmail,undefined);
  await context.run(other,()=>oauthCall('profile'));
  assert.equal(destinations.at(-1),'delovayasreda.bitrix24.ru');
  const beforeRefresh=refreshCalls;
  first.oauth.expiresAt = 0;
  await context.run(first, () => Promise.all([oauthCall('profile'), oauthCall('profile')]));
  assert.equal(refreshCalls-beforeRefresh, 1);
  assert.equal((await readAccount(first.id)).oauth.refreshToken, 'rotated');
  assert.equal(await sessionAccount({ headers: {} }), null);
  assert.equal(await sessionAccount({headers:{authorization:`Bearer ${firstToken.slice(0,-1)}!`}}),null);
  assert.equal(await sessionAccount({headers:{authorization:'Bearer '+ 'a'.repeat(1100)}}),null);
  accounts.clear();
  const restored=await sessionAccount({headers:{authorization:`Bearer ${firstToken}`}});
  assert.equal(restored.user.id,1);
  assert.equal(restored.config.appleEmail,'one@example.com');
  const realNow=Date.now;
  t.mock.method(Date,'now',()=>realNow()+13*3600000);
  assert.equal(await sessionAccount({headers:{authorization:`Bearer ${firstToken}`}}),null);
  t.mock.restoreAll();
  let eventBody;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    eventBody = JSON.parse(options.body);
    return { ok:true, json:async()=>({result:123}) };
  });
  const { createBitrix, normalizeBitrix } = await import('../src/bitrix.mjs');
  const start = Date.parse('2026-11-02T18:00:00+03:00');
  await context.run(first, () => createBitrix({title:'UTC test', start, end:start+3600000}, '22'));
  assert.equal(eventBody.from_ts, start / 1000);
  assert.equal(eventBody.from, undefined);
  assert.equal(eventBody.section, 22);
  assert.equal(normalizeBitrix({ID:1, DATE_FROM:'02.11.2026 18:00:00', DATE_TO:'02.11.2026 19:00:00', TZ_OFFSET_FROM:'10800', TZ_OFFSET_TO:'10800', DATE_FROM_TS_UTC:String(start/1000-10800)}).start, start);
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    eventBody=JSON.parse(options.body);
    return {ok:true,json:async()=>({result:[{ID:'a',SECTION_ID:'22'},{ID:'b',SECTION_ID:'23'},{ID:'foreign',SECTION_ID:'99'}]})};
  });
  const {events}=await import('../src/bitrix.mjs');
  const rows=await context.run(first,()=>events(['22','23'],'2026-10-26','2026-12-03'));
  assert.deepEqual(eventBody.section,[22,23]);
  assert.deepEqual(rows.map(e=>e.ID),['a','b']);
});
