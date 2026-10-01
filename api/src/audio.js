/**
 * FocusBro — the ambient recordings, served from R2.
 *
 * GET/HEAD /audio/<name>.<sha10>.m4a streams one of the files built by
 * scripts/audio/build.py from the AUDIO bucket (focusbro-audio). The names are
 * content-hashed, so a URL's bytes never change: the response is cacheable
 * forever, by the browser and by the service worker. Range requests are honoured
 * (206 + Content-Range), because a media element or a resumed download asks for
 * bytes in pieces; the app itself fetches whole files.
 *
 * Only names of exactly that shape are served. The bucket also holds the raw
 * ElevenLabs takes under sources/ (kept for provenance, since a generation
 * cannot be repeated) and those are deliberately unreachable from here.
 */

export const AUDIO_FILE_RE = /^[a-z0-9-]+\.[0-9a-f]{10}\.m4a$/;

const IMMUTABLE = 'public, max-age=31536000, immutable';

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * Parse a single-range `Range: bytes=…` header against an object size.
 * Returns null for "no usable range" (serve the whole file), { invalid: true }
 * for an unsatisfiable one, else { offset, length }.
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // multi-range or junk: whole file, as RFC 9110 allows
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return { invalid: true };
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(m[1]);
  if (start >= size) return { invalid: true };
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < start) return { invalid: true };
  return { offset: start, length: end - start + 1 };
}

export async function serveAudio(request, env) {
  const url = new URL(request.url);
  const name = decodeURIComponent(url.pathname.slice('/audio/'.length));
  if (!AUDIO_FILE_RE.test(name)) return json(404, { error: 'Not found' });
  if (!env || !env.AUDIO) return json(503, { error: 'Audio storage is not configured' });

  const base = {
    'Content-Type': 'audio/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': IMMUTABLE,
    'X-Content-Type-Options': 'nosniff',
  };

  try {
    const rangeHeader = request.headers.get('Range');
    if (rangeHeader) {
      const head = await env.AUDIO.head(name);
      if (!head) return json(404, { error: 'Not found' });
      const range = parseRange(rangeHeader, head.size);
      if (range && range.invalid) {
        return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${head.size}` } });
      }
      if (range) {
        const obj = await env.AUDIO.get(name, { range: { offset: range.offset, length: range.length } });
        if (!obj) return json(404, { error: 'Not found' });
        return new Response(obj.body, {
          status: 206,
          headers: {
            ...base,
            ETag: obj.httpEtag,
            'Content-Length': String(range.length),
            'Content-Range': `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`,
          },
        });
      }
    }

    const ifNoneMatch = request.headers.get('If-None-Match');
    const obj = await env.AUDIO.get(name);
    if (!obj) return json(404, { error: 'Not found' });
    if (ifNoneMatch && ifNoneMatch === obj.httpEtag) {
      return new Response(null, { status: 304, headers: { ...base, ETag: obj.httpEtag } });
    }
    return new Response(obj.body, {
      status: 200,
      headers: { ...base, ETag: obj.httpEtag, 'Content-Length': String(obj.size) },
    });
  } catch (e) {
    console.error('audio: R2 read failed:', e && e.message);
    return json(502, { error: 'Audio storage unavailable' });
  }
}
