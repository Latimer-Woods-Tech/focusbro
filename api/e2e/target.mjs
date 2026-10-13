// Where the Playwright smoke runs (Site Quality Battery TB4).
//
// BASE_URL unset (the default, and every per-PR CI run): serve the built
// html.js on localhost:4173 with e2e/serve.mjs, exactly as before.
// BASE_URL set (the staging deploy job): drive that deployed host instead and
// start no local server. A remote target must be an https origin with no path,
// so a typo fails loudly instead of quietly testing localhost.
export const LOCAL_BASE_URL = 'http://localhost:4173';

/** @param {Record<string, string | undefined>} env usually process.env */
export function smokeTarget(env) {
  const raw = (env.BASE_URL || '').trim();
  if (!raw) {
    return {
      baseURL: LOCAL_BASE_URL,
      webServer: {
        command: 'node e2e/serve.mjs',
        url: `${LOCAL_BASE_URL}/`,
        reuseExistingServer: !env.CI,
        timeout: 20000,
      },
    };
  }
  let url;
  try { url = new URL(raw); } catch { throw new Error(`BASE_URL is not a URL: ${raw}`); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error(`BASE_URL must be https (or http on localhost): ${raw}`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`BASE_URL must be an origin with no path: ${raw}`);
  }
  return { baseURL: url.origin, webServer: undefined };
}
