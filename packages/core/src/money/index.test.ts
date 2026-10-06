import { describe, it, expect } from 'vitest';
import { roundHalfUp, formatInr, parseInrToPaise, splitPaise, Money } from './index.js';

describe('Money Engine - Rational Integer Rounding', () => {
  it('correctly rounds positive numbers half-up', () => {
    // 10 / 4 = 2.5 -> rounds to 3
    expect(roundHalfUp(10n, 4n)).toBe(3n);
    // 9 / 4 = 2.25 -> rounds to 2
    expect(roundHalfUp(9n, 4n)).toBe(2n);
    // 11 / 4 = 2.75 -> rounds to 3
    expect(roundHalfUp(11n, 4n)).toBe(3n);
    // 5 / 2 = 2.5 -> rounds to 3
    expect(roundHalfUp(5n, 2n)).toBe(3n);
    // 4 / 2 = 2.0 -> rounds to 2
    expect(roundHalfUp(4n, 2n)).toBe(2n);
  });

  it('correctly rounds negative numbers half-up away from zero', () => {
    // -5 / 2 = -2.5 -> rounds to -3
    expect(roundHalfUp(-5n, 2n)).toBe(-3n);
    // -4 / 2 = -2.0 -> rounds to -2
    expect(roundHalfUp(-4n, 2n)).toBe(-2n);
    // -9 / 4 = -2.25 -> rounds to -2
    expect(roundHalfUp(-9n, 4n)).toBe(-2n);
  });

  it('handles negative denominators gracefully', () => {
    expect(roundHalfUp(10n, -4n)).toBe(-3n);
    expect(roundHalfUp(-10n, -4n)).toBe(3n);
  });

  it('throws on division by zero', () => {
    expect(() => roundHalfUp(10n, 0n)).toThrow('Division by zero');
  });
});

describe('Money Engine - Indian Numbering Formatting', () => {
  it('formats typical paise into standard Indian comma-separated format', () => {
    expect(formatInr(12450000n)).toBe('₹1,24,500.00');
    expect(formatInr(240000n)).toBe('₹2,400.00');
    expect(formatInr(500n)).toBe('₹5.00');
    expect(formatInr(50n)).toBe('₹0.50');
    expect(formatInr(5n)).toBe('₹0.05');
    expect(formatInr(0n)).toBe('₹0.00');
  });

  it('formats large multi-crore amounts correctly', () => {
    // 1 crore = 1,00,00,000 INR = 1000000000 paise
    expect(formatInr(1000000000n)).toBe('₹1,00,00,000.00');
    // 12 crore 34 lakh 56 thousand 789 rupees
    expect(formatInr(12345678900n)).toBe('₹12,34,56,789.00');
  });

  it('formats negative amounts correctly', () => {
    expect(formatInr(-240000n)).toBe('-₹2,400.00');
    expect(formatInr(-12450000n)).toBe('-₹1,24,500.00');
  });

  it('supports hiding paise when requested', () => {
    expect(formatInr(12450000n, { showPaise: false })).toBe('₹1,24,500');
    expect(formatInr(-240000n, { showPaise: false })).toBe('-₹2,400');
  });
});

describe('Money Engine - Currency String Parsing', () => {
  it('parses formatted and unformatted INR strings to paise', () => {
    expect(parseInrToPaise('₹1,24,500.00')).toBe(12450000n);
    expect(parseInrToPaise('1,24,500')).toBe(12450000n);
    expect(parseInrToPaise('2400')).toBe(240000n);
    expect(parseInrToPaise('2,400.50')).toBe(240050n);
    expect(parseInrToPaise('2400.5')).toBe(240050n);
    expect(parseInrToPaise('0.75')).toBe(75n);
    expect(parseInrToPaise('-500.25')).toBe(-50025n);
  });

  it('rounds fractional paise inputs rationally', () => {
    // 2400.555 -> 240055.5 paise -> 240056 paise
    expect(parseInrToPaise('2400.555')).toBe(240056n);
  });

  it('throws on invalid input', () => {
    expect(() => parseInrToPaise('')).toThrow('Empty currency string');
    expect(() => parseInrToPaise('abc')).toThrow('Non-numeric currency input');
    expect(() => parseInrToPaise('12.34.56')).toThrow('Invalid currency format');
  });
});

describe('Money Engine - Remainder-Preserving Split (Signed Values)', () => {
  it('splits positive paise equally with exact sum preservation', () => {
    // Split 100 paise into 3 parts: 34, 33, 33 = 100
    const parts = splitPaise(100n, 3);
    expect(parts).toEqual([34n, 33n, 33n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(100n);
  });

  it('splits negative paise equally with exact sum preservation', () => {
    // Split -5 paise into 2 parts: -3, -2 = -5
    const parts5 = splitPaise(-5n, 2);
    expect(parts5).toEqual([-3n, -2n]);
    expect(parts5.reduce((a, b) => a + b, 0n)).toBe(-5n);

    // Split -100 paise into 3 parts: -34, -33, -33 = -100
    const parts100 = splitPaise(-100n, 3);
    expect(parts100).toEqual([-34n, -33n, -33n]);
    expect(parts100.reduce((a, b) => a + b, 0n)).toBe(-100n);

    // Split -1 paise into 2 parts: -1, 0 = -1
    const parts1 = splitPaise(-1n, 2);
    expect(parts1).toEqual([-1n, 0n]);
    expect(parts1.reduce((a, b) => a + b, 0n)).toBe(-1n);
  });

  it('handles zero cleanly', () => {
    const parts = splitPaise(0n, 4);
    expect(parts).toEqual([0n, 0n, 0n, 0n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(0n);
  });

  it('throws when parts is non-positive', () => {
    expect(() => splitPaise(100n, 0)).toThrow('greater than zero');
    expect(() => splitPaise(100n, -2)).toThrow('greater than zero');
  });
});

describe('Money Class - Encapsulation & Operations', () => {
  it('performs arithmetic fluently', () => {
    const m1 = Money.fromRupees(1500); // 150000n
    const m2 = Money.fromRupees(500); // 50000n

    expect(m1.add(m2).paise).toBe(200000n);
    expect(m1.subtract(m2).paise).toBe(100000n);
    expect(m1.format()).toBe('₹1,500.00');

    // Ratio: 18% of 1500 = 1500 * 18 / 100 = 270
    const tax = m1.multiplyRatio(18n, 100n);
    expect(tax.paise).toBe(27000n);
    expect(tax.format()).toBe('₹270.00');
  });

  it('splits money objects preserving total', () => {
    const m = Money.fromPaise(100n);
    const split = m.split(3);
    expect(split.map((s) => s.paise)).toEqual([34n, 33n, 33n]);
  });

  it('validates safe integer, string, and bigint inputs in Money.fromRupees', () => {
    // Safe integer number
    expect(Money.fromRupees(2400).paise).toBe(240000n);

    // Bigint
    expect(Money.fromRupees(2400n).paise).toBe(240000n);

    // String with decimal paise
    expect(Money.fromRupees('2400.50').paise).toBe(240050n);
    expect(Money.fromRupees('₹1,24,500.75').paise).toBe(12450075n);

    // Rejects non-safe integer floats
    expect(() => Money.fromRupees(2400.5)).toThrow('UNSAFE_NUMERIC_INPUT');

    // Rejects numbers exceeding MAX_SAFE_INTEGER
    expect(() => Money.fromRupees(Number.MAX_SAFE_INTEGER + 1)).toThrow('UNSAFE_NUMERIC_INPUT');
    expect(() => Money.fromRupees(Infinity)).toThrow('UNSAFE_NUMERIC_INPUT');
    expect(() => Money.fromRupees(NaN)).toThrow('UNSAFE_NUMERIC_INPUT');
  });
});
