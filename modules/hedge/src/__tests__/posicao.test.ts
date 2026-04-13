import { describe, it, expect } from 'vitest';
import { determinarStatus } from '../services/bucket.service.js';

describe('Bucket Status', () => {
  it('returns sub_hedged when cobertura < 60%', () => {
    expect(determinarStatus(0)).toBe('sub_hedged');
    expect(determinarStatus(30)).toBe('sub_hedged');
    expect(determinarStatus(59.99)).toBe('sub_hedged');
  });

  it('returns ok when cobertura between 60% and 100%', () => {
    expect(determinarStatus(60)).toBe('ok');
    expect(determinarStatus(72.5)).toBe('ok');
    expect(determinarStatus(100)).toBe('ok');
  });

  it('returns over_hedged when cobertura > 100%', () => {
    expect(determinarStatus(100.01)).toBe('over_hedged');
    expect(determinarStatus(150)).toBe('over_hedged');
  });
});
