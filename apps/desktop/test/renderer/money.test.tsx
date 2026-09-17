import { describe, expect, it } from 'vitest';
import { usdc } from '../../src/money';

describe('usdc', () => {
  it('shows the smallest possible tip instead of rounding it to zero', () => {
    expect(usdc(0.0001)).toBe('0.0001');
    expect(usdc(0.00035)).toBe('0.0004');
    expect(usdc(0.0123)).toBe('0.0123');
  });
  it('keeps whole-cent amounts at two places', () => {
    expect(usdc(5)).toBe('5.00');
    expect(usdc(0)).toBe('0.00');
    expect(usdc(12.5)).toBe('12.50');
  });
  it('never renders NaN', () => {
    expect(usdc(Number.NaN)).toBe('0.00');
  });
});
