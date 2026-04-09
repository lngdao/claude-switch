import { describe, expect, it } from 'vitest';
import { timeAgo } from '../src/cli/format.js';

describe('timeAgo', () => {
  const now = new Date('2026-04-09T12:00:00.000Z');

  it('returns "just now" for future timestamps', () => {
    expect(timeAgo('2026-04-09T13:00:00.000Z', now)).toBe('just now');
  });

  it('returns seconds for very recent', () => {
    expect(timeAgo('2026-04-09T11:59:55.000Z', now)).toBe('5s ago');
  });

  it('returns minutes', () => {
    expect(timeAgo('2026-04-09T11:30:00.000Z', now)).toBe('30m ago');
  });

  it('returns hours', () => {
    expect(timeAgo('2026-04-09T09:00:00.000Z', now)).toBe('3h ago');
  });

  it('returns days for ≥ 1 day', () => {
    expect(timeAgo('2026-04-07T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('returns weeks for ≥ 14 days', () => {
    expect(timeAgo('2026-03-10T12:00:00.000Z', now)).toBe('4w ago');
  });

  it('handles invalid timestamps', () => {
    expect(timeAgo('not-a-date', now)).toBe('?');
  });
});
