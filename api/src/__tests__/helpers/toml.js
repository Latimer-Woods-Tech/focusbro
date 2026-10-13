// Minimal TOML reader shared by the wrangler.toml static tests
// (wrangler-isolation.test.js, staging-env.test.js). No dependency.
// Handles tables, array tables, strings, numbers, bools, inline
// tables, (multi-line) arrays, comments. Enough for wrangler.toml.
export function parseToml(src) {
  let i = 0;
  const root = {};
  let cur = root;
  const ws = () => { while (i < src.length && /[ \t\r\n]/.test(src[i])) i++; };
  const skipLine = () => { while (i < src.length && src[i] !== '\n') i++; };
  const skipWsComments = () => {
    for (;;) { ws(); if (src[i] === '#') skipLine(); else return; }
  };
  const str = () => {
    const q = src[i++]; let out = '';
    while (i < src.length && src[i] !== q) {
      if (q === '"' && src[i] === '\\') { i++; out += src[i++]; } else out += src[i++];
    }
    i++; return out;
  };
  const key = () => {
    ws();
    if (src[i] === '"' || src[i] === "'") return str();
    const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i));
    if (!m) throw new Error('toml: bad key at ' + i);
    i += m[0].length; return m[0];
  };
  const value = () => {
    skipWsComments();
    const c = src[i];
    if (c === '"' || c === "'") return str();
    if (c === '[') {
      i++; const arr = [];
      for (;;) {
        skipWsComments();
        if (src[i] === ']') { i++; return arr; }
        arr.push(value()); skipWsComments();
        if (src[i] === ',') i++;
      }
    }
    if (c === '{') {
      i++; const obj = {};
      for (;;) {
        skipWsComments();
        if (src[i] === '}') { i++; return obj; }
        const k = key(); skipWsComments();
        if (src[i] !== '=') throw new Error('toml: expected = at ' + i);
        i++; obj[k] = value(); skipWsComments();
        if (src[i] === ',') i++;
      }
    }
    const m = /^[^\s,\]}#]+/.exec(src.slice(i));
    i += m[0].length;
    if (m[0] === 'true') return true;
    if (m[0] === 'false') return false;
    return Number.isNaN(Number(m[0])) ? m[0] : Number(m[0]);
  };
  const descend = (path, isArray) => {
    let o = root;
    path.forEach((p, n) => {
      const last = n === path.length - 1;
      if (last && isArray) { (o[p] ||= []).push({}); o = o[p][o[p].length - 1]; return; }
      o = Array.isArray(o[p]) ? o[p][o[p].length - 1] : (o[p] ||= {});
    });
    return o;
  };
  while (i < src.length) {
    skipWsComments();
    if (i >= src.length) break;
    if (src[i] === '[') {
      const isArray = src[i + 1] === '[';
      i += isArray ? 2 : 1;
      const path = [];
      for (;;) { path.push(key()); ws(); if (src[i] === '.') { i++; continue; } break; }
      i += isArray ? 2 : 1;
      cur = descend(path, isArray);
    } else {
      const k = key(); ws();
      if (src[i] !== '=') throw new Error('toml: expected = at ' + i);
      i++; cur[k] = value();
    }
  }
  return root;
}
