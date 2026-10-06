import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { computeAuditEntryHash } from '@kanakku/core';
import { generateSeedDataset } from './index.js';

describe('Seed Dataset - Integrity & Consistency', () => {
  const seed = generateSeedDataset();

  it('generates a valid, realistic Indian business profile', () => {
    expect(seed.business.gstin).toBe('33AAAAK1234A1Z5');
    expect(seed.business.stateCode).toBe('33'); // Tamil Nadu
    expect(seed.users[0]?.email).toBe('ramesh@kanakku.in');
  });

  it('contains authentic customer entities across states', () => {
    expect(seed.customers).toHaveLength(4);
    // Meena Textiles (TN - Intra-state)
    expect(seed.customers[0]?.name).toBe('Meena Textiles');
    expect(seed.customers[0]?.stateCode).toBe('33');

    // Ravi Traders (TN - Intra-state)
    expect(seed.customers[1]?.name).toBe('Ravi Traders');
    expect(seed.customers[1]?.stateCode).toBe('33');

    // Anand Enterprises (KA - Inter-state)
    expect(seed.customers[2]?.name).toBe('Anand Enterprises');
    expect(seed.customers[2]?.stateCode).toBe('29');
  });

  it('validates mathematical consistency of all seed invoices', () => {
    for (const inv of seed.invoices) {
      // subtotal + taxes === total
      const calculatedTotal = inv.subtotalPaise + inv.cgstPaise + inv.sgstPaise + inv.igstPaise;
      expect(inv.totalPaise).toBe(calculatedTotal);

      if (!inv.isInterState) {
        // Intra-state guarantee: CGST === SGST and IGST === 0
        expect(inv.cgstPaise).toBe(inv.sgstPaise);
        expect(inv.igstPaise).toBe(0n);
      } else {
        // Inter-state guarantee: CGST === 0, SGST === 0, IGST > 0
        expect(inv.cgstPaise).toBe(0n);
        expect(inv.sgstPaise).toBe(0n);
        expect(inv.igstPaise).toBeGreaterThan(0n);
      }
    }
  });

  it('contains the canonical overdue invoice for Ravi Traders', () => {
    const raviInvoice = seed.invoices.find((i) => i.invoiceNumber === 'KAN/2026-27/0002');
    expect(raviInvoice).toBeDefined();
    expect(raviInvoice?.status).toBe('partially_paid');
    const outstanding = raviInvoice!.totalPaise - raviInvoice!.paidAmountPaise;
    expect(outstanding).toBe(4490000n); // ₹44,900
  });

  it('validates mathematical consistency of all seed expenses including round-off', () => {
    for (const exp of seed.expenses) {
      const computedTotal =
        exp.taxableAmountPaise + exp.cgstPaise + exp.sgstPaise + exp.igstPaise + exp.roundOffPaise;
      expect(exp.amountPaise).toBe(computedTotal);
    }

    // Specific check on AWS expense (₹8,500 = 850,000 paise)
    const awsExpense = seed.expenses.find((e) => e.vendorName === 'Amazon Web Services India');
    expect(awsExpense).toBeDefined();
    expect(awsExpense?.amountPaise).toBe(850000n);
    expect(awsExpense?.taxableAmountPaise).toBe(720339n);
    expect(awsExpense?.cgstPaise).toBe(64831n);
    expect(awsExpense?.sgstPaise).toBe(64831n);
    expect(awsExpense?.igstPaise).toBe(0n);
    expect(awsExpense?.roundOffPaise).toBe(-1n);
  });

  it('contains the canonical uncategorised expenses for September demo scenes', () => {
    const inkExpense = seed.expenses.find((e) => e.amountPaise === 240000n);
    expect(inkExpense).toBeDefined();
    expect(inkExpense?.description).toContain('Printer ink');
    expect(inkExpense?.categoryId).toBeNull(); // Uncategorised

    const awsExpense = seed.expenses.find((e) => e.amountPaise === 850000n);
    expect(awsExpense).toBeDefined();
    expect(awsExpense?.description).toContain('Monthly cloud hosting');
    expect(awsExpense?.categoryId).toBeNull(); // Uncategorised
  });

  it('maintains a strictly valid cryptographic SHA-256 audit hash chain and verifies against specification', () => {
    expect(seed.auditLogs.length).toBeGreaterThan(1);
    expect(seed.auditLogs[0]?.prevHash).toBe(
      '0000000000000000000000000000000000000000000000000000000000000000',
    );

    let prevHash = '0000000000000000000000000000000000000000000000000000000000000000';
    for (const log of seed.auditLogs) {
      expect(log.prevHash).toBe(prevHash);
      const expectedHash = computeAuditEntryHash({
        prevHash: log.prevHash,
        sequenceNumber: log.sequenceNumber,
        timestamp: log.createdAt,
        action: log.action,
        entityId: log.entityId,
        payloadHash: log.payloadHash,
      });
      expect(log.entryHash).toBe(expectedHash);
      prevHash = log.entryHash;
    }
  });

  it('persists durable business memory for customer communication preferences', () => {
    const raviPref = seed.businessMemory.find((m) =>
      m.entityKey.includes('c0000000-0000-0000-0000-000000000002'),
    );
    expect(raviPref).toBeDefined();
    expect(raviPref?.memoryValue).toEqual({
      preferredTone: 'polite',
      preferredChannel: 'whatsapp',
      contactName: 'Ravi Chandran',
    });
    expect(raviPref?.isActive).toBe(true);
  });

  it('strictly validates that all generated IDs are valid hexadecimal UUIDs', () => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(seed.business.id).toMatch(uuidRegex);
    for (const u of seed.users) expect(u.id).toMatch(uuidRegex);
    for (const c of seed.customers) expect(c.id).toMatch(uuidRegex);
    for (const a of seed.chartOfAccounts) expect(a.id).toMatch(uuidRegex);
    for (const ec of seed.expenseCategories) expect(ec.id).toMatch(uuidRegex);
    for (const inv of seed.invoices) expect(inv.id).toMatch(uuidRegex);
    for (const exp of seed.expenses) expect(exp.id).toMatch(uuidRegex);
    for (const p of seed.payments) expect(p.id).toMatch(uuidRegex);
    for (const je of seed.journalEntries) expect(je.id).toMatch(uuidRegex);
    for (const jl of seed.journalLines) expect(jl.id).toMatch(uuidRegex);
    for (const m of seed.businessMemory) expect(m.id).toMatch(uuidRegex);
    for (const l of seed.auditLogs) expect(l.id).toMatch(uuidRegex);
  });

  it('guarantees that all seeded invoices, expenses, and payments have balanced journal entries', () => {
    expect(seed.journalEntries.length).toBe(9);
    expect(seed.journalLines.length).toBeGreaterThanOrEqual(18);

    // Build entry line map
    const entryLinesMap = new Map<string, Array<{ debitPaise: bigint; creditPaise: bigint }>>();
    for (const line of seed.journalLines) {
      const list = entryLinesMap.get(line.journalEntryId) ?? [];
      list.push(line);
      entryLinesMap.set(line.journalEntryId, list);
    }

    // Every journal entry must have debits === credits
    for (const entry of seed.journalEntries) {
      const lines = entryLinesMap.get(entry.id);
      expect(lines).toBeDefined();
      expect(lines!.length).toBeGreaterThanOrEqual(2);
      const totalDebits = lines!.reduce((acc, l) => acc + l.debitPaise, 0n);
      const totalCredits = lines!.reduce((acc, l) => acc + l.creditPaise, 0n);
      expect(totalDebits).toBe(totalCredits);
      expect(totalDebits).toBeGreaterThan(0n);
    }

    // Every non-cancelled invoice must have a journal entry
    for (const inv of seed.invoices) {
      const je = seed.journalEntries.find(
        (e) => e.sourceEntityType === 'invoice' && e.sourceEntityId === inv.id,
      );
      expect(je).toBeDefined();
    }

    // Every expense must have a journal entry
    for (const exp of seed.expenses) {
      const je = seed.journalEntries.find(
        (e) => e.sourceEntityType === 'expense' && e.sourceEntityId === exp.id,
      );
      expect(je).toBeDefined();
    }

    // Every payment must have a journal entry
    for (const pay of seed.payments) {
      const je = seed.journalEntries.find(
        (e) => e.sourceEntityType === 'payment' && e.sourceEntityId === pay.id,
      );
      expect(je).toBeDefined();
    }
  });

  it('does not install a known or hardcoded owner API key and ensures non-reusable credentials', () => {
    // 1. Verify dynamic key was generated and hashed
    expect(seed.generatedOwnerApiKey).toBeDefined();
    expect(typeof seed.generatedOwnerApiKey).toBe('string');
    expect(seed.generatedOwnerApiKey.length).toBeGreaterThanOrEqual(32);

    const expectedHash = createHash('sha256').update(seed.generatedOwnerApiKey).digest('hex');
    expect(seed.users[0]?.apiKeyHash).toBe(expectedHash);

    // 2. Explicitly assert the repository does NOT seed the known fixed credential
    const prohibitedLiteralHash = createHash('sha256')
      .update('kanakku_test_secret_ramesh_2026')
      .digest('hex');
    expect(seed.users[0]?.apiKeyHash).not.toBe(prohibitedLiteralHash);

    // 3. Assert two consecutive runs generate distinct, non-reusable keys
    const secondSeed = generateSeedDataset();
    expect(secondSeed.generatedOwnerApiKey).not.toBe(seed.generatedOwnerApiKey);
    expect(secondSeed.users[0]?.apiKeyHash).not.toBe(seed.users[0]?.apiKeyHash);

    // 4. Assert out-of-band secret is properly supported and hashed
    const customSecret = 'out_of_band_custom_secret_998877';
    const customSeed = generateSeedDataset({ ownerApiKey: customSecret });
    const expectedCustomHash = createHash('sha256').update(customSecret).digest('hex');
    expect(customSeed.generatedOwnerApiKey).toBe(customSecret);
    expect(customSeed.users[0]?.apiKeyHash).toBe(expectedCustomHash);
  });
});
