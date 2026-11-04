import test from 'node:test';
import assert from 'node:assert/strict';
import { publisherFor, validSync } from './publishers.mjs';

const api = 'https://api.example.test';
const sz = 'sz_agent_' + 'a'.repeat(64);
const kor = 'kor_pub_' + 'A1b2_-'.repeat(7) + 'x';
const ws = '0d5c5b4e-3f7a-4c1e-9a62-2b8f3c1d9e70';

test('a host defaults to SubZero and refuses unknown publishers', () => {
  assert.equal(publisherFor().label, 'Cocoa');
  assert.equal(publisherFor('koryo').label, 'Kaia');
  assert.throws(() => publisherFor('other'), /Unknown RDK_HOST_PUBLISHER/);
});

test('SubZero syncs need its agent token and a project number', () => {
  const p = publisherFor('subzero');
  assert.equal(validSync(p, api, { apiUrl: api, token: sz, projectId: 7 }), true);
  for (const body of [
    { apiUrl: api, token: sz, projectId: 0 },
    { apiUrl: api, token: sz, projectId: ws },
    { apiUrl: api, token: kor, projectId: 7 },
    { apiUrl: 'https://attacker.example', token: sz, projectId: 7 },
  ]) assert.equal(validSync(p, api, body), false, JSON.stringify(body));
});

test('Koryo syncs need a publisher credential and a workspace uuid', () => {
  const p = publisherFor('koryo');
  assert.equal(kor.length, 'kor_pub_'.length + 43);
  assert.equal(validSync(p, api, { apiUrl: api, token: kor, projectId: ws }), true);
  for (const body of [
    { apiUrl: api, token: sz, projectId: ws },
    { apiUrl: api, token: kor, projectId: 7 },
    { apiUrl: api, token: 'kor_key_' + 'a'.repeat(43), projectId: ws },
    { apiUrl: api, token: kor, projectId: '../../etc' },
    { apiUrl: 'https://attacker.example', token: kor, projectId: ws },
  ]) assert.equal(validSync(p, api, body), false, JSON.stringify(body));
});
