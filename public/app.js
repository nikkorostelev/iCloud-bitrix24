const token = document.querySelector('meta[name="session-token"]')?.content || '';
if (document.querySelector('meta[name="installation"]')?.content === 'true' && window.BX24) BX24.init(() => BX24.installFinish());
const $ = id => document.getElementById(id);
let statusData = null, previewToken = '', dirty = false, loading = false;
let sessionExpired = false;
let disconnectToken = '';
$('show-apple-password').onchange = event => { $('apple-password').type = event.target.checked ? 'text' : 'password'; };
function notice(message, kind = 'error') { $('notice').textContent = message; $('notice').className = `notice ${kind}`; $('notice').hidden = !message; }
async function api(path, body) {
  if (sessionExpired) throw new Error('Сессия истекла. Откройте приложение заново из Битрикс24');
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.status === 401) sessionExpired = true;
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Сервис временно недоступен. Повторите позже или откройте приложение заново из Битрикс24.');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function el(tag, text, className) { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; }
function invalidate() { dirty = true; previewToken = ''; $('run-button').disabled = true; }
function progress(data) {
  const p = data.syncProgress;
  $('last-run').textContent = data.busy ? p?.phase === 'reading' ? `Загрузка календарей: ${p.calendarsDone + 1} / ${p.calendarsTotal} · ${p.calendarName || ''}` : p?.phase === 'writing' ? `Перенесено: ${p.done} / ${p.total} · ${p.calendarName || ''} · ${p.title || ''}` : 'Синхронизация выполняется...' : data.lastSuccess ? `Проверка завершена: ${new Date(data.lastSuccess).toLocaleString('ru-RU')}` : 'Первая синхронизация ещё не выполнена';
  $('auto-enabled').checked = data.autoEnabled;
  $('auto-enabled').disabled = sessionExpired;
  $('sync-mode').textContent = data.autoEnabled ? data.autoWaitingReason ? `Автообмен включён. ${data.autoWaitingReason}. События пока не переносятся.` : `${data.eventsBound ? 'Битрикс24: по уведомлениям. ' : ''}iCloud: проверка изменений каждые ${data.pollSeconds} секунд. Полная проверка: каждые ${data.fullScanSeconds || 30} секунд.` : 'Автосинхронизация выключена';
  $('sync-summary').textContent = `Связано событий: ${data.pairCount}. Конфликтов: ${data.conflicts || 0}. Пропущено: ${data.skipped || 0}.`;
  const error = data.lastAutoError || data.eventBindingError;
  $('auto-error').hidden = !error;
  $('auto-error').textContent = error ? `${error}${data.nextRetryAt ? ` · Следующая попытка: ${new Date(data.nextRetryAt).toLocaleTimeString('ru-RU')}` : ''}` : '';
  $('results').replaceChildren(...data.lastResults.slice(-30).map(item => el('li', `${item.ok ? actionLabel(item.kind) : 'Ошибка'} · ${item.calendarName || ''} · ${item.title}${item.start ? ` · ${new Date(item.start).toLocaleString('ru-RU')}` : ''}${item.error ? ` · ${item.error}` : ''}`, item.ok ? 'ok' : 'bad')));
}
function calendarName(name, color) {
  const label = el('span', name);
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color || '')) { const swatch = el('span', null, 'swatch'); swatch.style.backgroundColor = color.slice(0,7); label.prepend(swatch, document.createTextNode(' ')); }
  return label;
}
function renderCalendars() {
  const data = statusData;
  const links = data.calendarLinks;
  $('calendar-counts').textContent = `iCloud: ${data.appleError ? 'недоступен' : data.calendars.length} · Битрикс24: ${data.bitrixError ? 'недоступен' : data.sections.length} · Связей: ${links.length}${data.pendingBitrixIds?.length ? ` · Ожидают подключения: ${data.pendingBitrixIds.length}` : ''}`;
  const unavailable = !!(data.appleError || data.bitrixError || !data.appleReady);
  $('config-form').querySelector('button[type="submit"]').disabled = !data.bitrixReady;
  $('select-bitrix').disabled = !data.bitrixReady;
  $('select-apple').disabled = unavailable;
  $('preview-button').disabled = unavailable || !!data.pendingBitrixIds?.length;
  const rows = links.map(link => {
    const tr = el('tr'), toggle = el('input'); toggle.type = 'checkbox'; toggle.checked = link.enabled; toggle.dataset.linkId = link.id; toggle.setAttribute('aria-label', `Синхронизировать ${link.bitrixName}`);
    const first = el('td'); first.append(toggle);
    const b = el('td', link.bitrixName), a = el('td', link.appleName);
    if (!link.available) a.className = 'missing';
    tr.append(first,b,a); return tr;
  });
  if (!rows.length) { const tr = el('tr'), td = el('td','Нет связанных календарей','empty'); td.colSpan = 3; tr.append(td); rows.push(tr); }
  $('calendar-links').replaceChildren(...rows);
  const usedB = new Set(links.map(l=>l.bitrixId)), usedA = new Set(links.map(l=>l.appleUrl));
  renderSources('apple', data.calendars.filter(c=>!usedA.has(c.url)), data.sections.filter(c=>!usedB.has(c.id)));
  renderSources('bitrix', data.sections.filter(c=>!usedB.has(c.id)), data.calendars.filter(c=>!usedA.has(c.url)));
}
function renderSources(side, sources, targets) {
  const nodes = sources.map(source => {
    const row = el('div', null, 'calendar-source'), label = el('label'), check = el('input'); check.type = 'checkbox'; check.dataset.sourceId = source.id || source.url;
    label.append(check, calendarName(source.name, source.color));
    const same = targets.filter(t=>t.name === source.name);
    row.dataset.targetId = same.length === 1 ? (same[0].id || same[0].url) : '';
    check.disabled = side === 'bitrix' ? !statusData.bitrixReady : !!(statusData.appleError || statusData.bitrixError || !statusData.appleReady);
    check.checked = side === 'bitrix' && !!statusData.pendingBitrixIds?.includes(check.dataset.sourceId);
    row.append(label); return row;
  });
  $(side+'-sources').replaceChildren(...(nodes.length ? nodes : [el('p','Все календари уже связаны или недоступны','source-empty')]));
}
async function loadStatus() {
  if (loading) return;
  loading = true;
  try {
    const data = await api('/api/status'); statusData = data;
    $('portal-domain').textContent = data.portal;
    $('apple-email').value = data.appleEmail; $('horizon-days').value = data.horizonDays;
    $('disconnect-apple').hidden = !data.appleReady;
    $('bitrix-identity').textContent = data.bitrixReady ? `Подключён: ${data.bitrixUser.name} · ID ${data.bitrixUser.id}` : 'Пользователь не подключён';
    $('status').textContent = data.appleReady && !data.appleError ? 'iCloud подключён' : 'iCloud ожидает подключения';
    $('status').className = data.appleReady && !data.appleError ? 'status good' : 'status';
    renderCalendars(); progress(data); dirty = false;
    if (data.bitrixError || data.appleError) notice(data.bitrixError || data.appleError);
    else notice('');
  } finally { loading = false; }
}
function additions() {
  const result = [], seen = new Set();
  for (const side of ['apple','bitrix']) for (const row of $(side+'-sources').querySelectorAll('.calendar-source')) {
    const input = row.querySelector('input'); if (!input.checked) continue;
    const targetId = row.dataset.targetId, sourceId = input.dataset.sourceId;
    const key = targetId ? JSON.stringify(side === 'apple' ? [targetId,sourceId] : [sourceId,targetId]) : `${side}:${sourceId}`;
    if (!seen.has(key)) result.push({ side, sourceId, targetId }); seen.add(key);
  }
  return result;
}
const actionLabel = kind => ({ link:'Связать', createApple:'В iCloud', createBitrix:'В Битрикс24', updateApple:'Обновить iCloud', updateBitrix:'Обновить Битрикс24', deleteApple:'Удалить в iCloud', deleteBitrix:'Удалить в Битрикс24', forgetPair:'Удалено с обеих сторон', conflict:'Конфликт', skip:'Пропустить' })[kind] || kind;
async function preview() {
  if (dirty) throw new Error('Сначала сохраните выбор календарей');
  previewToken = ''; $('run-button').disabled = true;
  const data = await api('/api/preview'); previewToken = data.previewToken;
  $('counts').textContent = `Битрикс24: ${data.bitrixCount} · iCloud: ${data.appleCount} · действий: ${data.actions.filter(a=>!['skip','conflict'].includes(a.kind)).length}`;
  const rows = data.actions.map(action => { const tr = el('tr',null,action.kind); for (const text of [actionLabel(action.kind),action.calendarName,action.title,action.start ? new Date(action.start).toLocaleString('ru-RU') : '',action.reason || '']) tr.append(el('td',text)); return tr; });
  if (!rows.length) { const tr = el('tr'), td = el('td','Изменений нет','empty'); td.colSpan = 5; tr.append(td); rows.push(tr); }
  $('actions').replaceChildren(...rows); $('run-button').disabled = false;
}
async function action(button, callback) { button.disabled = true; try { await callback(); } catch(error) { notice(error.message); } finally { button.disabled = button.id === 'run-button' && !previewToken; } }
$('apple-form').onsubmit = event => { event.preventDefault(); action(event.submitter,async()=>{ await api('/api/apple',{email:$('apple-email').value.trim(),password:$('apple-password').value}); $('apple-password').value=''; $('apple-password').type='password'; $('show-apple-password').checked=false; await loadStatus(); notice('iCloud подключён','success'); }); };
$('config-form').onchange = invalidate;
$('config-form').onsubmit = event => { event.preventDefault(); action(event.submitter,async()=>{
  const links = statusData.calendarLinks.map(l=>({id:l.id,enabled:document.querySelector(`input[data-link-id="${l.id}"]`).checked}));
  const selected=additions(), horizonDays=Number($('horizon-days').value);
  const deferred=!!(statusData.appleError || !statusData.appleReady);
  await api(deferred ? '/api/calendar-preferences' : '/api/config',deferred ? {links,bitrixIds:selected.filter(a=>a.side==='bitrix').map(a=>a.sourceId),horizonDays} : {links,additions:selected,horizonDays});
  await loadStatus(); previewToken=''; $('run-button').disabled=true;
  notice(deferred ? 'Выбор сохранён. iCloud сейчас недоступен. После восстановления подключения нажмите «Сохранить календари» для применения.' : 'Календари сохранены. Откройте предпросмотр и запустите синхронизацию.','success');
}); };
for (const side of ['apple','bitrix']) $('select-'+side).onclick = ()=>{ const inputs = [...$(side+'-sources').querySelectorAll('input')], checked = !inputs.every(i=>i.checked); inputs.forEach(i=>i.checked=checked); invalidate(); };
$('refresh-calendars').onclick = event => action(event.target,loadStatus);
$('preview-button').onclick = event => action(event.target,async()=>{ await preview(); notice(''); });
$('run-button').onclick = event => action(event.target,async()=>{
  if (!previewToken || !confirm('Синхронизировать показанные события и включить автоматическую проверку выбранных календарей?')) return;
  const result = await api('/api/run',{confirm:true,previewToken});
  const failure = result.results.find(r=>!r.ok); if (failure) throw new Error(failure.error);
  await api('/api/auto',{enabled:true}); previewToken=''; await loadStatus(); $('run-button').disabled=true; notice('Автоматическая синхронизация включена','success');
});
$('auto-enabled').onchange = event => action(event.target,async()=>{ const data = await api('/api/auto',{enabled:event.target.checked}); progress(data); });
$('disconnect-apple').onclick = event => action(event.target,async()=>{
  const data = await api('/api/disconnect-preview'); disconnectToken=data.previewToken;
  $('disconnect-calendars').replaceChildren(...data.calendars.map(c=>el('li',c.name)));
  $('delete-imported-calendars').checked=false;
  $('delete-imported-calendars').disabled=!data.calendars.length;
  $('disconnect-warning').hidden=!data.calendars.length;
  $('disconnect-preserved').textContent=data.preserved.length ? `Не будут удалены исходные или ранее связанные календари Битрикса: ${data.preserved.map(c=>c.name).join(', ')}.` : data.calendars.length ? '' : 'Нет календарей Битрикса, созданных этим приложением из iCloud.';
  $('disconnect-dialog').showModal();
});
$('disconnect-cancel').onclick=()=>$('disconnect-dialog').close();
$('disconnect-confirm').onclick=event=>action(event.target,async()=>{
  const result=await api('/api/disconnect',{confirm:true,deleteCalendars:$('delete-imported-calendars').checked,previewToken:disconnectToken});
  $('disconnect-dialog').close(); $('apple-password').value=''; $('apple-password').type='password'; $('show-apple-password').checked=false;
  previewToken=''; $('run-button').disabled=true; $('actions').replaceChildren(); $('counts').textContent='';
  await loadStatus(); notice(`iCloud отключён. Удалено календарей Битрикса: ${result.deleted.length}.`,'success');
});
loadStatus().catch(error=>notice(error.message));
setInterval(async()=>{ if(sessionExpired || !statusData || document.hidden) return; try { progress(await api('/api/progress')); } catch(error) { notice(error.message); } },2000);
