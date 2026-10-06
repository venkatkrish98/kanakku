import { eq, and, sql, desc, gte, lt, inArray } from 'drizzle-orm';
import type { KanakkuDatabase } from '@kanakku/db';
import { chartOfAccounts, journalEntries, journalLines, invoices } from '@kanakku/db';

export async function getGlAccountByCode(
  db: KanakkuDatabase,
  businessId: string,
  code: string,
): Promise<{ id: string; code: string; name: string; type: string } | null> {
  const accounts = await db
    .select({
      id: chartOfAccounts.id,
      code: chartOfAccounts.code,
      name: chartOfAccounts.name,
      type: chartOfAccounts.type,
    })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.businessId, businessId), eq(chartOfAccounts.code, code)))
    .limit(1);

  return accounts[0] ?? null;
}

export async function requireGlAccountByCode(
  db: KanakkuDatabase,
  businessId: string,
  code: string,
  fallbackName: string,
  fallbackType: string,
): Promise<{ id: string; code: string; name: string; type: string }> {
  const existing = await getGlAccountByCode(db, businessId, code);
  if (existing) {
    return existing;
  }

  // Create standard fallback account if missing
  const [created] = await db
    .insert(chartOfAccounts)
    .values({
      businessId,
      code,
      name: fallbackName,
      type: fallbackType,
    })
    .returning();

  if (!created) {
    throw new Error(`Failed to create missing GL account ${code}`);
  }

  return {
    id: created.id,
    code: created.code,
    name: created.name,
    type: created.type,
  };
}

export async function getNextJournalEntryNumber(
  db: KanakkuDatabase,
  businessId: string,
  date: Date = new Date(),
): Promise<string> {
  const yyyymm = date.toISOString().slice(0, 7).replace('-', '');
  const prefix = `JRN-${yyyymm}-`;

  const latest = await db
    .select({ entryNumber: journalEntries.entryNumber })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.businessId, businessId),
        sql`${journalEntries.entryNumber} LIKE ${prefix + '%'}`,
      ),
    )
    .orderBy(desc(journalEntries.entryNumber))
    .limit(1);

  let nextSeq = 1;
  if (latest[0]) {
    const parts = latest[0].entryNumber.split('-');
    const lastNum = parseInt(parts[parts.length - 1] ?? '0', 10);
    if (!Number.isNaN(lastNum)) {
      nextSeq = lastNum + 1;
    }
  }

  return `${prefix}${nextSeq.toString().padStart(4, '0')}`;
}

export async function getNextInvoiceNumber(
  db: KanakkuDatabase,
  businessId: string,
  financialYear: string,
): Promise<string> {
  const prefix = `KAN/${financialYear}/`;

  const latest = await db
    .select({ invoiceNumber: invoices.invoiceNumber })
    .from(invoices)
    .where(
      and(
        eq(invoices.businessId, businessId),
        sql`${invoices.invoiceNumber} LIKE ${prefix + '%'}`,
      ),
    )
    .orderBy(desc(invoices.invoiceNumber))
    .limit(1);

  let nextSeq = 1;
  if (latest[0]) {
    const parts = latest[0].invoiceNumber.split('/');
    const lastNum = parseInt(parts[parts.length - 1] ?? '0', 10);
    if (!Number.isNaN(lastNum)) {
      nextSeq = lastNum + 1;
    }
  }

  return `${prefix}${nextSeq.toString().padStart(4, '0')}`;
}

export interface TransactionToVerify {
  type: 'invoice' | 'expense' | 'payment';
  id: string;
  reference: string;
  expectedAmountPaise?: number;
}

export interface AmountMismatchTransaction {
  type: 'invoice' | 'expense' | 'payment';
  id: string;
  reference: string;
  expectedAmountPaise: number;
  actualAmountPaise: number;
  expectedAmountPaiseExact: string;
  actualAmountPaiseExact: string;
  entryNumber: string;
}

export interface LedgerVerificationResult {
  isBalanced: boolean;
  totalDebitsPaise: bigint;
  totalCreditsPaise: bigint;
  unbalancedEntryNumbers: string[];
  missingJournalTransactions: TransactionToVerify[];
  duplicateJournalTransactions: Array<TransactionToVerify & { count: number }>;
  amountMismatchTransactions: AmountMismatchTransaction[];
  invalidJournalEntries: Array<{ entryNumber: string; reason: string }>;
  journalEntriesCount: number;
  journalLinesCount: number;
}

/**
 * Validates complete double-entry ledger coverage for a period:
 * 1. Checks that all journal entries dated in the period have at least one line,
 *    have a nonzero balanced amount (debits > 0 and debits === credits), and are not unbalanced.
 * 2. Checks that every active (non-cancelled) invoice, expense, and payment has
 *    EXACTLY ONE valid journal entry dated within the requested period.
 * 3. Checks that each journal entry's balanced amount matches the expected transaction amount.
 */
export async function verifyPeriodLedgerCoverage(
  dbOrTx: KanakkuDatabase | Parameters<Parameters<KanakkuDatabase['transaction']>[0]>[0],
  businessId: string,
  startDate: Date,
  endDate: Date,
  activeInvoices: Array<{ id: string; invoiceNumber: string; totalPaise?: bigint; status: string }>,
  activeExpenses: Array<{ id: string; description?: string | null; amountPaise?: bigint; status: string }>,
  activePayments: Array<{ id: string; referenceNumber?: string | null; amountPaise?: bigint }>,
): Promise<LedgerVerificationResult> {
  // 1. Fetch journal entries strictly dated within the requested period
  const entries = await dbOrTx
    .select({
      id: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      entryDate: journalEntries.entryDate,
      sourceEntityType: journalEntries.sourceEntityType,
      sourceEntityId: journalEntries.sourceEntityId,
    })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.businessId, businessId),
        gte(journalEntries.entryDate, startDate),
        lt(journalEntries.entryDate, endDate),
      ),
    );

  let totalDebitsPaise = 0n;
  let totalCreditsPaise = 0n;
  let linesCount = 0;
  const unbalancedEntryNumbers: string[] = [];
  const invalidJournalEntries: Array<{ entryNumber: string; reason: string }> = [];

  const entryStats = new Map<string, { debits: bigint; credits: bigint; lineCount: number }>();
  for (const entry of entries) {
    entryStats.set(entry.id, { debits: 0n, credits: 0n, lineCount: 0 });
  }

  if (entries.length > 0) {
    const entryIds = entries.map((e) => e.id);
    const lines = await dbOrTx
      .select({
        journalEntryId: journalLines.journalEntryId,
        debitPaise: journalLines.debitPaise,
        creditPaise: journalLines.creditPaise,
      })
      .from(journalLines)
      .where(
        and(
          eq(journalLines.businessId, businessId),
          inArray(journalLines.journalEntryId, entryIds),
        ),
      );

    linesCount = lines.length;
    for (const line of lines) {
      totalDebitsPaise += line.debitPaise;
      totalCreditsPaise += line.creditPaise;
      const stats = entryStats.get(line.journalEntryId);
      if (stats) {
        stats.debits += line.debitPaise;
        stats.credits += line.creditPaise;
        stats.lineCount += 1;
      }
    }
  }

  // Verify each journal entry:
  // Must have at least 1 line, nonzero debits, and balanced debits === credits
  for (const entry of entries) {
    const stats = entryStats.get(entry.id);
    if (!stats || stats.lineCount === 0) {
      unbalancedEntryNumbers.push(entry.entryNumber);
      invalidJournalEntries.push({
        entryNumber: entry.entryNumber,
        reason: 'Journal header has no journal lines',
      });
    } else if (stats.debits === 0n && stats.credits === 0n) {
      unbalancedEntryNumbers.push(entry.entryNumber);
      invalidJournalEntries.push({
        entryNumber: entry.entryNumber,
        reason: 'Journal entry has zero amount lines',
      });
    } else if (stats.debits !== stats.credits) {
      unbalancedEntryNumbers.push(entry.entryNumber);
      invalidJournalEntries.push({
        entryNumber: entry.entryNumber,
        reason: `Journal entry debits (${stats.debits}) do not equal credits (${stats.credits})`,
      });
    }
  }

  // 2. Map period entries by sourceEntityType:sourceEntityId
  const sourceMap = new Map<string, Array<typeof entries[number]>>();
  for (const entry of entries) {
    if (entry.sourceEntityType && entry.sourceEntityId) {
      const key = `${entry.sourceEntityType}:${entry.sourceEntityId}`;
      const list = sourceMap.get(key) ?? [];
      list.push(entry);
      sourceMap.set(key, list);
    }
  }

  const missingJournalTransactions: TransactionToVerify[] = [];
  const duplicateJournalTransactions: Array<TransactionToVerify & { count: number }> = [];
  const amountMismatchTransactions: AmountMismatchTransaction[] = [];

  function verifyTransaction(
    type: 'invoice' | 'expense' | 'payment',
    id: string,
    reference: string,
    expectedAmountPaise?: bigint,
  ) {
    const expNum = expectedAmountPaise !== undefined ? Number(expectedAmountPaise) : undefined;
    const key = `${type}:${id}`;
    const matching = sourceMap.get(key) ?? [];
    if (matching.length === 0) {
      missingJournalTransactions.push({ type, id, reference, expectedAmountPaise: expNum });
    } else if (matching.length > 1) {
      duplicateJournalTransactions.push({
        type,
        id,
        reference,
        expectedAmountPaise: expNum,
        count: matching.length,
      });
    } else {
      const entry = matching[0]!;
      const stats = entryStats.get(entry.id);
      if (!stats || stats.lineCount === 0 || stats.debits === 0n || stats.debits !== stats.credits) {
        missingJournalTransactions.push({ type, id, reference, expectedAmountPaise: expNum });
      } else if (expectedAmountPaise !== undefined && stats.debits !== expectedAmountPaise) {
        amountMismatchTransactions.push({
          type,
          id,
          reference,
          expectedAmountPaise: expNum!,
          actualAmountPaise: Number(stats.debits),
          expectedAmountPaiseExact: expectedAmountPaise.toString(),
          actualAmountPaiseExact: stats.debits.toString(),
          entryNumber: entry.entryNumber,
        });
        invalidJournalEntries.push({
          entryNumber: entry.entryNumber,
          reason: `Journal entry ${entry.entryNumber} balanced amount (${stats.debits} paise) does not match transaction ${type} ${reference} amount (${expectedAmountPaise} paise)`,
        });
      }
    }
  }

  for (const inv of activeInvoices) {
    if (inv.status !== 'cancelled') {
      verifyTransaction('invoice', inv.id, inv.invoiceNumber, inv.totalPaise);
    }
  }

  for (const exp of activeExpenses) {
    if (exp.status !== 'cancelled') {
      verifyTransaction('expense', exp.id, exp.description ?? exp.id, exp.amountPaise);
    }
  }

  for (const pay of activePayments) {
    verifyTransaction('payment', pay.id, pay.referenceNumber ?? pay.id, pay.amountPaise);
  }

  const isBalanced =
    totalDebitsPaise === totalCreditsPaise &&
    unbalancedEntryNumbers.length === 0 &&
    missingJournalTransactions.length === 0 &&
    duplicateJournalTransactions.length === 0 &&
    amountMismatchTransactions.length === 0 &&
    invalidJournalEntries.length === 0;

  return {
    isBalanced,
    totalDebitsPaise,
    totalCreditsPaise,
    unbalancedEntryNumbers,
    missingJournalTransactions,
    duplicateJournalTransactions,
    amountMismatchTransactions,
    invalidJournalEntries,
    journalEntriesCount: entries.length,
    journalLinesCount: linesCount,
  };
}
