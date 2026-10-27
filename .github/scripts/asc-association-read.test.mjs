import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { makeJwt, summarize, HOST, PATH } from './asc-association-read.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

test('jwt: ES256, valid signature, lives 5 minutes, audience pinned', () => {
  const [h, b, s] = makeJwt(pem, 'KEYID12345', 'issuer-x', 1000).split('.');
  const head = JSON.parse(Buffer.from(h, 'base64url'));
  const body = JSON.parse(Buffer.from(b, 'base64url'));
  assert.deepEqual(head, { alg: 'ES256', kid: 'KEYID12345', typ: 'JWT' });
  assert.equal(body.exp - body.iat, 300);
  assert.equal(body.aud, 'appstoreconnect-v1');
  assert.ok(createVerify('SHA256').update(`${h}.${b}`).verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('request target is the fixed host and the single identifier filter', () => {
  assert.equal(HOST, 'https://api.appstoreconnect.apple.com');
  assert.equal(decodeURIComponent(PATH), '/v1/bundleIds?filter[identifier]=net.focusbro.app');
});

const row = (identifier, seedId) => ({ attributes: { identifier, seedId, name: 'SECRETNAME' } });
test('exactly one matching row with the wanted seedId is a match, and nothing else leaks', () => {
  const r = summarize(200, JSON.stringify({ data: [row('net.focusbro.app', '22W56AM87W')], links: { self: 'SECRETLINK' } }));
  assert.equal(r.ok, true);
  assert.ok(!r.lines.join('\n').includes('SECRET'));
});
test('proof of rejection: wrong seed, no rows, two rows, a different identifier, non-200 and non-JSON all STOP', () => {
  const bad = [
    summarize(200, JSON.stringify({ data: [row('net.focusbro.app', 'ABCDE12345')] })),
    summarize(200, JSON.stringify({ data: [] })),
    summarize(200, JSON.stringify({ data: [row('net.focusbro.app', '22W56AM87W'), row('net.focusbro.app.x', '22W56AM87W')] })),
    summarize(200, JSON.stringify({ data: [row('net.focusbro.other', '22W56AM87W')] })),
    summarize(401, JSON.stringify({ errors: [{ detail: 'SECRETDETAIL' }] })),
    summarize(200, 'not json SECRETBODY'),
  ];
  for (const r of bad) {
    assert.equal(r.ok, false);
    assert.ok(!r.lines.join('\n').includes('SECRET'));
  }
});
