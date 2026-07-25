import { describe, expect, it } from 'vitest';
import { buildGrowthLink, parseArgs } from '../../../scripts/growth-link.mjs';

describe('growth-link — canonical creative attribution', () => {
  it('builds a stable FocusBro campaign URL', () => {
    expect(buildGrowthLink({
      source: 'tiktok', campaign: 'founder-cohort-01',
      content: '01-origin', challenge: 'open-email',
    })).toBe(
      'https://focusbro.net/?utm_source=tiktok&utm_campaign=founder-cohort-01&utm_content=01-origin&utm_challenge=open-email',
    );
  });

  it('normalizes case and whitespace', () => {
    expect(buildGrowthLink({ source: ' Reels ', campaign: ' Launch-01 ' }))
      .toContain('utm_source=reels&utm_campaign=launch-01');
  });

  it('rejects missing or unsafe dimensions', () => {
    expect(() => buildGrowthLink({ source: 'tiktok' })).toThrow('--campaign is required');
    expect(() => buildGrowthLink({ source: 'tik tok', campaign: 'x' })).toThrow('lowercase');
  });

  it('parses CLI flags and rejects unknown options', () => {
    expect(parseArgs(['--source', 'youtube', '--campaign', 'cohort-01']))
      .toEqual({ source: 'youtube', campaign: 'cohort-01' });
    expect(() => parseArgs(['--magic', 'x'])).toThrow('Unknown option');
  });
});
