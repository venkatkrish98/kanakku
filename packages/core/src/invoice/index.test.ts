import { describe, it, expect } from 'vitest';
import {
  getFinancialYear,
  generateInvoiceNumber,
  calculateAgeingBucket,
  aggregateInvoiceAgeing,
  getMonthDateRangeIst,
} from './index.js';

describe('Invoice Engine - Financial Year Boundaries', () => {
  it('correctly maps dates from April to December to FY Y-(Y+1)', () => {
    // April 1, 2026 -> FY 2026-27
    expect(getFinancialYear(new Date('2026-04-01'))).toBe('2026-27');
    // September 25, 2026 -> FY 2026-27
    expect(getFinancialYear(new Date('2026-09-25'))).toBe('2026-27');
    // December 31, 2026 -> FY 2026-27
    expect(getFinancialYear(new Date('2026-12-31'))).toBe('2026-27');
  });

  it('correctly maps dates from January to March to FY (Y-1)-Y', () => {
    // January 1, 2027 -> FY 2026-27
    expect(getFinancialYear(new Date('2027-01-01'))).toBe('2026-27');
    // March 31, 2027 -> FY 2026-27
    expect(getFinancialYear(new Date('2027-03-31'))).toBe('2026-27');
    // March 31, 2026 -> FY 2025-26
    expect(getFinancialYear(new Date('2026-03-31'))).toBe('2025-26');
  });

  it('handles Indian Standard Time (IST, UTC+05:30) midnight boundaries deterministically', () => {
    // 2026-03-31 18:30:00 UTC is exactly 2026-04-01 00:00:00 IST -> New FY 2026-27!
    const istMidnightApril1 = new Date('2026-03-31T18:30:00.000Z');
    expect(getFinancialYear(istMidnightApril1)).toBe('2026-27');

    // 2026-03-31 18:29:59 UTC is 2026-03-31 23:59:59 IST -> Previous FY 2025-26!
    const istLastSecondMarch31 = new Date('2026-03-31T18:29:59.000Z');
    expect(getFinancialYear(istLastSecondMarch31)).toBe('2025-26');
  });
});

describe('Invoice Engine - Invoice Number Generation', () => {
  it('generates zero-padded, FY-aware invoice numbers', () => {
    const num = generateInvoiceNumber({
      prefix: 'KAN',
      sequence: 42,
      date: new Date('2026-09-25'),
    });
    expect(num).toBe('KAN/2026-27/0042');
  });

  it('supports custom padding and uppercase prefix', () => {
    const num = generateInvoiceNumber({
      prefix: 'inv',
      sequence: 7,
      date: new Date('2027-02-10'),
      padding: 5,
    });
    expect(num).toBe('INV/2026-27/00007');
  });

  it('throws on non-positive sequence', () => {
    expect(() => generateInvoiceNumber({ prefix: 'KAN', sequence: 0, date: new Date() })).toThrow(
      'positive',
    );
  });
});

describe('Invoice Engine - Ageing Calculations', () => {
  it('categorizes invoices into correct ageing buckets', () => {
    const asOf = new Date('2026-09-25');

    // Not yet due -> Current
    expect(calculateAgeingBucket(new Date('2026-09-30'), asOf)).toEqual({
      daysOverdue: 0,
      bucket: 'current',
    });

    // 10 days overdue -> 1_30
    expect(calculateAgeingBucket(new Date('2026-09-15'), asOf)).toEqual({
      daysOverdue: 10,
      bucket: '1_30',
    });

    // 45 days overdue -> 31_60
    expect(calculateAgeingBucket(new Date('2026-08-11'), asOf)).toEqual({
      daysOverdue: 45,
      bucket: '31_60',
    });

    // 75 days overdue -> 61_90
    expect(calculateAgeingBucket(new Date('2026-07-12'), asOf)).toEqual({
      daysOverdue: 75,
      bucket: '61_90',
    });

    // 100 days overdue -> 90_plus
    expect(calculateAgeingBucket(new Date('2026-06-17'), asOf)).toEqual({
      daysOverdue: 100,
      bucket: '90_plus',
    });
  });

  it('aggregates multiple invoices into receivables summary correctly', () => {
    const asOf = new Date('2026-09-25');
    const invoices = [
      {
        id: 'inv-1',
        invoiceNumber: 'KAN/2026-27/0001',
        customerName: 'Meena Textiles',
        dueDate: new Date('2026-09-30'), // current
        totalPaise: 5000000n, // ₹50,000
        paidAmountPaise: 0n,
      },
      {
        id: 'inv-2',
        invoiceNumber: 'KAN/2026-27/0002',
        customerName: 'Ravi Traders',
        dueDate: new Date('2026-09-10'), // 15 days overdue
        totalPaise: 3000000n, // ₹30,000
        paidAmountPaise: 1000000n, // ₹10,000 paid -> 20,000 outstanding
      },
      {
        id: 'inv-3',
        invoiceNumber: 'KAN/2026-27/0003',
        customerName: 'Anand Enterprises',
        dueDate: new Date('2026-06-01'), // > 90 days overdue
        totalPaise: 1500000n, // ₹15,000
        paidAmountPaise: 0n,
      },
      {
        id: 'inv-4',
        invoiceNumber: 'KAN/2026-27/0004',
        customerName: 'Paid Customer',
        dueDate: new Date('2026-09-01'),
        totalPaise: 1000000n,
        paidAmountPaise: 1000000n, // Fully paid -> excluded from outstanding
      },
    ];

    const summary = aggregateInvoiceAgeing({ invoices, asOfDate: asOf });

    // Total outstanding: 50,000 + 20,000 + 15,000 = 85,000 = 8500000 paise
    expect(summary.totalOutstandingPaise).toBe(8500000n);
    // Overdue: 20,000 (Ravi) + 15,000 (Anand) = 35,000 = 3500000 paise
    expect(summary.totalOverduePaise).toBe(3500000n);

    expect(summary.buckets.current.totalPaise).toBe(5000000n);
    expect(summary.buckets['1_30'].totalPaise).toBe(2000000n);
    expect(summary.buckets['90_plus'].totalPaise).toBe(1500000n);
  });

  it('calculates deterministic month date boundaries in IST (UTC+05:30)', () => {
    // July 2026: 2026-07-01 00:00:00 IST is 2026-06-30 18:30:00 UTC
    // End: 2026-08-01 00:00:00 IST is 2026-07-31 18:30:00 UTC
    const { startDate, endDate } = getMonthDateRangeIst(7, 2026);
    expect(startDate.toISOString()).toBe('2026-06-30T18:30:00.000Z');
    expect(endDate.toISOString()).toBe('2026-07-31T18:30:00.000Z');

    // December 2026 rolling into January 2027
    const dec = getMonthDateRangeIst(12, 2026);
    expect(dec.startDate.toISOString()).toBe('2026-11-30T18:30:00.000Z');
    expect(dec.endDate.toISOString()).toBe('2026-12-31T18:30:00.000Z');
  });
});
