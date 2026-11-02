import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePortal,verifiedEndpoint,isPublicAddress} from '../src/portal.mjs';
test('portal addresses support cloud and custom domains without accepting URLs or local addresses',()=>{
  assert.equal(normalizePortal('Delovayasreda.bitrix24.ru'),'delovayasreda.bitrix24.ru');
  assert.equal(normalizePortal('crm.example.org'),'crm.example.org');
  assert.equal(verifiedEndpoint('https://crm.example.org/office/rest/','crm.example.org'),'https://crm.example.org/office/rest/');
  for (const invalid of ['localhost','127.0.0.1','https://example.org','good.example@evil.example','good.example/evil','good.example:8443','evil.example\r\nx:1']) assert.throws(()=>normalizePortal(invalid));
  assert.throws(()=>verifiedEndpoint('https://evil.example/rest/','crm.example.org'));
  assert.throws(()=>verifiedEndpoint('http://crm.example.org/rest/','crm.example.org'));
  assert.throws(()=>verifiedEndpoint('https://user:secret@crm.example.org/rest/','crm.example.org'));
});
test('outbound portal connections reject private, loopback and mapped private addresses',()=>{
  for (const address of ['127.0.0.1','10.0.0.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','not-an-ip']) assert.equal(isPublicAddress(address),false,address);
  assert.equal(isPublicAddress('8.8.8.8'),true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
});
