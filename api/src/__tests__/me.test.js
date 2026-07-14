/**
 * FocusBro — Consumer accountability front door tests (Contender #10, Phase A).
 *
 * The consumer page (/me/) is the one surface where a person sees their OWN list
 * of words — the exact place a to-do app becomes a guilt engine, showing past
 * misses in red. This suite extends the ONE design LAW (never shame) to that
 * surface: every consumer-facing string fails the build on a shaming word, the
 * banned "AI" branding, or a clinical/treatment claim — and a `missed`
 * commitment must render as an open door, never a failure tally.
 */

import { describe, it, expect } from 'vitest';
import {
  COMMITMENT_STATUSES,
  statusPresentation,
  mePageIntroCopy,
  giveWordHeadingCopy,
  emptyCommitmentsCopy,
  streakHeadingCopy,
  checkinActionLabels,
  keptLogHeadingCopy,
  keptLogEmptyCopy,
  mePageFootnoteCopy,
  firstRunHeadingCopy,
  firstRunBodyCopy,
  firstRunExamplesLabel,
  firstRunExamples,
  reentryHeadingCopy,
  reentryBodyCopy,
  returnWelcomeHeadingCopy,
  returnWelcomeBodyCopy,
  entryState,
  meCopySurface,
  renderMePage,
  carryOverNoteCopy,
  escalationCeilingHeadingCopy,
  escalationCeilingIntroCopy,
  escalationCeilingOptions,
  escalationCeilingVoiceSoonCopy,
} from '../me.js';
import {
  momentumSelfHeadingCopy,
  momentumSelfIntroCopy,
  momentumSelfSummaryCopy,
  personalBestCopy,
} from '../accountability.js';

const SHAME_PATTERNS = [
  /\bfail(ed|ure|ing|s)?\b/i,
  /\blaz(y|iness)\b/i,
  /\bdisappoint/i,
  /\bguilt/i,
  /\bashamed\b/i,
  /\bshame\b/i,
  /\byou (didn.?t|should have|should.?ve)\b/i,
  /\bfall(ing|en)? behind\b/i,
  /\bbehind\b/i,
  /\bexcuse/i,
  /\bslack(ing|er|ed)? off\b/i,
  /\bpathetic\b/i,
  /\bworthless\b/i,
  /\bmiss(ed|es|ing)?\b/i, // no miss tally in what the person reads
];
const CLINICAL_PATTERNS = [/\btreat(s|ment|ing)?\b/i, /\bcure/i, /\bdiagnos/i, /\bdisorder/i, /\bsymptom/i, /\bADHD\b/i, /\bmedication\b/i];
const AI_WORD = /\bAI\b/; // case-sensitive: the banned branding, not "again"/"said"

describe('commitment statuses', () => {
  it('exposes the six lifecycle states', () => {
    expect(COMMITMENT_STATUSES).toEqual(['active', 'kept', 'missed', 'rescheduled', 'released', 'paused']);
  });

  it('every status presents a non-empty label and a known, non-shame tone', () => {
    for (const s of COMMITMENT_STATUSES) {
      const p = statusPresentation(s);
      expect(typeof p.label).toBe('string');
      expect(p.label.trim().length).toBeGreaterThan(0);
      expect(['active', 'kept', 'moved', 'open']).toContain(p.tone);
    }
  });

  it('an unknown status falls back to the neutral active presentation', () => {
    expect(statusPresentation('nonsense').tone).toBe('active');
    expect(statusPresentation(undefined).tone).toBe('active');
  });
});

describe('the design LAW extends to the consumer view', () => {
  const surface = meCopySurface();

  it('curates a non-empty copy surface covering every user-facing string', () => {
    expect(surface.length).toBeGreaterThan(0);
    for (const s of surface) {
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  it('never emits a shaming word', () => {
    for (const s of surface) {
      for (const pat of SHAME_PATTERNS) {
        expect(pat.test(s), `shaming copy: "${s}" matched ${pat}`).toBe(false);
      }
    }
  });

  it('never emits the word "AI"', () => {
    for (const s of surface) {
      expect(AI_WORD.test(s), `"AI" leaked into copy: "${s}"`).toBe(false);
    }
  });

  it('never makes a clinical or treatment claim', () => {
    for (const s of surface) {
      for (const pat of CLINICAL_PATTERNS) {
        expect(pat.test(s), `clinical claim in copy: "${s}" matched ${pat}`).toBe(false);
      }
    }
  });
});

describe('a missed word is an open door, never a failure', () => {
  it('the missed status does not read as a failure or a tally', () => {
    const p = statusPresentation('missed');
    expect(p.tone).toBe('open');
    expect(/fail|missed|behind/i.test(p.label)).toBe(false);
  });

  it('the footnote promises the always-open try-again door', () => {
    const foot = mePageFootnoteCopy().toLowerCase();
    expect(foot).toMatch(/try again/);
    expect(foot).toContain('ally');
  });
});

describe('your own kept-word momentum copy — first person, momentum-only', () => {
  const strings = [
    momentumSelfHeadingCopy(),
    momentumSelfIntroCopy(),
    momentumSelfSummaryCopy({ total: 0, days: 14 }),
    momentumSelfSummaryCopy({ total: 1, days: 14, peak: { count: 1 } }),
    momentumSelfSummaryCopy({ total: 9, days: 14, peak: { count: 3 } }),
  ];

  it('never shames, never brands "AI", never makes a clinical claim', () => {
    for (const s of strings) {
      for (const pat of SHAME_PATTERNS) expect(pat.test(s), `shame in: ${s}`).toBe(false);
      for (const pat of CLINICAL_PATTERNS) expect(pat.test(s), `clinical in: ${s}`).toBe(false);
      expect(AI_WORD.test(s), `AI branding in: ${s}`).toBe(false);
    }
  });

  it('speaks in the first person (your/you), not the coach third person (their)', () => {
    expect(momentumSelfIntroCopy().toLowerCase()).toContain('you');
    expect(momentumSelfIntroCopy().toLowerCase()).not.toContain('their');
    expect(momentumSelfSummaryCopy({ total: 9, days: 14, peak: { count: 3 } })).toContain('You kept');
    expect(momentumSelfSummaryCopy({ total: 9, days: 14, peak: { count: 3 } })).toContain('Your best day');
  });

  it('a quiet window reads as a fresh start, never a tally of what was not done', () => {
    const quiet = momentumSelfSummaryCopy({ total: 0, days: 14 });
    expect(quiet.toLowerCase()).toMatch(/clean page|fresh start/);
  });

  it('is singular/plural correct on the kept count', () => {
    expect(momentumSelfSummaryCopy({ total: 1, days: 14, peak: { count: 1 } })).toContain('1 word ');
    expect(momentumSelfSummaryCopy({ total: 2, days: 14, peak: { count: 1 } })).toContain('2 words ');
  });
});

describe('renderMePage', () => {
  const html = renderMePage();

  it('is a self-contained, noindex HTML document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).toContain('</html>');
  });

  it('drives the accountability API (commitments, streak, and the kept-word log)', () => {
    expect(html).toContain('/api/commitments');
    expect(html).toContain('/api/accountability/streak');
    expect(html).toContain('/api/accountability/kept');
    expect(html).toContain('/auth/login');
    expect(html).toContain('/auth/register');
    expect(html).toContain('focusbro_token');
  });

  it('renders the curated copy into the page', () => {
    expect(html).toContain(giveWordHeadingCopy());
    expect(html).toContain(streakHeadingCopy());
    expect(html).toContain(emptyCommitmentsCopy());
    expect(html).toContain(mePageIntroCopy());
    expect(html).toContain(keptLogHeadingCopy());
    expect(html).toContain(keptLogEmptyCopy());
    const A = checkinActionLabels();
    expect(html).toContain(A.kept);
    expect(html).toContain(A.missed);
  });

  it('wires the in-place edit affordance (button, inline form, and the edit route)', () => {
    expect(html).toContain('/edit');            // the edit endpoint the form posts to
    expect(html).toContain("data-act=\"edit\"");  // the Edit button (delegated)
    expect(html).toContain('edit-save');        // save/cancel on the inline form
    expect(html).toContain('editFormHTML');     // the inline edit form is rendered
  });

  it('wires the per-word detail affordance (View button, panel container, and the detail route)', () => {
    expect(html).toContain("data-act=\"view\"");  // the View button (delegated)
    expect(html).toContain('data-detail=');       // the inline detail panel container
    expect(html).toContain('/detail');            // the detail endpoint openDetail fetches
    expect(html).toContain('openDetail');         // the toggle/fetch function
    expect(html).toContain('renderDetail');       // the momentum-only panel renderer
  });

  it('renders your own kept-word momentum sparkline (their wins, their eyes)', () => {
    expect(html).toContain('id="momentumCard"');     // the panel, hidden until a first kept word
    expect(html).toContain('id="momentum"');         // the render host
    expect(html).toContain(momentumSelfHeadingCopy()); // "Your momentum"
    expect(html).toContain('function renderMomentum'); // the client-side renderer
    expect(html).toContain('data.momentum');           // fed from the kept endpoint response
    expect(html).toContain('.spark-bar');              // the scaled bar styles
    expect(html).toContain('spark-bar zero');          // a quiet day is a grey baseline bar, not a gap
    expect(html).toContain('role="img"');              // the sparkline is a labelled image
  });
});

describe('gentle first-run onboarding seeds the first word', () => {
  const html = renderMePage();

  it('exposes warm, non-empty first-run copy and at least three example seeds', () => {
    expect(firstRunHeadingCopy().trim().length).toBeGreaterThan(0);
    expect(firstRunBodyCopy().trim().length).toBeGreaterThan(0);
    expect(firstRunExamplesLabel().trim().length).toBeGreaterThan(0);
    expect(Array.isArray(firstRunExamples())).toBe(true);
    expect(firstRunExamples().length).toBeGreaterThanOrEqual(3);
    for (const ex of firstRunExamples()) {
      expect(typeof ex).toBe('string');
      expect(ex.trim().length).toBeGreaterThan(0);
    }
  });

  it('renders the first-run panel, its copy, and tappable example seeds', () => {
    expect(html).toContain('id="firstRun"');
    expect(html).toContain(firstRunHeadingCopy());
    expect(html).toContain(firstRunBodyCopy());
    expect(html).toContain(firstRunExamplesLabel());
    expect(html).toContain('data-seed=');
    for (const ex of firstRunExamples()) expect(html).toContain(ex);
  });

  it('shows the panel only on an empty list and hides it once a word exists', () => {
    // The panel starts hidden and is toggled by updateFirstRun from the live
    // commitments load — an empty list reveals it, any word hides it.
    expect(html).toContain('class="card firstrun hidden"');
    expect(html).toContain('updateFirstRun');
  });

  it('a tapped seed fills the title only — it never assumes a time or auto-commits', () => {
    // The seed handler sets the title and moves focus to When?; there is no
    // fetch/submit tied to a seed tap, so a time is never assumed for the person.
    expect(html).toContain('button[data-seed]');
    expect(html).toContain("el('startAt')");
  });

  it('folds the first-run copy into the design-LAW surface (so it is gate-scanned)', () => {
    const surface = meCopySurface();
    expect(surface).toContain(firstRunHeadingCopy());
    expect(surface).toContain(firstRunBodyCopy());
    expect(surface).toContain(firstRunExamplesLabel());
    for (const ex of firstRunExamples()) expect(surface).toContain(ex);
  });
});

describe('a returning person is welcomed back, never cold-started or scolded', () => {
  const html = renderMePage();

  it('exposes warm, non-empty re-entry copy', () => {
    expect(reentryHeadingCopy().trim().length).toBeGreaterThan(0);
    expect(reentryBodyCopy().trim().length).toBeGreaterThan(0);
  });

  it('the re-entry copy never shames, brands "AI", or makes a clinical claim', () => {
    for (const s of [reentryHeadingCopy(), reentryBodyCopy()]) {
      for (const pat of SHAME_PATTERNS) expect(pat.test(s), `shame in re-entry copy: "${s}" matched ${pat}`).toBe(false);
      expect(AI_WORD.test(s), `"AI" in re-entry copy: "${s}"`).toBe(false);
      for (const pat of CLINICAL_PATTERNS) expect(pat.test(s), `clinical in re-entry copy: "${s}"`).toBe(false);
    }
  });

  it('entryState routes the three entry moments from the live commitments list', () => {
    // No words ever → the first-run activation moment.
    expect(entryState([])).toBe('first-word');
    expect(entryState(undefined)).toBe('first-word');
    // History but nothing in flight → the warm welcome-back door.
    expect(entryState([{ status: 'kept' }, { status: 'released' }])).toBe('welcome-back');
    expect(entryState([{ status: 'missed' }])).toBe('welcome-back');
    // An active or paused word exists → no banner, just the work.
    expect(entryState([{ status: 'kept' }, { status: 'active' }])).toBe('in-flight');
    expect(entryState([{ status: 'paused' }])).toBe('in-flight');
  });

  it('renders the re-entry panel and its copy, hidden until the toggle reveals it', () => {
    expect(html).toContain('id="reentry"');
    expect(html).toContain('class="card firstrun hidden"');
    expect(html).toContain(reentryHeadingCopy());
    expect(html).toContain(reentryBodyCopy());
    // One toggle drives both banners so they can never both show at once.
    expect(html).toContain('updateFirstRun');
    expect(html).toContain('entryState');
  });

  it('folds the re-entry copy into the design-LAW surface (so it is gate-scanned)', () => {
    const surface = meCopySurface();
    expect(surface).toContain(reentryHeadingCopy());
    expect(surface).toContain(reentryBodyCopy());
  });
});

describe('a nudged-back person is greeted, never questioned about the gap (#40 W4/L3)', () => {
  const html = renderMePage();

  it('exposes warm, non-empty nudged-back welcome copy that is distinct from the generic door', () => {
    expect(returnWelcomeHeadingCopy().trim().length).toBeGreaterThan(0);
    expect(returnWelcomeBodyCopy().trim().length).toBeGreaterThan(0);
    // A different, warmer greeting than the generic re-entry door — not a rename.
    expect(returnWelcomeHeadingCopy()).not.toBe(reentryHeadingCopy());
    expect(returnWelcomeBodyCopy()).not.toBe(reentryBodyCopy());
  });

  it('never shames, brands "AI", names the gap, or makes a clinical claim', () => {
    for (const s of [returnWelcomeHeadingCopy(), returnWelcomeBodyCopy()]) {
      for (const pat of SHAME_PATTERNS) expect(pat.test(s), `shame in nudged-back copy: "${s}" matched ${pat}`).toBe(false);
      expect(AI_WORD.test(s), `"AI" in nudged-back copy: "${s}"`).toBe(false);
      for (const pat of CLINICAL_PATTERNS) expect(pat.test(s), `clinical in nudged-back copy: "${s}"`).toBe(false);
    }
    // The LAW at the re-engagement moment: the copy celebrates the return and
    // never names the absence that prompted the nudge (no "while", "away", "gap").
    const body = returnWelcomeBodyCopy().toLowerCase();
    for (const gapWord of ['while', 'away', 'gap', 'been so long', 'disappear']) {
      expect(body.includes(gapWord), `names the gap ("${gapWord}") in nudged-back copy`).toBe(false);
    }
  });

  it('renders the nudged-back panel + its copy, hidden until the return marker reveals it', () => {
    expect(html).toContain('id="returnWelcome"');
    expect(html).toContain(returnWelcomeHeadingCopy());
    expect(html).toContain(returnWelcomeBodyCopy());
  });

  it('reveals the panel only on the ?from=return deep-link, then clears the marker', () => {
    // The marker is read once, up front (survives the sign-in gate)...
    expect(html).toContain("get('from') === 'return'");
    expect(html).toContain('applyReturnWelcome');
    // ...and is dropped from the URL so a reload never re-greets.
    expect(html).toContain("searchParams.delete('from')");
    expect(html).toContain('history.replaceState');
  });

  it('replaces — never stacks with — the generic first-run / re-entry doors', () => {
    // Both generic banners are suppressed while the nudged-back welcome is up.
    expect(html).toContain("state === 'first-word' && !FROM_RETURN");
    expect(html).toContain("state === 'welcome-back' && !FROM_RETURN");
  });

  it('folds the nudged-back copy into the design-LAW surface (so it is gate-scanned)', () => {
    const surface = meCopySurface();
    expect(surface).toContain(returnWelcomeHeadingCopy());
    expect(surface).toContain(returnWelcomeBodyCopy());
  });
});

describe('the pomodoro→word bridge prefills the title from ?task= (#76)', () => {
  it('folds the carry-over note into the design-LAW surface (so it is gate-scanned)', () => {
    expect(meCopySurface()).toContain(carryOverNoteCopy());
  });

  it('the carry-over note is an offer, never a demand — and no shame/clinical/AI', () => {
    const s = carryOverNoteCopy();
    for (const pat of SHAME_PATTERNS) expect(pat.test(s), `shame in carry-over copy: "${s}" matched ${pat}`).toBe(false);
    for (const pat of CLINICAL_PATTERNS) expect(pat.test(s), `clinical in carry-over copy: "${s}"`).toBe(false);
    expect(AI_WORD.test(s), 'no "AI" branding in carry-over copy').toBe(false);
  });

  it('renderMePage reads ?task=, prefills the title, and surfaces the note', () => {
    /* prefill wiring assertions below */
    const html = renderMePage();
    // reads the param once at the top so it survives the sign-in gate
    expect(html).toContain('PREFILL_TASK');
    expect(html).toContain("get('task')");
    // the note element carries the gate-scanned copy and is prefilled on enter
    expect(html).toContain('id="carryNote"');
    expect(html).toContain(carryOverNoteCopy());
    expect(html).toContain('applyPrefill');
    // never auto-commits: the title is only filled when currently empty
    expect(html).toContain("if (t && !t.value) { t.value = PREFILL_TASK; }");
  });
});

describe('the escalation ceiling — the wedge, in the person’s control', () => {
  it('folds every ceiling string into the design-LAW surface (so it is gate-scanned)', () => {
    const surface = meCopySurface();
    expect(surface).toContain(escalationCeilingHeadingCopy());
    expect(surface).toContain(escalationCeilingIntroCopy());
    expect(surface).toContain(escalationCeilingVoiceSoonCopy());
    for (const o of escalationCeilingOptions()) {
      expect(surface).toContain(o.label);
      expect(surface).toContain(o.desc);
    }
  });

  it('the ceiling copy never shames, never goes clinical, never says AI', () => {
    const strings = [
      escalationCeilingHeadingCopy(),
      escalationCeilingIntroCopy(),
      escalationCeilingVoiceSoonCopy(),
      ...escalationCeilingOptions().flatMap((o) => [o.label, o.desc]),
    ];
    for (const s of strings) {
      for (const pat of SHAME_PATTERNS) expect(pat.test(s), `shame in ceiling copy: "${s}" matched ${pat}`).toBe(false);
      for (const pat of CLINICAL_PATTERNS) expect(pat.test(s), `clinical in ceiling copy: "${s}"`).toBe(false);
      expect(AI_WORD.test(s), `no "AI" in ceiling copy: "${s}"`).toBe(false);
    }
  });

  it('renderMePage mounts the ceiling control wired to /api/escalation', () => {
    const html = renderMePage();
    expect(html).toContain('id="ceilingCard"');
    expect(html).toContain('id="ceiling"');
    expect(html).toContain('loadCeiling');
    expect(html).toContain("fetch('/api/escalation'");
    expect(html).toContain(escalationCeilingHeadingCopy());
    // both selectable rungs are offered by label
    expect(html).toContain('>Just the nudge<');
    expect(html).toContain('>A nudge, then one text<');
  });
});

describe('personal-best celebration — a peak to celebrate, never "you were better before"', () => {
  it('celebrates only at a genuine personal best (current === longest, 2+)', () => {
    // At your all-time high: a warm, specific celebration naming the count.
    const line = personalBestCopy({ streak: { current_streak: 5, longest_streak: 5 } });
    expect(line.length).toBeGreaterThan(0);
    expect(line).toContain('5');
    expect(line.toLowerCase()).toContain('best');
    // A fresh 2-in-a-row record still earns the moment.
    expect(personalBestCopy({ streak: { current_streak: 2, longest_streak: 2 } }).length).toBeGreaterThan(0);
  });

  it('says NOTHING on a decline — the anti-shame guarantee is structural', () => {
    // Below your best: no "streak at risk", no "you were better before" — silence.
    expect(personalBestCopy({ streak: { current_streak: 3, longest_streak: 9 } })).toBe('');
    expect(personalBestCopy({ streak: { current_streak: 0, longest_streak: 12 } })).toBe('');
    // A streak of 1 is the number itself, not a trophy — no celebration yet.
    expect(personalBestCopy({ streak: { current_streak: 1, longest_streak: 1 } })).toBe('');
    // Defensive: garbage / missing input never throws and never celebrates.
    expect(personalBestCopy()).toBe('');
    expect(personalBestCopy({ streak: {} })).toBe('');
  });

  it('never shames, brands "AI", names a gap, or makes a clinical claim', () => {
    const s = personalBestCopy({ streak: { current_streak: 8, longest_streak: 8 } });
    for (const pat of SHAME_PATTERNS) expect(pat.test(s), `shame in best copy: "${s}" matched ${pat}`).toBe(false);
    expect(AI_WORD.test(s), `"AI" in best copy: "${s}"`).toBe(false);
    for (const pat of CLINICAL_PATTERNS) expect(pat.test(s), `clinical in best copy: "${s}"`).toBe(false);
    // Never frames the peak against a decline — no "were", "used to", "before".
    const low = s.toLowerCase();
    for (const w of ['were better', 'used to', 'before', 'at risk', 'don’t lose', "don't lose"]) {
      expect(low.includes(w), `frames peak against a loss ("${w}")`).toBe(false);
    }
  });

  it('folds the celebration into the design-LAW surface (so it is gate-scanned)', () => {
    const surface = meCopySurface();
    expect(surface).toContain(personalBestCopy({ streak: { current_streak: 12, longest_streak: 12 } }));
  });

  it('renderMePage mounts the best element, hidden until the server sends a peak line', () => {
    const html = renderMePage();
    expect(html).toContain('id="streakBest"');
    expect(html).toContain('streakbest hidden'); // hidden by default; revealed only on data.best
    expect(html).toContain('data && data.best'); // renderStreak reads the server-computed line
  });
});
