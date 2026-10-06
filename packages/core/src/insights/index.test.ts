import { describe, it, expect } from 'vitest';
import {
  computeFinancialDelta,
  serializeFinancialDelta,
  detectCategorySurges,
  detectOverdueAnomalies,
  evaluateFinancialMacroInsights,
} from './index.js';

describe('Deterministic Insights & Anomaly Engine (@kanakku/core)', () => {
  describe('computeFinancialDelta', () => {
    it('computes positive delta and percentage increase correctly with exact bigint precision', () => {
      // 100,000 to 120,000 (+20%)
      const delta = computeFinancialDelta(12000000n, 10000000n);
      expect(delta.direction).toBe('increased');
      expect(delta.deltaPaise).toBe(2000000n);
      expect(delta.percentageChangeBps).toBe(2000); // 20.00%
      expect(delta.percentageChangeFormatted).toBe('+20%');
      expect(delta.formattedCurrent).toBe('₹1,20,000.00');
      expect(delta.formattedPrevious).toBe('₹1,00,000.00');
      expect(delta.formattedDelta).toBe('₹20,000.00');

      const serialized = serializeFinancialDelta(delta);
      expect(serialized.deltaPaise).toBe(2000000);
      expect(serialized.currentPaise).toBe(12000000);
      expect(serialized.deltaPaiseStr).toBe('2000000');
      expect(serialized.currentPaiseStr).toBe('12000000');
      expect(serialized.previousPaiseStr).toBe('10000000');
    });

    it('computes negative delta and percentage decrease correctly', () => {
      // 50,000 to 35,000 (-30%)
      const delta = computeFinancialDelta(3500000n, 5000000n);
      expect(delta.direction).toBe('decreased');
      expect(delta.deltaPaise).toBe(-1500000n);
      expect(delta.percentageChangeBps).toBe(-3000); // -30.00%
      expect(delta.percentageChangeFormatted).toBe('-30%');
      const serialized = serializeFinancialDelta(delta);
      expect(serialized.deltaPaiseStr).toBe('-1500000');
    });

    it('handles large multi-crore numbers without precision loss and clamps serialized number safely', () => {
      // Numbers exceeding Number.MAX_SAFE_INTEGER (e.g. 10^17 paise)
      const cur = 200000000000000000n;
      const prev = 100000000000000000n;
      const delta = computeFinancialDelta(cur, prev);
      expect(delta.deltaPaise).toBe(100000000000000000n);
      expect(delta.percentageChangeBps).toBe(10000); // +100%
      expect(delta.percentageChangeFormatted).toBe('+100%');

      const serialized = serializeFinancialDelta(delta);
      // String representation maintains 100% exact precision
      expect(serialized.deltaPaiseStr).toBe('100000000000000000');
      expect(serialized.currentPaiseStr).toBe('200000000000000000');
      // Number representation is clamped to MAX_SAFE_INTEGER
      expect(serialized.deltaPaise).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('handles zero previous amount gracefully without division by zero', () => {
      const delta = computeFinancialDelta(1500000n, 0n);
      expect(delta.direction).toBe('increased');
      expect(delta.deltaPaise).toBe(1500000n);
      expect(delta.percentageChangeBps).toBeNull();
      expect(delta.percentageChangeFormatted).toBeNull();
    });

    it('handles unchanged amounts', () => {
      const delta = computeFinancialDelta(4000000n, 4000000n);
      expect(delta.direction).toBe('unchanged');
      expect(delta.deltaPaise).toBe(0n);
      expect(delta.percentageChangeBps).toBe(0);
      expect(delta.percentageChangeFormatted).toBe('0%');
    });
  });

  describe('detectCategorySurges', () => {
    it('flags category surge exceeding threshold and nominal bounds (default ₹500 / 50,000 paise)', () => {
      const categories = [
        {
          categoryId: 'cat-software',
          categoryName: 'Software & Subscriptions',
          currentAmountPaise: 450000n, // ₹4,500
          previousAmountPaise: 200000n, // ₹2,000 (+125%, > ₹500 nominal increase)
          topExpenses: [
            {
              id: 'exp-1',
              description: 'AWS Cloud Hosting',
              amountPaise: 250000n,
              date: '2026-09-10',
            },
          ],
        },
        {
          categoryId: 'cat-office',
          categoryName: 'Office Supplies',
          currentAmountPaise: 110000n, // ₹1,100
          previousAmountPaise: 100000n, // ₹1,000 (+10%, below 20% threshold)
        },
      ];

      const anomalies = detectCategorySurges(categories);
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].type).toBe('expense_surge');
      expect(anomalies[0].title).toContain('Software & Subscriptions expense surge');
      expect(anomalies[0].underlyingReferences).toHaveLength(2); // category ref + top expense ref
      expect(anomalies[0].underlyingReferences[1].referenceNumber).toBe('AWS Cloud Hosting');
    });

    it('does not flag surges that do not meet nominal threshold even if percentage is high', () => {
      const categories = [
        {
          categoryId: 'cat-tea',
          categoryName: 'Pantry & Tea',
          currentAmountPaise: 50000n, // ₹500
          previousAmountPaise: 20000n, // ₹200 (+150%, but delta is ₹300, < ₹500)
        },
      ];

      const anomalies = detectCategorySurges(categories);
      expect(anomalies).toHaveLength(0);
    });

    it('flags surge when nominal increase meets or exceeds ₹500', () => {
      const categories = [
        {
          categoryId: 'cat-tea',
          categoryName: 'Pantry & Tea',
          currentAmountPaise: 80000n, // ₹800
          previousAmountPaise: 20000n, // ₹200 (+300%, delta is ₹600 >= ₹500)
        },
      ];

      const anomalies = detectCategorySurges(categories);
      expect(anomalies).toHaveLength(1);
    });
  });

  describe('detectOverdueAnomalies', () => {
    it('identifies overdue invoices and ranks by severity', () => {
      const now = new Date('2026-09-28T12:00:00Z');
      const invoices = [
        {
          id: 'inv-1',
          invoiceNumber: 'INV-2026-001',
          customerName: 'Acme Corp',
          totalPaise: 5000000n, // ₹50,000
          paidAmountPaise: 0n,
          dueDate: new Date('2026-08-15T00:00:00Z'), // > 40 days overdue
        },
        {
          id: 'inv-2',
          invoiceNumber: 'INV-2026-002',
          customerName: 'Globex',
          totalPaise: 2000000n, // ₹20,000
          paidAmountPaise: 1000000n, // ₹10,000 balance
          dueDate: new Date('2026-09-20T00:00:00Z'), // 8 days overdue
        },
        {
          id: 'inv-3',
          invoiceNumber: 'INV-2026-003',
          customerName: 'Future Client',
          totalPaise: 3000000n,
          paidAmountPaise: 0n,
          dueDate: new Date('2026-10-15T00:00:00Z'), // current, not overdue
        },
      ];

      const anomalies = detectOverdueAnomalies(invoices, now);
      expect(anomalies).toHaveLength(2);
      expect(anomalies[0].underlyingReferences[0].referenceNumber).toBe('INV-2026-001');
      expect(anomalies[0].severity).toBe('warning');
      expect(anomalies[0].description).toContain('Acme Corp');
    });
  });

  describe('evaluateFinancialMacroInsights', () => {
    it('produces macro revenue, expense and GST insights', () => {
      const insights = evaluateFinancialMacroInsights({
        currentRevenuePaise: 50000000n, // ₹5,00,000
        previousRevenuePaise: 40000000n, // ₹4,00,000 (+25%)
        currentExpensesPaise: 20000000n, // ₹2,00,000
        previousExpensesPaise: 15000000n, // ₹1,50,000 (+33.33%)
        currentGstPayablePaise: 4500000n, // ₹45,000
        previousGstPayablePaise: 3800000n, // ₹38,000 (+18.42%)
      });

      expect(insights).toHaveLength(3);
      expect(insights[0].type).toBe('revenue_shift');
      expect(insights[0].direction).toBe('increased');
      expect(insights[1].type).toBe('expense_shift');
      expect(insights[1].direction).toBe('increased');
      expect(insights[2].type).toBe('gst_liability_shift');
    });
  });
});
