import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import ipaddr from 'ipaddr.js';

export function normalizePortal(domain) {
  if (typeof domain !== 'string') throw new Error('Не передан адрес портала Битрикс24');
  const value=domain.toLowerCase();
  if (value.length > 253 || !value.includes('.') || !value.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || isIP(value)) throw new Error('Некорректный адрес портала Битрикс24');
  return value;
}
export function verifiedEndpoint(endpoint, domain) {
  const url=new URL(endpoint);
  if (url.protocol!=='https:' || url.username || url.password || url.port || url.search || url.hash || !/^\/(?:[a-zA-Z0-9_-]+\/)*rest\/$/.test(url.pathname) || normalizePortal(url.hostname)!==normalizePortal(domain)) throw new Error('OAuth вернул другой адрес портала');
  return url.href;
}
export function isPublicAddress(address) {
  try { return ipaddr.process(address).range()==='unicast'; } catch { return false; }
}
// Every new connection validates and pins DNS; established HTTPS connections can be reused.
const dispatcher=new Agent({connections:2,connect:{lookup:(hostname, settings, callback)=>{
    lookup(hostname,{all:true,verbatim:true}).then(addresses=>{
      if (!addresses.length || addresses.some(item=>!isPublicAddress(item.address))) throw new Error('Портал должен быть доступен по публичному HTTPS-адресу');
      if (settings.all) callback(null,addresses);
      else callback(null,addresses[0].address,addresses[0].family);
    }).catch(error=>callback(error));
  }}});
export async function portalFetch(url, options) {
    const response=await fetch(url,{...options,dispatcher,redirect:'error'});
    const data=await response.json();
    return {ok:response.ok,status:response.status,data};
}
