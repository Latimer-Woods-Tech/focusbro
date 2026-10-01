/**
 * FocusBro — GET /audio/* as the WORKER serves it.
 *
 * Drives the Worker's own fetch() (the precedent is
 * guides-served-by-worker.test.js) with a fake R2 binding that behaves like
 * R2: get() with an { offset, length } range returns that slice, head() returns
 * metadata, a missing key returns null. Every case FAILS on the tree before this
 * change, where /audio/* fell through to the JSON 404.
 */

import { describe, it, expect } from 'vitest';
import worker from '../index.js';
import { parseRange } from '../audio.js';

const NAME = 'rain.0123456789.m4a';
const BYTES = new Uint8Array(1000).map((_, i) => i % 251);

function fakeR2(objects) {
  const meta = (key) => ({ key, size: objects[key].length, httpEtag: `"etag-${key}"` });
  return {
    reads: [],
    async head(key) { return objects[key] ? meta(key) : null; },
    async get(key, opts = {}) {
      this.reads.push({ key, range: opts.range || null });
      const data = objects[key];
      if (!data) return null;
      const r = opts.range;
      const slice = r ? data.slice(r.offset, r.offset + r.length) : data;
      return { ...meta(key), range: r, body: new Response(slice).body };
    },
  };
}

const ctx = { waitUntil() {}, passThroughOnException() {} };
const call = (path, { env, method = 'GET', headers = {} } = {}) =>
  worker.fetch(new Request(`https://focusbro.net${path}`, { method, headers }), env, ctx);

describe('GET /audio/<name>.<sha10>.m4a', () => {
  it('streams the whole file from R2, typed, rangeable and immutable', async () => {
    const env = { AUDIO: fakeR2({ [NAME]: BYTES }) };
    const res = await call(`/audio/${NAME}`, { env });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mp4');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-length')).toBe('1000');
    expect(res.headers.get('etag')).toBe(`"etag-${NAME}"`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    // it goes through the same security boundary as every other response
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy-report-only') || res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('answers a byte range with 206 and the exact slice', async () => {
    const env = { AUDIO: fakeR2({ [NAME]: BYTES }) };
    const res = await call(`/audio/${NAME}`, { env, headers: { Range: 'bytes=100-199' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(res.headers.get('content-length')).toBe('100');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES.slice(100, 200));
    expect(env.AUDIO.reads.at(-1).range).toEqual({ offset: 100, length: 100 });

    const tail = await call(`/audio/${NAME}`, { env, headers: { Range: 'bytes=-10' } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(BYTES.slice(990));

    const open = await call(`/audio/${NAME}`, { env, headers: { Range: 'bytes=900-' } });
    expect(open.headers.get('content-range')).toBe('bytes 900-999/1000');
  });

  it('refuses an unsatisfiable range with 416 and the real size', async () => {
    const env = { AUDIO: fakeR2({ [NAME]: BYTES }) };
    const res = await call(`/audio/${NAME}`, { env, headers: { Range: 'bytes=5000-' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */1000');
  });

  it('answers HEAD with headers and no body', async () => {
    const env = { AUDIO: fakeR2({ [NAME]: BYTES }) };
    const res = await call(`/audio/${NAME}`, { env, method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('1000');
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it('404s a missing file, and never serves a name outside the hashed shape', async () => {
    const env = { AUDIO: fakeR2({ [NAME]: BYTES, 'sources/elevenlabs/keys_4.mp3': BYTES }) };
    expect((await call('/audio/fan.abcdef0123.m4a', { env })).status).toBe(404);
    for (const bad of ['/audio/rain.m4a', '/audio/sources%2Felevenlabs%2Fkeys_4.mp3', '/audio/..%2Fsecret', '/audio/RAIN.0123456789.m4a']) {
      const res = await call(bad, { env });
      expect(res.status, bad).toBe(404);
    }
    expect(env.AUDIO.reads.map((r) => r.key)).not.toContain('sources/elevenlabs/keys_4.mp3');
  });

  it('says so when the bucket is not bound, instead of pretending the file is gone', async () => {
    const res = await call(`/audio/${NAME}`, { env: {} });
    expect(res.status).toBe(503);
  });
});

describe('parseRange', () => {
  it('handles the single-range forms and rejects the rest', () => {
    expect(parseRange(null, 10)).toBeNull();
    expect(parseRange('bytes=0-4', 10)).toEqual({ offset: 0, length: 5 });
    expect(parseRange('bytes=5-', 10)).toEqual({ offset: 5, length: 5 });
    expect(parseRange('bytes=-3', 10)).toEqual({ offset: 7, length: 3 });
    expect(parseRange('bytes=-30', 10)).toEqual({ offset: 0, length: 10 });
    expect(parseRange('bytes=8-100', 10)).toEqual({ offset: 8, length: 2 });
    expect(parseRange('bytes=10-', 10)).toEqual({ invalid: true });
    expect(parseRange('bytes=5-2', 10)).toEqual({ invalid: true });
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull();
    expect(parseRange('items=0-1', 10)).toBeNull();
  });
});
