import { z } from 'zod';
import { eq, and, gte, lt } from 'drizzle-orm';
import type { KanakkuDatabase } from '@kanakku/db';
import {
  monthEndReports,
  expenses,
  invoices,
  payments,
  pendingConfirmations,
  journalEntries,
  journalLines,
  expenseCategories,
  chartOfAccounts,
} from '@kanakku/db';
import {
  generateConfirmationToken,
  formatInr,
  computeGstSetOff,
  getMonthDateRangeIst,
} from '@kanakku/core';
import { getTenantContext } from '../auth/index.js';
import { appendAuditLog } from '../audit/index.js';
import { acquirePeriodLock, assertPeriodOpen } from './confirm-action.js';
import { verifyPeriodLedgerCoverage } from './ledger-helper.js';
import {
  saveActiveWorkflowState,
  loadActiveWorkflowState,
  resolveSessionContext,
} from './session-helper.js';

export const closeMonthSchema = {
  month: z
    .number()
    .int()
    .min(1)
    .max(12)
    .optional()
    .describe(
      'Month number to close (1-12). Inferred from active session workflow or previous month if omitted.',
    ),
  year: z
    .number()
    .int()
    .min(2020)
    .max(2040)
    .optional()
    .describe(
      'Fiscal calendar year (e.g. 2026). Inferred from active session workflow or previous month if omitted.',
    ),
  step: z
    .enum(['scan', 'categorise', 'reconcile', 'prepare_close', 'resume'])
    .optional()
    .describe(
      'Step in the month-end close workflow. Omit or set to "resume" to auto-detect and advance from the current workflow state.',
    ),
  sessionId: z
    .string()
    .optional()
    .describe('Optional conversation session ID to persist and retrieve active workflow state.'),
  payload: z
    .record(z.unknown())
    .optional()
    .describe(
      'Optional payload or clarification response (e.g. { categorisations: [{ expense_id, category_id }], allow_general_expense: boolean })',
    ),
};

export async function handleCloseMonth(
  args: z.infer<z.ZodObject<typeof closeMonthSchema>>,
  db: KanakkuDatabase,
) {
  const tenant = getTenantContext();
  const businessId = tenant.businessId;
  const sessionIdentifier = args.sessionId || tenant.sessionId;

  // Validate session context early to guard against cross-tenant collisions
  if (sessionIdentifier) {
    await resolveSessionContext(db, businessId, sessionIdentifier);
  }

  // 1. Resolve month and year: from args, or from active workflow session, or default to previous calendar month in IST
  let resolvedMonth = args.month;
  let resolvedYear = args.year;

  if (!resolvedMonth || !resolvedYear) {
    const activeWorkflow = await loadActiveWorkflowState(
      db,
      businessId,
      'close_month',
      sessionIdentifier,
    );
    if (activeWorkflow?.workflowState?.['month'] && activeWorkflow?.workflowState?.['year']) {
      resolvedMonth = Number(activeWorkflow.workflowState['month']);
      resolvedYear = Number(activeWorkflow.workflowState['year']);
    } else {
      const now = new Date();
      const istNow = new Date(now.getTime() + (5 * 60 + 30) * 60 * 1000);
      const currentMonth = istNow.getUTCMonth() + 1; // 1-12
      const currentYear = istNow.getUTCFullYear();
      resolvedMonth = currentMonth === 1 ? 12 : currentMonth - 1;
      resolvedYear = currentMonth === 1 ? currentYear - 1 : currentYear;
    }
  }

  const month: number = resolvedMonth!;
  const year: number = resolvedYear!;

  // 2. Verify if the month is already closed
  const existingReport = await db
    .select()
    .from(monthEndReports)
    .where(
      and(
        eq(monthEndReports.businessId, businessId),
        eq(monthEndReports.month, month),
        eq(monthEndReports.year, year),
      ),
    )
    .limit(1);

  if (existingReport[0]?.isClosed) {
    await saveActiveWorkflowState(
      db,
      businessId,
      null,
      {
        month,
        year,
        step: 'closed',
        status: 'already_closed',
        closed_at: existingReport[0].closedAt?.toISOString(),
      },
      sessionIdentifier,
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              status: 'already_closed',
              workflow_state: 'closed',
              month,
              year,
              closed_at: existingReport[0].closedAt,
              message: `Month ${month}/${year} was already closed on ${existingReport[0].closedAt?.toISOString().slice(0, 10)}. Books are locked.`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // 2. Define month date boundaries in Indian Standard Time (IST, UTC+05:30)
  const { startDate, endDate } = getMonthDateRangeIst(month, year);

  // 3. Scan month transactions
  const monthInvoices = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      subtotalPaise: invoices.subtotalPaise,
      cgstPaise: invoices.cgstPaise,
      sgstPaise: invoices.sgstPaise,
      igstPaise: invoices.igstPaise,
      totalPaise: invoices.totalPaise,
      status: invoices.status,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.businessId, businessId),
        gte(invoices.issueDate, startDate),
        lt(invoices.issueDate, endDate),
      ),
    );

  const monthExpenses = await db
    .select({
      id: expenses.id,
      categoryId: expenses.categoryId,
      amountPaise: expenses.amountPaise,
      taxableAmountPaise: expenses.taxableAmountPaise,
      cgstPaise: expenses.cgstPaise,
      sgstPaise: expenses.sgstPaise,
      igstPaise: expenses.igstPaise,
      isItcClaimed: expenses.isItcClaimed,
      description: expenses.description,
      status: expenses.status,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.businessId, businessId),
        gte(expenses.expenseDate, startDate),
        lt(expenses.expenseDate, endDate),
      ),
    );

  const monthPayments = await db
    .select({
      id: payments.id,
      amountPaise: payments.amountPaise,
      referenceNumber: payments.referenceNumber,
      status: payments.status,
    })
    .from(payments)
    .where(
      and(
        eq(payments.businessId, businessId),
        gte(payments.paymentDate, startDate),
        lt(payments.paymentDate, endDate),
      ),
    );

  // Compute Aggregations
  let totalBilledRevenuePaise = 0n;
  let totalOutputCgstPaise = 0n;
  let totalOutputSgstPaise = 0n;
  let totalOutputIgstPaise = 0n;

  for (const inv of monthInvoices) {
    if (inv.status !== 'cancelled') {
      totalBilledRevenuePaise += inv.subtotalPaise;
      totalOutputCgstPaise += inv.cgstPaise;
      totalOutputSgstPaise += inv.sgstPaise;
      totalOutputIgstPaise += inv.igstPaise;
    }
  }

  let totalExpensesPaise = 0n;
  let totalInputCgstPaise = 0n;
  let totalInputSgstPaise = 0n;
  let totalInputIgstPaise = 0n;
  let uncategorizedCount = 0;

  for (const exp of monthExpenses) {
    if (exp.status !== 'cancelled') {
      totalExpensesPaise += exp.amountPaise;
      if (exp.isItcClaimed) {
        totalInputCgstPaise += exp.cgstPaise;
        totalInputSgstPaise += exp.sgstPaise;
        totalInputIgstPaise += exp.igstPaise;
      }
      if (!exp.categoryId) {
        uncategorizedCount++;
      }
    }
  }

  let totalCollectionsPaise = 0n;
  for (const pay of monthPayments) {
    totalCollectionsPaise += pay.amountPaise;
  }

  // GST Section 49 Set-off calculation
  const setOff = computeGstSetOff({
    outputTax: {
      cgstPaise: totalOutputCgstPaise,
      sgstPaise: totalOutputSgstPaise,
      igstPaise: totalOutputIgstPaise,
    },
    availableItc: {
      cgstPaise: totalInputCgstPaise,
      sgstPaise: totalInputSgstPaise,
      igstPaise: totalInputIgstPaise,
    },
  });

  const netOperatingProfitPaise = totalBilledRevenuePaise - totalExpensesPaise;

  // Helper to persist workflow state across steps
  async function persistWorkflowState(
    stepName: string,
    stateData: Record<string, unknown>,
    executor?: KanakkuDatabase | Parameters<Parameters<KanakkuDatabase['transaction']>[0]>[0],
  ) {
    const runner = executor ?? db;
    const existing = await runner
      .select({ id: monthEndReports.id })
      .from(monthEndReports)
      .where(
        and(
          eq(monthEndReports.businessId, businessId),
          eq(monthEndReports.month, month),
          eq(monthEndReports.year, year),
          eq(monthEndReports.isClosed, false),
        ),
      )
      .limit(1);

    const summary = { step: stepName, ...stateData, updated_at: new Date().toISOString() };
    if (existing[0]) {
      await runner
        .update(monthEndReports)
        .set({
          summaryJson: summary,
          narrationMarkdown: `Workflow step "${stepName}" in progress`,
        })
        .where(eq(monthEndReports.id, existing[0].id));
    } else {
      await runner.insert(monthEndReports).values({
        businessId,
        month,
        year,
        isClosed: false,
        summaryJson: summary,
        narrationMarkdown: `Workflow step "${stepName}" in progress`,
      });
    }

    // Also persist into sessionContext for durable cross-turn session recall
    await saveActiveWorkflowState(
      runner,
      businessId,
      'close_month',
      { month, year, step: stepName, ...stateData },
      sessionIdentifier,
    );
  }

  // Resolve effective step: If step is omitted or 'resume', auto-detect based on current workflow state
  const requestedStep = args.step;
  let effectiveStep: 'scan' | 'categorise' | 'reconcile' | 'prepare_close';

  const prevSummary = existingReport[0]?.summaryJson as Record<string, unknown> | undefined;
  const prevStep = prevSummary?.step as string | undefined;

  if (!requestedStep || requestedStep === 'resume') {
    if (!prevStep) {
      effectiveStep = 'scan';
    } else if (prevStep === 'scan') {
      if (uncategorizedCount > 0) {
        effectiveStep = 'categorise';
      } else {
        effectiveStep = 'reconcile';
      }
    } else if (prevStep === 'categorise') {
      const allowGeneral =
        args.payload?.allow_general_expense === true ||
        prevSummary?.['allow_general_expense'] === true;
      if (uncategorizedCount > 0 && !allowGeneral && !args.payload?.categorisations) {
        effectiveStep = 'categorise';
      } else {
        effectiveStep = 'reconcile';
      }
    } else if (prevStep === 'reconcile') {
      if (prevSummary?.ledger_balanced === true) {
        effectiveStep = 'prepare_close';
      } else {
        effectiveStep = 'reconcile';
      }
    } else if (prevStep === 'prepare_close') {
      effectiveStep = 'prepare_close';
    } else {
      effectiveStep = 'scan';
    }
  } else {
    effectiveStep = requestedStep;
  }

  // Handle Workflow Steps
  if (effectiveStep === 'scan') {
    const clarificationQuestions: string[] = [];
    if (uncategorizedCount > 0) {
      clarificationQuestions.push(
        `There are ${uncategorizedCount} uncategorized expenses in this period. Would you like to categorize them before closing?`,
      );
    }
    const openInvoicesCount = monthInvoices.filter((i) => i.status === 'issued').length;
    if (openInvoicesCount > 0) {
      clarificationQuestions.push(
        `${openInvoicesCount} invoices are currently unpaid. Would you like to dispatch reminders?`,
      );
    }

    await persistWorkflowState('scan', {
      invoices_count: monthInvoices.length,
      expenses_count: monthExpenses.length,
      payments_count: monthPayments.length,
      uncategorized_expenses_count: uncategorizedCount,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              step: 'scan',
              status: 'scan_complete',
              workflow_state: 'scan_complete',
              month,
              year,
              invoices_count: monthInvoices.length,
              expenses_count: monthExpenses.length,
              payments_count: monthPayments.length,
              uncategorized_expenses_count: uncategorizedCount,
              clarification_questions: clarificationQuestions,
              next_recommended_step: uncategorizedCount > 0 ? 'categorise' : 'reconcile',
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (effectiveStep === 'categorise') {
    // Role Gate: Reclassifying expenses and updating accounting journals requires owner or accountant
    if (tenant.userRole !== 'owner' && tenant.userRole !== 'accountant') {
      throw new Error(
        `UNAUTHORIZED: User role '${tenant.userRole}' is not authorized to categorise expenses or reclassify journal entries. Only 'owner' and 'accountant' roles can perform accounting categorisation.`,
      );
    }

    // 1. Workflow sequence check: Ensure 'scan' has been performed for this month/year
    const prevSummary = existingReport[0]?.summaryJson as Record<string, unknown> | undefined;
    const prevStep = prevSummary?.step;
    if (!prevStep || (prevStep !== 'scan' && prevStep !== 'categorise')) {
      throw new Error(
        'WORKFLOW_SEQUENCE_ERROR: Step "scan" must be executed before "categorise" in the month-end close workflow.',
      );
    }

    let appliedCount = 0;
    const categorisations = args.payload?.categorisations;
    const allowGeneralExpense =
      args.payload?.allow_general_expense === true ||
      prevSummary?.['allow_general_expense'] === true;

    // Wrap categorisation in a database transaction to acquire period lock, check period open,
    // update expense category, reclassify the corresponding journal line, and append audit log.
    await db.transaction(async (tx) => {
      // Period serialization lock: serialize categorisation against concurrent closes and postings
      await acquirePeriodLock(tx, businessId, year, month);

      // Period lock check: reject categorisation in closed accounting periods
      await assertPeriodOpen(tx, businessId, startDate, 'categorisation');

      if (Array.isArray(categorisations)) {
        for (const item of categorisations) {
          if (item && typeof item === 'object' && 'expense_id' in item && 'category_id' in item) {
            const expenseId = String(item.expense_id);
            const categoryId = String(item.category_id);

            // Verify category belongs to tenant and fetch GL account
            const validCat = await tx
              .select({
                id: expenseCategories.id,
                glAccountId: expenseCategories.glAccountId,
                name: expenseCategories.name,
              })
              .from(expenseCategories)
              .where(
                and(
                  eq(expenseCategories.id, categoryId),
                  eq(expenseCategories.businessId, businessId),
                ),
              )
              .limit(1);

            if (!validCat[0]) {
              throw new Error(
                `CATEGORY_NOT_FOUND: Expense category "${categoryId}" not found in your business.`,
              );
            }

            // Verify expense exists and belongs to the requested IST month [startDate, endDate)
            const [existingExpense] = await tx
              .select({
                id: expenses.id,
                categoryId: expenses.categoryId,
                expenseDate: expenses.expenseDate,
              })
              .from(expenses)
              .where(and(eq(expenses.id, expenseId), eq(expenses.businessId, businessId)))
              .limit(1);

            if (!existingExpense) {
              throw new Error(
                `EXPENSE_NOT_FOUND: Expense "${expenseId}" was not found in your business.`,
              );
            }

            if (existingExpense.expenseDate < startDate || existingExpense.expenseDate >= endDate) {
              throw new Error(
                `INVALID_CATEGORISATION: Expense "${expenseId}" falls outside the workflow period (${month}/${year}). Cannot categorise an expense with date ${existingExpense.expenseDate.toISOString().slice(0, 10)} during month ${month}/${year} close.`,
              );
            }

            // Update category
            await tx.update(expenses).set({ categoryId }).where(eq(expenses.id, expenseId));

            appliedCount++;

            // Reclassify the expense's existing double-entry journal entry line if one exists
            const [jEntry] = await tx
              .select({ id: journalEntries.id, entryNumber: journalEntries.entryNumber })
              .from(journalEntries)
              .where(
                and(
                  eq(journalEntries.businessId, businessId),
                  eq(journalEntries.sourceEntityType, 'expense'),
                  eq(journalEntries.sourceEntityId, expenseId),
                ),
              )
              .limit(1);

            let previousGlAccountId: string | null = null;
            let previousGlAccountCode: string | null = null;
            let reclassifiedDebitPaise = 0;
            let glAccountChanged = false;

            if (jEntry && validCat[0].glAccountId) {
              // Find the expense debit line in the journal entry
              const lines = await tx
                .select({
                  lineId: journalLines.id,
                  accountId: journalLines.accountId,
                  accountCode: chartOfAccounts.code,
                  accountType: chartOfAccounts.type,
                  debitPaise: journalLines.debitPaise,
                })
                .from(journalLines)
                .innerJoin(chartOfAccounts, eq(journalLines.accountId, chartOfAccounts.id))
                .where(
                  and(
                    eq(journalLines.businessId, businessId),
                    eq(journalLines.journalEntryId, jEntry.id),
                  ),
                );

              const expenseDebitLine = lines.find(
                (l) =>
                  l.debitPaise > 0n &&
                  (l.accountType === 'expense' ||
                    !['1210', '1220', '1230'].includes(l.accountCode)),
              );

              if (expenseDebitLine) {
                previousGlAccountId = expenseDebitLine.accountId;
                previousGlAccountCode = expenseDebitLine.accountCode;
                reclassifiedDebitPaise = Number(expenseDebitLine.debitPaise);

                if (expenseDebitLine.accountId !== validCat[0].glAccountId) {
                  glAccountChanged = true;
                  await tx
                    .update(journalLines)
                    .set({ accountId: validCat[0].glAccountId })
                    .where(eq(journalLines.id, expenseDebitLine.lineId));
                }
              }
            }

            // Append audit log for every category change - even when GL account stays the same
            await appendAuditLog(tx, {
              businessId,
              userId: tenant.userId,
              source: 'mcp_client',
              toolName: 'close_month',
              action: glAccountChanged ? 'reclassify_expense' : 'categorise_expense',
              entityType: 'expense',
              entityId: expenseId,
              beforeState: {
                category_id: existingExpense.categoryId,
                gl_account_id: previousGlAccountId,
                gl_account_code: previousGlAccountCode,
              },
              afterState: {
                category_id: categoryId,
                category_name: validCat[0].name,
                new_category_id: categoryId,
                new_category_name: validCat[0].name,
                gl_account_id: validCat[0].glAccountId,
                new_gl_account_id: validCat[0].glAccountId,
                journal_entry_id: jEntry?.id ?? null,
                journal_entry_number: jEntry?.entryNumber ?? null,
                journal_reclassified: glAccountChanged,
                reclassified_debit_paise: reclassifiedDebitPaise,
                month,
                year,
              },
            });
          }
        }
      }

      await persistWorkflowState(
        'categorise',
        {
          applied_categorisations: appliedCount,
          remaining_uncategorized: Math.max(0, uncategorizedCount - appliedCount),
          allow_general_expense: allowGeneralExpense,
          unresolved_treatment:
            uncategorizedCount - appliedCount > 0 && allowGeneralExpense
              ? 'general_operational_expense'
              : 'none',
        },
        tx,
      );
    });

    const remainingUncategorized = Math.max(0, uncategorizedCount - appliedCount);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              step: 'categorise',
              status: 'categorisation_verified',
              workflow_state: 'categorisation_reviewed',
              month,
              year,
              applied_categorisations: appliedCount,
              uncategorized_count: remainingUncategorized,
              allow_general_expense: allowGeneralExpense,
              unresolved_treatment:
                remainingUncategorized > 0
                  ? allowGeneralExpense
                    ? 'general_operational_expense'
                    : 'pending_approval'
                  : 'none',
              summary:
                remainingUncategorized <= 0
                  ? 'All expenses are properly mapped to tax-deductible categories.'
                  : allowGeneralExpense
                    ? `${remainingUncategorized} items approved to be closed under General Operational Expense.`
                    : `${remainingUncategorized} items remain uncategorized. Categorize them or pass allow_general_expense: true to approve.`,
              next_recommended_step: 'reconcile',
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (effectiveStep === 'reconcile') {
    // 1. Workflow sequence check: Ensure 'scan' or 'categorise' was executed
    const prevSummary = existingReport[0]?.summaryJson as Record<string, unknown> | undefined;
    const prevStep = prevSummary?.step;
    if (!prevStep || !['scan', 'categorise', 'reconcile'].includes(String(prevStep))) {
      throw new Error(
        'WORKFLOW_SEQUENCE_ERROR: Step "scan" must be executed before "reconcile" in the month-end close workflow.',
      );
    }

    // Refresh month expenses to reflect any categorisations performed
    const currentMonthExpenses = await db
      .select({ id: expenses.id, categoryId: expenses.categoryId })
      .from(expenses)
      .where(
        and(
          eq(expenses.businessId, businessId),
          gte(expenses.expenseDate, startDate),
          lt(expenses.expenseDate, endDate),
        ),
      );

    const remainingUncategorized = currentMonthExpenses.filter((e) => !e.categoryId);
    const allowGeneralExpense =
      args.payload?.allow_general_expense === true ||
      prevSummary?.['allow_general_expense'] === true;

    // Reject advancement if uncategorized expenses exist without explicit user approval
    if (remainingUncategorized.length > 0 && !allowGeneralExpense) {
      throw new Error(
        `UNCATEGORIZED_EXPENSES_REMAINING: There are ${remainingUncategorized.length} uncategorized expenses for ${month}/${year}. Categorize all expenses first, or provide explicit approval via { allow_general_expense: true } in the payload to treat them as General Operational Expenses.`,
      );
    }

    // 2. Comprehensive Period Ledger Coverage & Balance Verification
    const ledgerCoverage = await verifyPeriodLedgerCoverage(
      db,
      businessId,
      startDate,
      endDate,
      monthInvoices,
      monthExpenses,
      monthPayments,
    );

    const isBalanced = ledgerCoverage.isBalanced;

    await persistWorkflowState('reconcile', {
      total_debits_paise: Number(ledgerCoverage.totalDebitsPaise),
      total_credits_paise: Number(ledgerCoverage.totalCreditsPaise),
      ledger_balanced: isBalanced,
      unbalanced_entries: ledgerCoverage.unbalancedEntryNumbers,
      missing_journal_transactions: ledgerCoverage.missingJournalTransactions,
      duplicate_journal_transactions: ledgerCoverage.duplicateJournalTransactions,
      amount_mismatch_transactions: ledgerCoverage.amountMismatchTransactions,
      invalid_journal_entries: ledgerCoverage.invalidJournalEntries,
      journal_lines_count: ledgerCoverage.journalLinesCount,
      journal_entries_count: ledgerCoverage.journalEntriesCount,
      uncategorized_expenses_count: remainingUncategorized.length,
      unresolved_treatment:
        remainingUncategorized.length > 0 ? 'general_operational_expense' : 'none',
      allow_general_expense: allowGeneralExpense,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              step: 'reconcile',
              status: isBalanced ? 'reconciliation_verified' : 'reconciliation_failed',
              workflow_state: isBalanced
                ? 'reconciliation_verified'
                : ledgerCoverage.missingJournalTransactions.length > 0
                  ? 'missing_journal_entries_detected'
                  : ledgerCoverage.amountMismatchTransactions.length > 0
                    ? 'amount_mismatch_detected'
                    : 'ledger_imbalance_detected',
              month,
              year,
              total_billed: formatInr(totalBilledRevenuePaise),
              total_collected: formatInr(totalCollectionsPaise),
              total_expenses: formatInr(totalExpensesPaise),
              net_cash_delta: formatInr(totalCollectionsPaise - totalExpensesPaise),
              total_ledger_debits: formatInr(ledgerCoverage.totalDebitsPaise),
              total_ledger_credits: formatInr(ledgerCoverage.totalCreditsPaise),
              ledger_balanced: isBalanced,
              unbalanced_entries: ledgerCoverage.unbalancedEntryNumbers,
              missing_journal_transactions: ledgerCoverage.missingJournalTransactions,
              duplicate_journal_transactions: ledgerCoverage.duplicateJournalTransactions,
              amount_mismatch_transactions: ledgerCoverage.amountMismatchTransactions,
              invalid_journal_entries: ledgerCoverage.invalidJournalEntries,
              journal_entries_verified: ledgerCoverage.journalEntriesCount,
              journal_lines_verified: ledgerCoverage.journalLinesCount,
              uncategorized_count: remainingUncategorized.length,
              unresolved_treatment:
                remainingUncategorized.length > 0 ? 'general_operational_expense' : 'none',
              allow_general_expense: allowGeneralExpense,
              next_recommended_step: isBalanced ? 'prepare_close' : 'scan',
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // Step 'prepare_close': Validate that reconcile with balanced ledger was completed
  const [latestReport] = await db
    .select({ summaryJson: monthEndReports.summaryJson })
    .from(monthEndReports)
    .where(
      and(
        eq(monthEndReports.businessId, businessId),
        eq(monthEndReports.month, month),
        eq(monthEndReports.year, year),
      ),
    )
    .limit(1);

  const latestSummary = (latestReport?.summaryJson ?? prevSummary) as
    Record<string, unknown> | undefined;
  if (
    !latestSummary ||
    (latestSummary.step !== 'reconcile' && latestSummary.step !== 'prepare_close') ||
    latestSummary.ledger_balanced !== true
  ) {
    throw new Error(
      'WORKFLOW_SEQUENCE_ERROR: Step "reconcile" with balanced ledger must be completed before "prepare_close".',
    );
  }

  const missingJournals = (latestSummary.missing_journal_transactions as unknown[]) ?? [];
  if (missingJournals.length > 0) {
    throw new Error(
      `UNJOURNALED_TRANSACTIONS_DETECTED: Month-end close cannot proceed because ${missingJournals.length} transaction(s) lack balanced ledger entries. Reconcile transactions to ensure complete ledger coverage.`,
    );
  }

  const amountMismatches = (latestSummary.amount_mismatch_transactions as unknown[]) ?? [];
  if (amountMismatches.length > 0) {
    throw new Error(
      `JOURNAL_AMOUNT_MISMATCH_DETECTED: Month-end close cannot proceed because ${amountMismatches.length} transaction(s) have journal amounts that do not match transaction totals. Reconcile transactions to ensure correct ledger amounts.`,
    );
  }

  // Refresh month expenses to verify uncategorized items
  const currentMonthExpenses = await db
    .select({ id: expenses.id, categoryId: expenses.categoryId })
    .from(expenses)
    .where(
      and(
        eq(expenses.businessId, businessId),
        gte(expenses.expenseDate, startDate),
        lt(expenses.expenseDate, endDate),
      ),
    );

  const remainingUncategorized = currentMonthExpenses.filter((e) => !e.categoryId);
  const allowGeneralExpense =
    args.payload?.allow_general_expense === true ||
    latestSummary?.['allow_general_expense'] === true;

  if (remainingUncategorized.length > 0 && !allowGeneralExpense) {
    throw new Error(
      `UNCATEGORIZED_EXPENSES_REMAINING: Cannot prepare month close with ${remainingUncategorized.length} uncategorized expenses without explicit approval ({ allow_general_expense: true }).`,
    );
  }

  const summaryJson = {
    month,
    year,
    billed_revenue_paise: Number(totalBilledRevenuePaise),
    total_expenses_paise: Number(totalExpensesPaise),
    net_operating_profit_paise: Number(netOperatingProfitPaise),
    collections_paise: Number(totalCollectionsPaise),
    gst_output_paise: Number(totalOutputCgstPaise + totalOutputSgstPaise + totalOutputIgstPaise),
    gst_input_itc_paise: Number(totalInputCgstPaise + totalInputSgstPaise + totalInputIgstPaise),
    net_gst_payable_paise: Number(setOff.netPayable.totalCashPayablePaise),
    remaining_itc_paise: Number(setOff.closingItcBalance.totalBalancePaise),
    uncategorized_expenses_count: remainingUncategorized.length,
    unresolved_treatment:
      remainingUncategorized.length > 0 ? 'general_operational_expense' : 'none',
    allow_general_expense: allowGeneralExpense,
  };

  const narrationMarkdown = `## Month-End Close Report: ${month}/${year}
- **Billed Revenue**: ${formatInr(totalBilledRevenuePaise)}
- **Operating Expenses**: ${formatInr(totalExpensesPaise)}
- **Net Operating Profit**: ${formatInr(netOperatingProfitPaise)}
- **Cash Collections**: ${formatInr(totalCollectionsPaise)}
- **Estimated Net GST Payable**: ${formatInr(setOff.netPayable.totalCashPayablePaise)}
- **Remaining Input Tax Credit**: ${formatInr(setOff.closingItcBalance.totalBalancePaise)}${
    remainingUncategorized.length > 0
      ? `\n- **Uncategorized Expenses**: ${remainingUncategorized.length} item(s) approved as General Operational Expense`
      : ''
  }`;

  const payload = {
    action: 'close_month',
    business_id: businessId,
    month,
    year,
    summary_json: summaryJson,
    narration_markdown: narrationMarkdown,
  };

  const token = generateConfirmationToken(payload);
  const humanSummary = `Confirm Month-End Close for ${month}/${year}: Lock books with Net Profit ${formatInr(
    netOperatingProfitPaise,
  )} and GST Liability ${formatInr(setOff.netPayable.totalCashPayablePaise)}.${
    remainingUncategorized.length > 0
      ? ` Includes ${remainingUncategorized.length} approved general operational expense(s).`
      : ''
  } Valid for 15 minutes.`;

  const [pendingRecord] = await db
    .insert(pendingConfirmations)
    .values({
      businessId,
      userId: tenant.userId,
      tokenHash: token.tokenHash,
      actionType: 'close_month',
      payload,
      payloadHash: token.payloadHash,
      humanSummary,
      expiresAt: token.expiresAt,
    })
    .returning();

  await persistWorkflowState('prepare_close', {
    ...summaryJson,
    draft_id: pendingRecord?.id,
    confirmation_token_hash: token.tokenHash,
    ledger_balanced: true,
    expires_at: token.expiresAt.toISOString(),
    status: 'pending_confirmation',
  });

  return {
    _meta: {
      'ui/resourceUri': `ui://cards/month-end-summary/${month}/${year}`,
      confirmation_token: token.tokenSecret,
    },
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            draft_id: pendingRecord?.id,
            step: 'prepare_close',
            workflow_state: 'awaiting_confirmation',
            month,
            year,
            draft_report: summaryJson,
            narration: narrationMarkdown,
            confirmation_token: token.tokenSecret,
            preview_summary: humanSummary,
            ui_resource_uri: `ui://cards/month-end-summary/${month}/${year}`,
            expires_at: token.expiresAt.toISOString(),
            status: 'pending_confirmation',
          },
          null,
          2,
        ),
      },
    ],
  };
}
