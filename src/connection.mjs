import { createHash } from 'node:crypto';
import { account, saveAccount } from './config.mjs';
import { calendarLinks } from './calendars.mjs';
import { sections, deleteBitrixCalendar } from './bitrix.mjs';
import { forgetAppleClients } from './icloud.mjs';

const defaults = {sections, deleteBitrixCalendar, forgetAppleClients};
export async function disconnectPreview(services = defaults) {
  const value = account();
  const owned = await services.sections();
  const links = calendarLinks(value.config);
  const ids = new Set(links.filter(link=>link.createdBitrix === true).map(link=>link.bitrixId));
  const calendars = owned.filter(c=>ids.has(c.id)).map(c=>({id:c.id,name:c.name}));
  const preserved = links.filter(link=>link.createdBitrix !== true).map(link=>({id:link.bitrixId,name:owned.find(c=>c.id===link.bitrixId)?.name || link.bitrixName || link.bitrixId}));
  const previewToken = createHash('sha256').update(JSON.stringify({id:value.id,links,calendars})).digest('hex');
  return {calendars,preserved,previewToken};
}

export async function disconnectApple({confirm,deleteCalendars,previewToken}, services = defaults) {
  if (confirm !== true || typeof deleteCalendars !== 'boolean') throw new Error('Подтвердите отключение iCloud');
  const preview = await disconnectPreview(services);
  if (preview.previewToken !== previewToken) throw new Error('Список календарей изменился. Откройте отключение заново');
  const value = account();
  value.config.autoEnabled = false;
  await saveAccount(value);
  const deleted = [];
  if (deleteCalendars) {
    for (const calendar of preview.calendars) {
      await services.deleteBitrixCalendar(calendar.id);
      const removed = new Set(calendarLinks(value.config).filter(l=>l.bitrixId===calendar.id).map(l=>l.id));
      value.config.calendarLinks = calendarLinks(value.config).filter(l=>!removed.has(l.id));
      value.state.pairs = (value.state.pairs || []).filter(p=>!removed.has(p.calendarLinkId || 'legacy'));
      await saveAccount(value);
      deleted.push(calendar);
    }
  }
  delete value.applePassword;
  for (const key of ['appleEmail','appleDiscovery','sectionId','calendarUrl','pendingBitrixIds']) delete value.config[key];
  value.config.calendarLinks = [];
  value.state = {pairs:[],initializedLinks:{}};
  services.forgetAppleClients();
  await saveAccount(value);
  return {ok:true,deleted,preserved:preview.preserved};
}
