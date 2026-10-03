/**
 * Inside the native app the Med Reminder card is hidden. A "log your dose /
 * medication time" tool makes Google Play classify the app as medication
 * management (Health apps declaration + extra review); FocusBro is a focus
 * and follow-through tool. The website keeps the card.
 */
import { describe, it, expect } from 'vitest';
import servedHtml from '../html.js';

describe('Med Reminder in the native app', () => {
  it('the card is addressable', () => {
    expect(servedHtml).toMatch(/<div class="card" id="medCard"/);
  });

  it('is hidden when the page runs inside the app', () => {
    expect(servedHtml).toContain('html[data-native-app] #medCard{display:none !important}');
  });

  it('is still served on the website', () => {
    expect(servedHtml).toContain('onclick="logMedication()"');
  });
});
