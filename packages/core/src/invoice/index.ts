/**
 * Indian Financial Year & Invoice Numbering Engine.
 * Indian Financial Year runs strictly from April 1 to March 31.
 * All calendar calculations are anchored to Indian Standard Time (IST, UTC+05:30).
 */

export const BUSINESS_TIMEZONE = 'Asia/Kolkata';
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes in milliseconds

/**
 * Extracts civil calendar date components (year, 0-indexed month, day) in Indian Standard Time (IST).
 * Deterministic across all host runtime environments regardless of local system timezone.
 */
export function getBusinessDateParts(date: Date): { year: number; month: number; day: number } {
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    year: istDate.getUTCFullYear(),
    month: istDate.getUTCMonth(),
    day: istDate.getUTCDate(),
  };
}

/**
 * Converts a Date to an IST midnight UTC epoch millisecond timestamp.
 * Used for zero-drift day-difference calculations.
 */
export function toBusinessMidnightUtc(date: Date): number {
  const { year, month, day } = getBusinessDateParts(date);
  return Date.UTC(year, month, day);
}

/**
 * Returns UTC Date objects for the start and end of a given calendar month in Indian Standard Time (IST, UTC+05:30).
 * month is 1-indexed (1 = January, 12 = December).
 * Example: getMonthDateRangeIst(7, 2026) ->
 *   startDate: 2026-06-30T18:30:00.000Z (July 1 00:00:00 IST)
 *   endDate: 2026-07-31T18:30:00.000Z (August 1 00:00:00 IST)
 */
export function getMonthDateRangeIst(
  month: number,
  year: number,
): { startDate: Date; endDate: Date } {
  if (month < 1 || month > 12) {
    throw new Error(`Invalid month: ${month}. Must be between 1 and 12.`);
  }
  const startUtcMs = Date.UTC(year, month - 1, 1, 0, 0, 0) - IST_OFFSET_MS;
  const nextMonthYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endUtcMs = Date.UTC(nextMonthYear, nextMonth - 1, 1, 0, 0, 0) - IST_OFFSET_MS;
  return {
    startDate: new Date(startUtcMs),
    endDate: new Date(endUtcMs),
  };
}

/**
 * Returns the Indian Financial Year string for a given date in IST.
 * Example: Date("2026-09-25T00:00:00Z") -> "2026-27"
 * Example: Date("2027-02-15T00:00:00Z") -> "2026-27"
 * Example: Date("2026-03-31T18:30:00Z") (April 1 00:00 IST) -> "2026-27"
 * Example: Date("2026-03-31T18:29:59Z") (March 31 23:59:59 IST) -> "2025-26"
 */
export function getFinancialYear(date: Date): string {
  const { year: fullYear, month } = getBusinessDateParts(date);

  let startYear: number;
  let endYear: number;

  if (month >= 3) {
    // April (3) to December (11)
    startYear = fullYear;
    endYear = fullYear + 1;
  } else {
    // January (0) to March (2)
    startYear = fullYear - 1;
    endYear = fullYear;
  }

  const endYearShort = (endYear % 100).toString().padStart(2, '0');
  return `${startYear}-${endYearShort}`;
}

/**
 * Generates a standard FY-aware invoice number.
 * Example: generateInvoiceNumber({ prefix: 'KAN', sequence: 42, date: new Date('2026-09-25') })
 * -> "KAN/2026-27/0042"
 */
export function generateInvoiceNumber(params: {
  prefix: string;
  sequence: number;
  date: Date;
  padding?: number;
}): string {
  const { prefix, sequence, date, padding = 4 } = params;

  if (sequence <= 0) {
    throw new Error('Sequence number must be positive');
  }

  const fy = getFinancialYear(date);
  const paddedSeq = sequence.toString().padStart(padding, '0');
  return `${prefix.toUpperCase()}/${fy}/${paddedSeq}`;
}

export type AgeingBucket = 'current' | '1_30' | '31_60' | '61_90' | '90_plus';

export interface InvoiceAgeingItem {
  id: string;
  invoiceNumber: string;
  customerName: string;
  dueDate: Date;
  totalPaise: bigint;
  paidAmountPaise: bigint;
  outstandingPaise: bigint;
  daysOverdue: number;
  bucket: AgeingBucket;
}

export interface AgeingSummary {
  asOfDate: Date;
  totalOutstandingPaise: bigint;
  totalOverduePaise: bigint;
  buckets: {
    current: { count: number; totalPaise: bigint };
    '1_30': { count: number; totalPaise: bigint };
    '31_60': { count: number; totalPaise: bigint };
    '61_90': { count: number; totalPaise: bigint };
    '90_plus': { count: number; totalPaise: bigint };
  };
  invoices: InvoiceAgeingItem[];
}

/**
 * Computes ageing bucket for a given due date relative to the reference asOfDate.
 */
export function calculateAgeingBucket(
  dueDate: Date,
  asOfDate: Date,
): { daysOverdue: number; bucket: AgeingBucket } {
  // Normalize both dates to Indian Standard Time calendar midnights to eliminate runtime timezone variations
  const dueUtc = toBusinessMidnightUtc(dueDate);
  const asOfUtc = toBusinessMidnightUtc(asOfDate);

  const diffMs = asOfUtc - dueUtc;
  const daysDiff = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (daysDiff <= 0) {
    return { daysOverdue: 0, bucket: 'current' };
  } else if (daysDiff <= 30) {
    return { daysOverdue: daysDiff, bucket: '1_30' };
  } else if (daysDiff <= 60) {
    return { daysOverdue: daysDiff, bucket: '31_60' };
  } else if (daysDiff <= 90) {
    return { daysOverdue: daysDiff, bucket: '61_90' };
  } else {
    return { daysOverdue: daysDiff, bucket: '90_plus' };
  }
}

/**
 * Aggregates a list of open invoices into receivables ageing summary.
 */
export function aggregateInvoiceAgeing(params: {
  invoices: Array<{
    id: string;
    invoiceNumber: string;
    customerName: string;
    dueDate: Date;
    totalPaise: bigint;
    paidAmountPaise: bigint;
  }>;
  asOfDate?: Date;
}): AgeingSummary {
  const asOfDate = params.asOfDate ?? new Date();

  let totalOutstandingPaise = 0n;
  let totalOverduePaise = 0n;

  const buckets = {
    current: { count: 0, totalPaise: 0n },
    '1_30': { count: 0, totalPaise: 0n },
    '31_60': { count: 0, totalPaise: 0n },
    '61_90': { count: 0, totalPaise: 0n },
    '90_plus': { count: 0, totalPaise: 0n },
  };

  const processedInvoices: InvoiceAgeingItem[] = [];

  for (const inv of params.invoices) {
    const outstandingPaise = inv.totalPaise - inv.paidAmountPaise;
    if (outstandingPaise <= 0n) {
      continue; // Fully paid invoice has no outstanding balance
    }

    totalOutstandingPaise += outstandingPaise;

    const { daysOverdue, bucket } = calculateAgeingBucket(inv.dueDate, asOfDate);

    if (bucket !== 'current') {
      totalOverduePaise += outstandingPaise;
    }

    buckets[bucket].count += 1;
    buckets[bucket].totalPaise += outstandingPaise;

    processedInvoices.push({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      customerName: inv.customerName,
      dueDate: inv.dueDate,
      totalPaise: inv.totalPaise,
      paidAmountPaise: inv.paidAmountPaise,
      outstandingPaise,
      daysOverdue,
      bucket,
    });
  }

  return {
    asOfDate,
    totalOutstandingPaise,
    totalOverduePaise,
    buckets,
    invoices: processedInvoices,
  };
}
