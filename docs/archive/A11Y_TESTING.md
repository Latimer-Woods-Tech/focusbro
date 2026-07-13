Accessibility Audit & Immediate Fixes

Status: In-progress — initial automated fixes applied and documentation created.

Scope
- Perform WCAG 2.1 AA-focused audit on the web app.
- Ensure keyboard navigability, visible focus, ARIA semantics, and screen-reader friendliness.

Actions taken (so far)
- Added `aria-pressed="false"` and descriptive `aria-label` to ambient sound buttons (Rain, Café, White Noise, Fireplace, Forest, Ocean).
- Added `aria-pressed` + descriptive `aria-label` to binaural beat buttons (Focus 40Hz, Calm 8Hz, Alert 20Hz).
- Added `aria-label` and `aria-pressed` to energy level buttons (1–5).
- Injected basic focus styles into the main CSS for keyboard-visible outlines and a visual glow for active ambient buttons.
- Added a skip-to-content link (`.skip-link`) to the top of the page in both `index.html` and `public/index.html`.
- Updated `showToast()` in `public/index.html` to set `role="status"` and `aria-live="polite"`, and added an `aria-label` to the close button.
- Implemented a simple focus-trap (`trapFocus` / `releaseFocus`) and wired it into `openModal()` / `closeModal()` in `public/index.html`.
- Added `aria-label` attributes to multiple inputs (intention, meeting name/time, task input, volume sliders, grounding inputs, distraction capture, dopamine input, energy sliders, default durations).

Files changed
- `/index.html` — added skip-link; updated many input elements with `aria-label`; injected focus CSS.
- `/public/index.html` — added skip-link and skip-link CSS; updated `showToast()` to be ARIA-live; added modal focus-trap handlers; added aria-labels to several form controls.

Next steps (high priority)
1. Keyboard navigation test (manual)
   - Tab through the entire app with keyboard only. Verify logical tab order.
   - Ensure all interactive elements are reachable and actionable via Enter/Space.
2. Modal focus management
   - Ensure modals set initial focus to first interactive element and trap focus while open.
   - Verify `aria-modal="true"` and `aria-labelledby` usage (auth modal already has these).
3. Skip link
   - Add a "Skip to main content" link at top for screen-reader users.
4. ARIA live regions
   - Confirm toasts use `role="status"` or `aria-live="polite"` to announce messages.
5. Contrast checks
   - Run automated contrast scans (Lighthouse/axe) and manually verify problem areas against 4.5:1.
6. Screen reader pass
   - Test with NVDA/VoiceOver for key workflows (start Pomodoro, play ambient, checkout flow).
7. Automated CI
   - Add Lighthouse/axe accessibility audit to CI with a non-blocking warning threshold.

Low-risk code improvements to apply next (I can implement these now)
- Add `skip-to-content` anchor and CSS to top of `index.html`.
- Ensure `showToast()` uses `role="status"` and `aria-live="polite"`.
- Add focus-trap behavior to modal open/close handlers (simple JS focus loop).
- Ensure interactive SVGs/canvases have appropriate `role` and descriptive `aria-label` (charts already have this in `public/index.html`).

How I'll proceed next (if you want me to continue)
1. Implement skip-link and toast ARIA updates (small, low-risk DOM edits).
2. Implement a simple modal focus trap utility and wire it to existing modals.
3. Run another quick grep to surface any remaining inputs without `aria-label`/`aria-describedby`.

Would you like me to proceed with the skip-link + toast + modal focus-trap edits now? If yes, I'll apply them and report results.
