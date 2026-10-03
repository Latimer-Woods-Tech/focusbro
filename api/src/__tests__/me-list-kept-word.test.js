/**
 * FocusBro — /me/ must render the word list when it holds a KEPT word.
 *
 * renderList() (the client half of /me/, an inline <script> string) labelled a
 * kept word's "next word" button with `esc(NEXT_WORD)` — an identifier defined
 * nowhere in the page. The template literal never interpolated it, so it
 * shipped as a bare reference, threw a ReferenceError on the first kept word,
 * and loadList()'s `.catch(function () {})` swallowed it: every person who had
 * kept a one-off word saw an EMPTY list — no active words, no check-in times,
 * no buttons — while the API returned them all with a 200.
 *
 * This suite pulls the REAL renderList out of the built page and runs it with
 * only the collaborators it is meant to have. A free identifier is a
 * ReferenceError here exactly as it is in the browser. Proof of rejection:
 * restore `esc(NEXT_WORD)` and the kept-word case throws.
 */
import { describe, it, expect } from 'vitest';
import { renderMePage, nextWordActionLabel } from '../me.js';

function extractFunction(source, name) {
  const sig = 'function ' + name + '(';
  const start = source.indexOf(sig);
  if (start === -1) throw new Error('function ' + name + ' not found in page');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces extracting ' + name);
}

function buildRenderList(source = renderMePage()) {
  const host = { innerHTML: '' };
  const factory = new Function(
    'el', 'esc', 'present', 'fmtWhen', 'nextCheckinLineHTML', 'editFormHTML',
    extractFunction(source, 'renderList') + '\nreturn renderList;'
  );
  const renderList = factory(
    () => host,
    (s) => String(s == null ? '' : s),
    (status) => ({ tone: status, label: status }),
    () => 'WHEN',
    () => '',
    () => '',
  );
  return { renderList, host };
}

const word = (status, title) => ({
  id: title.replace(/\W+/g, '-'), title, status, recurrence: 'none',
  start_at: '2026-10-03T14:00:00.000Z', next_checkin: null,
});

describe('/me/ word list with a kept word in it', () => {
  it('renders every word, and the kept one offers the next word', () => {
    const { renderList, host } = buildRenderList();
    renderList([word('active', 'Start the taxes'), word('kept', 'Reply to that one email')]);
    expect(host.innerHTML).toContain('Start the taxes');
    expect(host.innerHTML).toContain('Reply to that one email');
    expect(host.innerHTML).toContain('data-act="next-word"');
    expect(host.innerHTML).toContain(nextWordActionLabel());
  });

  it('proof of rejection: the old bare NEXT_WORD reference throws on a kept word', () => {
    const label = JSON.stringify(nextWordActionLabel());
    const broken = renderMePage().replace(`esc(${label})`, 'esc(NEXT_WORD)');
    expect(broken).not.toBe(renderMePage());
    const { renderList } = buildRenderList(broken);
    expect(() => renderList([word('kept', 'Reply to that one email')])).toThrow(ReferenceError);
  });
});
