import test from 'node:test';
import assert from 'node:assert/strict';
import { assignFocusBroNumber } from './assign-focusbro-10dlc.mjs';

const campaign = '4b3001a1-1919-1fc2-1b54-7a04777910f8';
const number = '+17176070456';
const reply = (body) => ({ ok: true, json: async () => body });

function fakeFetch(campaignStatus, assignments, created, carrierStatus = campaignStatus === 'ACTIVE' ? 'MNO_PROVISIONED' : campaignStatus) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method || 'GET', body: options.body });
    if (url.endsWith(`/10dlc/campaign/${campaign}`)) return reply({ status: campaignStatus, campaignStatus: carrierStatus });
    if (options.method === 'POST') return reply(created);
    return reply({ records: assignments });
  };
  return { calls, fetchImpl };
}

test('waits for campaign approval without attempting an assignment', async () => {
  const fake = fakeFetch('TCR_PENDING', []);
  assert.deepEqual(await assignFocusBroNumber({ apiKey: 'test', fetchImpl: fake.fetchImpl }),
    { ready: false, state: 'TCR_PENDING' });
  assert.equal(fake.calls.length, 1);
});

test('waits for carrier provisioning even when Telnyx marks the campaign active', async () => {
  const fake = fakeFetch('ACTIVE', [], undefined, 'TCR_ACCEPTED');
  assert.deepEqual(await assignFocusBroNumber({ apiKey: 'test', fetchImpl: fake.fetchImpl }),
    { ready: false, state: 'TCR_ACCEPTED' });
  assert.equal(fake.calls.length, 1);
});

test('assigns the dedicated number once, then waits for provisioning', async () => {
  const fake = fakeFetch('ACTIVE', [], { assignmentStatus: 'PROCESSING' });
  assert.deepEqual(await assignFocusBroNumber({ apiKey: 'test', fetchImpl: fake.fetchImpl }),
    { ready: false, state: 'PROCESSING' });
  assert.equal(fake.calls[2].method, 'POST');
  assert.deepEqual(JSON.parse(fake.calls[2].body), { phoneNumber: number, campaignId: campaign });
});

test('recognizes completed assignment without creating another', async () => {
  const fake = fakeFetch('ACTIVE', [{ phoneNumber: number, campaignId: campaign, assignmentStatus: 'ASSIGNED' }]);
  assert.deepEqual(await assignFocusBroNumber({ apiKey: 'test', fetchImpl: fake.fetchImpl }),
    { ready: true, state: 'ASSIGNED' });
  assert.equal(fake.calls.length, 2);
});

test('refuses to overwrite an unrelated assignment', async () => {
  const fake = fakeFetch('ACTIVE', [{ phoneNumber: number, campaignId: 'another', assignmentStatus: 'ASSIGNED' }]);
  await assert.rejects(assignFocusBroNumber({ apiKey: 'test', fetchImpl: fake.fetchImpl }), /another campaign/);
  assert.equal(fake.calls.length, 2);
});
