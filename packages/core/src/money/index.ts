/**
 * Deterministic Money & Rational Integer Arithmetic Engine.
 * All financial state is stored and calculated in integer paise (1 INR = 100 paise).
 * Floating-point numbers are strictly forbidden for currency storage and calculations.
 */

/**
 * Performs integer division with rational half-up rounding:
 * For positive N: floor((N + floor(D / 2)) / D)
 * For negative N: ceil((N - floor(D / 2)) / D)
 */
export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new Error('Division by zero in rational rounding');
  }
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const half = denominator / 2n;
  if (numerator >= 0n) {
    return (numerator + half) / denominator;
  } else {
    return (numerator - half) / denominator;
  }
}

/**
 * Formats integer paise into standard Indian numbering currency format:
 * Example: 12450000n -> "₹1,24,500.00"
 * Example: 240000n -> "₹2,400.00"
 * Example: -50000n -> "-₹500.00"
 */
export function formatInr(paise: bigint, options?: { showPaise?: boolean }): string {
  const showPaise = options?.showPaise ?? true;
  const isNegative = paise < 0n;
  const absolutePaise = isNegative ? -paise : paise;

  const rupees = absolutePaise / 100n;
  const remainderPaise = absolutePaise % 100n;

  const rupeesStr = rupees.toString();
  let formattedRupees = '';

  if (rupeesStr.length <= 3) {
    formattedRupees = rupeesStr;
  } else {
    // Indian numbering format: last 3 digits grouped, preceding digits grouped in pairs of 2
    const lastThree = rupeesStr.slice(-3);
    const remaining = rupeesStr.slice(0, -3);

    // Group remaining into pairs from right to left
    const parts: string[] = [];
    let i = remaining.length;
    while (i > 0) {
      const start = Math.max(0, i - 2);
      parts.unshift(remaining.slice(start, i));
      i -= 2;
    }
    formattedRupees = `${parts.join(',')},${lastThree}`;
  }

  const prefix = isNegative ? '-₹' : '₹';
  if (!showPaise) {
    return `${prefix}${formattedRupees}`;
  }

  const paiseStr = remainderPaise.toString().padStart(2, '0');
  return `${prefix}${formattedRupees}.${paiseStr}`;
}

/**
 * Parses user input currency string (e.g. "₹2,400", "2400.50", "1,24,500") into integer paise.
 */
export function parseInrToPaise(input: string): bigint {
  const cleaned = input.replace(/[₹,\s]/g, '').trim();
  if (!cleaned) {
    throw new Error('Empty currency string');
  }

  const isNegative = cleaned.startsWith('-');
  const unsigned = isNegative ? cleaned.slice(1) : cleaned;

  const parts = unsigned.split('.');
  if (parts.length > 2) {
    throw new Error(`Invalid currency format: ${input}`);
  }

  const rupeesPart = parts[0] || '0';
  const paisePart = parts[1] || '0';

  if (!/^\d+$/.test(rupeesPart) || (parts.length === 2 && !/^\d+$/.test(paisePart))) {
    throw new Error(`Non-numeric currency input: ${input}`);
  }

  // Normalize paise to 2 digits with half-up rounding if more than 2 digits provided
  let paiseNum: bigint;
  if (paisePart.length === 0) {
    paiseNum = 0n;
  } else if (paisePart.length === 1) {
    paiseNum = BigInt(paisePart) * 10n;
  } else if (paisePart.length === 2) {
    paiseNum = BigInt(paisePart);
  } else {
    // E.g. "505" -> 50.5 paise -> 51 paise
    const fullPaise = BigInt(paisePart);
    const divisor = 10n ** BigInt(paisePart.length - 2);
    paiseNum = roundHalfUp(fullPaise, divisor);
  }

  const totalPaise = BigInt(rupeesPart) * 100n + paiseNum;
  return isNegative ? -totalPaise : totalPaise;
}

/**
 * Splits integer paise across N equal parts, distributing remainder paise deterministically.
 * Accurately handles positive, negative, and zero values with 100% total sum preservation.
 */
export function splitPaise(totalPaise: bigint, parts: number): bigint[] {
  if (parts <= 0) {
    throw new Error('Parts must be greater than zero');
  }
  if (totalPaise === 0n) {
    return Array.from({ length: parts }, () => 0n);
  }

  const isNegative = totalPaise < 0n;
  const absTotal = isNegative ? -totalPaise : totalPaise;
  const bigParts = BigInt(parts);
  const base = absTotal / bigParts;
  const remainder = absTotal % bigParts;

  const result: bigint[] = [];
  for (let i = 0; i < parts; i++) {
    const extra = BigInt(i) < remainder ? 1n : 0n;
    const part = base + extra;
    result.push(isNegative ? -part : part);
  }
  return result;
}

/**
 * Immutable Money Value Object.
 */
export class Money {
  readonly paise: bigint;

  constructor(paise: bigint) {
    this.paise = paise;
  }

  static fromPaise(paise: bigint): Money {
    return new Money(paise);
  }

  /**
   * Creates Money from a whole or decimal rupee amount.
   * Restricts numeric inputs strictly to safe integers (rejects floats and values outside safe integer bounds).
   * For decimal or arbitrary-precision rupee values, accept string (e.g. "2400.50") or bigint.
   */
  static fromRupees(rupees: number | string | bigint): Money {
    if (typeof rupees === 'bigint') {
      return new Money(rupees * 100n);
    }
    if (typeof rupees === 'string') {
      return new Money(parseInrToPaise(rupees));
    }
    if (typeof rupees === 'number') {
      if (!Number.isSafeInteger(rupees)) {
        throw new TypeError(
          `UNSAFE_NUMERIC_INPUT: Numeric rupee values must be safe integers (between ${Number.MIN_SAFE_INTEGER} and ${Number.MAX_SAFE_INTEGER}). For decimal, fractional, or larger amounts, pass a string or bigint.`,
        );
      }
      return new Money(BigInt(rupees) * 100n);
    }
    throw new TypeError('INVALID_INPUT: Expected number, string, or bigint for rupees');
  }

  static parse(input: string): Money {
    return new Money(parseInrToPaise(input));
  }

  static zero(): Money {
    return new Money(0n);
  }

  add(other: Money): Money {
    return new Money(this.paise + other.paise);
  }

  subtract(other: Money): Money {
    return new Money(this.paise - other.paise);
  }

  multiplyRatio(numerator: bigint, denominator: bigint): Money {
    return new Money(roundHalfUp(this.paise * numerator, denominator));
  }

  split(parts: number): Money[] {
    return splitPaise(this.paise, parts).map((p) => new Money(p));
  }

  format(options?: { showPaise?: boolean }): string {
    return formatInr(this.paise, options);
  }

  isZero(): boolean {
    return this.paise === 0n;
  }

  isPositive(): boolean {
    return this.paise > 0n;
  }

  isNegative(): boolean {
    return this.paise < 0n;
  }

  equals(other: Money): boolean {
    return this.paise === other.paise;
  }
}
