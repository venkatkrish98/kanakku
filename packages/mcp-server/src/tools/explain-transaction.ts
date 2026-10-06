import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import type { KanakkuDatabase } from '@kanakku/db';
import {
  journalEntries,
  journalLines,
  chartOfAccounts,
  invoices,
  expenses,
  payments,
  auditLogs,
  customers,
} from '@kanakku/db';
import { formatInr } from '@kanakku/core';
import { getTenantContext } from '../auth/index.js';

export const explainTransactionSchema = {
  transaction_id: z.string().uuid().describe('UUID of the transaction to explain'),
  entity_type: z
    .enum(['invoice', 'expense', 'payment', 'journal_entry'])
    .describe('Type of the transaction entity'),
};

export async function handleExplainTransaction(
  args: z.infer<z.ZodObject<typeof explainTransactionSchema>>,
  db: KanakkuDatabase,
) {
  const tenant = getTenantContext();
  const businessId = tenant.businessId;
  const { transaction_id, entity_type } = args;

  let journalEntryRecord: {
    id: string;
    entryNumber: string;
    entryDate: Date;
    narration: string;
    sourceEntityType: string;
    sourceEntityId: string;
  } | null = null;

  let entityDetails: Record<string, unknown> = {};
  let accountingExplanation = '';
  let gstTreatment = '';
  let bookImpact = '';
  let partyName = '';

  // 1. Resolve Entity with strict tenant scoping
  if (entity_type === 'invoice') {
    const found = await db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        issueDate: invoices.issueDate,
        subtotalPaise: invoices.subtotalPaise,
        totalPaise: invoices.totalPaise,
        cgstPaise: invoices.cgstPaise,
        sgstPaise: invoices.sgstPaise,
        igstPaise: invoices.igstPaise,
        status: invoices.status,
        customerName: customers.name,
      })
      .from(invoices)
      .innerJoin(customers, eq(invoices.customerId, customers.id))
      .where(and(eq(invoices.id, transaction_id), eq(invoices.businessId, businessId)))
      .limit(1);

    if (!found[0]) {
      throw new Error(
        `INVOICE_NOT_FOUND: Invoice with ID "${transaction_id}" not found in your business`,
      );
    }
    const inv = found[0];
    partyName = inv.customerName;
    entityDetails = {
      type: 'invoice',
      invoice_number: inv.invoiceNumber,
      customer: inv.customerName,
      date: inv.issueDate.toISOString().slice(0, 10),
      subtotal_formatted: formatInr(inv.subtotalPaise),
      total_paise: Number(inv.totalPaise),
      total_formatted: formatInr(inv.totalPaise),
      cgst_formatted: formatInr(inv.cgstPaise),
      sgst_formatted: formatInr(inv.sgstPaise),
      igst_formatted: formatInr(inv.igstPaise),
      status: inv.status,
    };

    accountingExplanation = `Sales invoice issued to ${inv.customerName}. Debited Accounts Receivable (Asset) for ${formatInr(inv.totalPaise)}, credited Sales Revenue (Income) for ${formatInr(inv.subtotalPaise)}, and credited GST Output Tax Liability for ${formatInr(inv.cgstPaise + inv.sgstPaise + inv.igstPaise)}.`;
    gstTreatment = `Output GST of ${formatInr(inv.cgstPaise + inv.sgstPaise + inv.igstPaise)} collected on behalf of the government, payable on the next GSTR-3B monthly filing.`;
    bookImpact = `Increases your top-line revenue by ${formatInr(inv.subtotalPaise)} and creates a receivable asset of ${formatInr(inv.totalPaise)} until payment is received.`;

    const entry = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.businessId, businessId),
          eq(journalEntries.sourceEntityType, 'invoice'),
          eq(journalEntries.sourceEntityId, transaction_id),
        ),
      )
      .limit(1);
    journalEntryRecord = entry[0] ?? null;
  } else if (entity_type === 'expense') {
    const found = await db
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, transaction_id), eq(expenses.businessId, businessId)))
      .limit(1);

    if (!found[0]) {
      throw new Error(
        `EXPENSE_NOT_FOUND: Expense with ID "${transaction_id}" not found in your business`,
      );
    }
    const exp = found[0];
    partyName = exp.vendorName ?? exp.description;
    entityDetails = {
      type: 'expense',
      description: exp.description,
      vendor: exp.vendorName,
      date: exp.expenseDate.toISOString().slice(0, 10),
      amount_paise: Number(exp.amountPaise),
      amount_formatted: formatInr(exp.amountPaise),
      taxable_formatted: formatInr(exp.taxableAmountPaise),
      cgst_formatted: formatInr(exp.cgstPaise),
      sgst_formatted: formatInr(exp.sgstPaise),
      igst_formatted: formatInr(exp.igstPaise),
      is_itc_claimed: exp.isItcClaimed,
      payment_method: exp.paymentMethod,
    };

    const itcTotal = exp.cgstPaise + exp.sgstPaise + exp.igstPaise;
    accountingExplanation = `Business expense for "${exp.description}" paid via ${exp.paymentMethod}. Debited Expense Account for ${formatInr(exp.taxableAmountPaise)}, ${exp.isItcClaimed ? `debited Input Tax Credit for ${formatInr(itcTotal)}, ` : ''}and credited Bank/Cash for ${formatInr(exp.amountPaise)}.`;
    gstTreatment = exp.isItcClaimed
      ? `Input Tax Credit of ${formatInr(itcTotal)} claimed under Section 16, eligible to set off against output GST liability.`
      : 'No ITC claimed on this expense.';
    bookImpact = `Reduces operational cash/bank balance and recognizes ${formatInr(exp.taxableAmountPaise)} in operational expenditure on the P&L statement.`;

    const entry = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.businessId, businessId),
          eq(journalEntries.sourceEntityType, 'expense'),
          eq(journalEntries.sourceEntityId, transaction_id),
        ),
      )
      .limit(1);
    journalEntryRecord = entry[0] ?? null;
  } else if (entity_type === 'payment') {
    const found = await db
      .select({
        id: payments.id,
        amountPaise: payments.amountPaise,
        paymentDate: payments.paymentDate,
        paymentMode: payments.paymentMode,
        referenceNumber: payments.referenceNumber,
        customerName: customers.name,
      })
      .from(payments)
      .innerJoin(customers, eq(payments.customerId, customers.id))
      .where(and(eq(payments.id, transaction_id), eq(payments.businessId, businessId)))
      .limit(1);

    if (!found[0]) {
      throw new Error(
        `PAYMENT_NOT_FOUND: Payment with ID "${transaction_id}" not found in your business`,
      );
    }
    const pay = found[0];
    partyName = pay.customerName;
    entityDetails = {
      type: 'payment',
      customer: pay.customerName,
      amount_paise: Number(pay.amountPaise),
      amount_formatted: formatInr(pay.amountPaise),
      date: pay.paymentDate.toISOString().slice(0, 10),
      mode: pay.paymentMode,
      reference: pay.referenceNumber,
    };

    accountingExplanation = `Customer payment received from ${pay.customerName} via ${pay.paymentMode}. Debited Bank Account (Asset) for ${formatInr(pay.amountPaise)} and credited Accounts Receivable (Asset) for ${formatInr(pay.amountPaise)}.`;
    gstTreatment =
      'No GST impact on collection; tax was already recognized at the time of invoice issuance.';
    bookImpact = `Increases realized liquid bank balance and settles customer outstanding receivables.`;

    const entry = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.businessId, businessId),
          eq(journalEntries.sourceEntityType, 'payment'),
          eq(journalEntries.sourceEntityId, transaction_id),
        ),
      )
      .limit(1);
    journalEntryRecord = entry[0] ?? null;
  } else if (entity_type === 'journal_entry') {
    const found = await db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.id, transaction_id), eq(journalEntries.businessId, businessId)))
      .limit(1);

    if (!found[0]) {
      throw new Error(`JOURNAL_ENTRY_NOT_FOUND: Journal entry "${transaction_id}" not found`);
    }
    journalEntryRecord = found[0];
    entityDetails = {
      type: 'journal_entry',
      entry_number: found[0].entryNumber,
      date: found[0].entryDate.toISOString().slice(0, 10),
      narration: found[0].narration,
    };
    accountingExplanation = `Direct double-entry ledger journal entry: ${found[0].narration}.`;
    gstTreatment = 'Direct general journal adjustment.';
    bookImpact = 'Direct balance sheet and income statement ledger adjustment.';
  }

  // 2. Fetch Journal Lines if journal entry exists
  let lines: Array<{
    account_code: string;
    account_name: string;
    account_type: string;
    debit_paise: number;
    debit_formatted: string;
    credit_paise: number;
    credit_formatted: string;
  }> = [];

  let totalDebitsPaise = 0n;
  let totalCreditsPaise = 0n;

  if (journalEntryRecord) {
    const dbLines = await db
      .select({
        accountCode: chartOfAccounts.code,
        accountName: chartOfAccounts.name,
        accountType: chartOfAccounts.type,
        debitPaise: journalLines.debitPaise,
        creditPaise: journalLines.creditPaise,
      })
      .from(journalLines)
      .innerJoin(chartOfAccounts, eq(journalLines.accountId, chartOfAccounts.id))
      .where(
        and(
          eq(journalLines.businessId, businessId),
          eq(journalLines.journalEntryId, journalEntryRecord.id),
        ),
      );

    lines = dbLines.map((l) => {
      totalDebitsPaise += l.debitPaise;
      totalCreditsPaise += l.creditPaise;
      return {
        account_code: l.accountCode,
        account_name: l.accountName,
        account_type: l.accountType,
        debit_paise: Number(l.debitPaise),
        debit_formatted: formatInr(l.debitPaise),
        credit_paise: Number(l.creditPaise),
        credit_formatted: formatInr(l.creditPaise),
      };
    });
  }

  // 3. Fetch Audit Trail records for this transaction
  const auditEntries = await db
    .select({
      sequenceNumber: auditLogs.sequenceNumber,
      action: auditLogs.action,
      toolName: auditLogs.toolName,
      entryHash: auditLogs.entryHash,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(and(eq(auditLogs.businessId, businessId), eq(auditLogs.entityId, transaction_id)))
    .limit(5);

  const hasJournal = Boolean(journalEntryRecord);
  const isBalanced = hasJournal && totalDebitsPaise === totalCreditsPaise && totalDebitsPaise > 0n;

  let integrationStatus: 'verified_balanced_ledger' | 'unbalanced_ledger' | 'missing_journal_entry';
  let voiceSummary: string;

  if (!hasJournal) {
    integrationStatus = 'missing_journal_entry';
    voiceSummary = `This ${entity_type} for ${partyName || 'your books'} does not have a posted double-entry journal entry yet.`;
  } else if (!isBalanced) {
    integrationStatus = 'unbalanced_ledger';
    voiceSummary = `Warning: This ${entity_type} has an unbalanced journal entry with debits of ${formatInr(totalDebitsPaise)} and credits of ${formatInr(totalCreditsPaise)}.`;
  } else {
    integrationStatus = 'verified_balanced_ledger';
    voiceSummary = `This ${entity_type} for ${partyName || 'your books'} is verified and balanced in the double-entry ledger at ${formatInr(totalDebitsPaise)}.`;
  }

  const response = {
    voice_summary: voiceSummary,
    entity_details: entityDetails,
    accounting_explanation: {
      summary: accountingExplanation,
      gst_treatment: gstTreatment,
      book_impact: bookImpact,
    },
    journal_entry: journalEntryRecord
      ? {
          id: journalEntryRecord.id,
          entry_number: journalEntryRecord.entryNumber,
          date: journalEntryRecord.entryDate.toISOString().slice(0, 10),
          narration: journalEntryRecord.narration,
          total_debits_formatted: formatInr(totalDebitsPaise),
          total_credits_formatted: formatInr(totalCreditsPaise),
          is_balanced: isBalanced,
          lines,
        }
      : null,
    audit_trail: auditEntries.map((a) => ({
      sequence_number: a.sequenceNumber.toString(),
      action: a.action,
      tool: a.toolName,
      hash: a.entryHash.slice(0, 16) + '...',
      timestamp: a.createdAt.toISOString(),
    })),
    synthesis_engine: 'deterministic_double_entry_rules (ADR-002 compliant)',
    integration_status: integrationStatus,
  };

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(response, null, 2),
      },
    ],
  };
}
