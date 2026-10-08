#!/usr/bin/env node
// Assign FocusBro's existing number after carrier approval. Safe to run daily.
import { appendFileSync } from 'node:fs';

const API = 'https://api.telnyx.com/v2';
const CAMPAIGN = '4b3001a1-1919-1fc2-1b54-7a04777910f8';
const NUMBER = '+17176070456';

export async function assignFocusBroNumber({ apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('TELNYX_API_KEY is required');
  async function request(path, options = {}) {
    const response = await fetchImpl(`${API}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    const body = await response.json();
    if (!response.ok) {
      const detail = body.errors?.[0]?.detail || body.errors?.[0]?.title || 'unknown error';
      throw new Error(`Telnyx HTTP ${response.status}: ${detail}`);
    }
    return body;
  }

  const campaign = await request(`/10dlc/campaign/${CAMPAIGN}`);
  if (campaign.status !== 'ACTIVE') {
    return { ready: false, state: campaign.campaignStatus || campaign.status || 'pending' };
  }

  const listed = await request('/10dlc/phoneNumberCampaign');
  const records = listed.records || [];
  const current = records.find((record) => record.phoneNumber === NUMBER);
  if (current && current.campaignId !== CAMPAIGN) {
    throw new Error('FocusBro number is assigned to another campaign');
  }
  if (current) {
    return { ready: current.assignmentStatus === 'ASSIGNED', state: current.assignmentStatus };
  }

  const created = await request('/10dlc/phoneNumberCampaign', {
    method: 'POST',
    body: JSON.stringify({ phoneNumber: NUMBER, campaignId: CAMPAIGN }),
  });
  return { ready: created.assignmentStatus === 'ASSIGNED', state: created.assignmentStatus || 'processing' };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const result = await assignFocusBroNumber({ apiKey: process.env.TELNYX_API_KEY });
    console.log(`FocusBro 10DLC assignment: ${result.state}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `ready=${result.ready}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
