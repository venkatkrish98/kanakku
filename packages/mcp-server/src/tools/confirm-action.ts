import { z } from 'zod';
import { eq, and, inArray, gte, lt, sql } from 'drizzle-orm';
import { getTenantContext } from '../auth/index.js';
import type { KanakkuDatabase } from '@kanakku/db';
import {
  pendingConfirmations,
  idempotencyRecords,
  expenses,
  expenseCategories,
  invoices,
  invoiceItems,
  payments,
  paymentReminders,
  monthEndReports,
  journalEntries,
  journalLines,
  businessMemory,
} from '@kanakku/db';
import {
  hashToken,
  validateConfirmationEligibility,
  checkIdempotency,
  formatInr,
  getBusinessDateParts,
  getMonthDateRangeIst,
  computeGstSetOff,
} from '@kanakku/core';
import {
  appendAuditLog,
  createAuditAnchorOutboxItem,
  processAuditAnchorOutboxItem,
} from '../audit/index.js';
import {
  getNextJournalEntryNumber,
  getNextInvoiceNumber,
  requireGlAccountByCode,
  verifyPeriodLedgerCoverage,
} from './ledger-helper.js';
import { saveActiveWorkflowState } from './session-helper.js';

export const confirmActionSchema = {
  confirmation_token: z
    .string()
    .min(32)
    .describe('The 32-character hexadecimal confirmation token issued during draft preparation'),
  idempotency_key: z
    .string()
    .optional()
    .describe('Optional client-generated idempotency key for safe retries'),
};

/**
 * Acquires a PostgreSQL transaction-scoped advisory lock for a specific (businessId, year, month).
 * Serializes all ledger postings (expenses, invoices) and month-close operations for that period.
 * Automatically released when the surrounding transaction commits or rolls back.
 */
export async function acquirePeriodLock(
  dbOrTx: KanakkuDatabase | Parameters<Parameters<KanakkuDatabase['transaction']>[0]>[0],
  businessId: string,
  year: number,
  month: number,
): Promise<void> {
  const lockKey = year * 100 + month; // e.g. 202607 fits cleanly in signed 32-bit integer
  await dbOrTx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${businessId}), ${lockKey})`,
  );
}

/**
 * Asserts that the period (calendar month in IST) containing transactionDate is NOT closed.
 * Prevents postings into a closed period with locked books.
 */
export async function assertPeriodOpen(
  dbOrTx: KanakkuDatabase | Parameters<Parameters<KanakkuDatabase['transaction']>[0]>[0],
  businessId: string,
  transactionDate: Date,
  actionLabel = 'transaction',
): Promise<void> {
  const { year, month } = getBusinessDateParts(transactionDate);
  const calendarMonth = month + 1; // 1-indexed month

  const closed = await dbOrTx
    .select({ id: monthEndReports.id })
    .from(monthEndReports)
    .where(
      and(
        eq(monthEndReports.businessId, businessId),
        eq(monthEndReports.year, year),
        eq(monthEndReports.month, calendarMonth),
        eq(monthEndReports.isClosed, true),
      ),
    )
    .limit(1);

  if (closed.length > 0) {
    throw new Error(
      `PERIOD_CLOSED: Cannot post ${actionLabel} for date ${transactionDate.toISOString().slice(0, 10)}. Month ${calendarMonth}/${year} is already closed and books are locked.`,
    );
  }
}

export async function handleConfirmAction(
  args: z.infer<z.ZodObject<typeof confirmActionSchema>>,
  db: KanakkuDatabase,
) {
  const tenant = getTenantContext();
  const businessId = tenant.businessId;
  const callerUserId = tenant.userId;
  const callerRole = tenant.userRole;
  const tokenHash = hashToken(args.confirmation_token);

  // Execute confirmation inside an atomic transaction
  const txResult = await db.transaction(async (tx) => {
    // 1. Fetch pending confirmation record with row-level lock
    const foundRecords = await tx
      .select()
      .from(pendingConfirmations)
      .where(eq(pendingConfirmations.tokenHash, tokenHash))
      .for('update');

    const pending = foundRecords[0];
    if (!pending) {
      throw new Error('INVALID_CONFIRMATION_TOKEN: No pending action matches this confirmation token');
    }

    // 2. Atomic Idempotency Claim Pattern
    // Ensures only one concurrent request can claim the key and execute
    if (args.idempotency_key) {
      const insertedClaim = await tx
        .insert(idempotencyRecords)
        .values({
          businessId,
          idempotencyKey: args.idempotency_key,
          actionType: pending.actionType,
          payloadHash: pending.payloadHash,
          status: 'pending',
          lockedUntil: new Date(Date.now() + 60 * 1000), // 1-minute lock
        })
        .onConflictDoNothing()
        .returning();

      if (insertedClaim.length === 0) {
        // Another concurrent or prior request already created this (businessId, idempotencyKey).
        // Row-level lock the existing row to inspect its state
        const existingRows = await tx
          .select()
          .from(idempotencyRecords)
          .where(
            and(
              eq(idempotencyRecords.businessId, businessId),
              eq(idempotencyRecords.idempotencyKey, args.idempotency_key),
            ),
          )
          .for('update');

        const existing = existingRows[0];
        if (!existing) {
          throw new Error('IDEMPOTENCY_CONFLICT: Failed to claim idempotency key');
        }

        const check = checkIdempotency({
          existingRecord: {
            idempotencyKey: existing.idempotencyKey,
            businessId: existing.businessId,
            actionType: existing.actionType,
            payloadHash: existing.payloadHash,
            status: existing.status as 'pending' | 'completed' | 'failed',
            responsePayload: existing.responsePayload,
            lockedUntil: existing.lockedUntil,
          },
          callerBusinessId: businessId,
          actionType: pending.actionType,
          payloadHash: pending.payloadHash,
        });

        if (check.state === 'REPLAY_CACHED') {
          return {
            replay: true as const,
            responsePayload: check.responsePayload,
            isCloseMonth: false,
          };
        }
      }
    }

    // 3. Validate eligibility (tenant boundary, expiry, single-use, authorization)
    validateConfirmationEligibility({
      record: {
        id: pending.id,
        businessId: pending.businessId,
        userId: pending.userId,
        tokenHash: pending.tokenHash,
        actionType: pending.actionType,
        payload: pending.payload,
        payloadHash: pending.payloadHash,
        expiresAt: pending.expiresAt,
        consumedAt: pending.consumedAt,
      },
      callerBusinessId: businessId,
      callerUserId,
      callerRole,
    });

    // 4. Dispatch Action Execution
    let executedEntityId: string = pending.id;
    let executionSummary = '';
    const payload = pending.payload as Record<string, unknown>;

    if (pending.actionType === 'record_expense') {
      const expenseAmountPaise = BigInt(String(payload['amount_paise']));
      const taxableAmountPaise = BigInt(String(payload['taxable_amount_paise'] ?? payload['amount_paise']));
      const cgstPaise = BigInt(String(payload['cgst_paise'] ?? 0));
      const sgstPaise = BigInt(String(payload['sgst_paise'] ?? 0));
      const igstPaise = BigInt(String(payload['igst_paise'] ?? 0));
      const isItcClaimed = Boolean(payload['is_itc_claimed']);
      const expenseDate = new Date(String(payload['expense_date']));
      const { year: expYear, month: expMonth0 } = getBusinessDateParts(expenseDate);
      const expMonth = expMonth0 + 1;

      // Period serialization lock: serialize concurrent postings and month-close operations
      await acquirePeriodLock(tx, businessId, expYear, expMonth);

      // Period lock check: reject postings to closed periods
      await assertPeriodOpen(tx, businessId, expenseDate, 'expense');

      // Re-verify statutory ITC eligibility authoritative policy
      if (isItcClaimed && payload['category_id']) {
        const [cat] = await tx
          .select({ isItcEligible: expenseCategories.isItcEligible, name: expenseCategories.name })
          .from(expenseCategories)
          .where(
            and(
              eq(expenseCategories.id, String(payload['category_id'])),
              eq(expenseCategories.businessId, businessId),
            ),
          )
          .limit(1);

        if (cat && !cat.isItcEligible) {
          throw new Error(
            `ITC_NOT_ELIGIBLE: Input Tax Credit cannot be claimed for category "${cat.name}" because it is statutory blocked under Section 17(5) of the CGST Act.`,
          );
        }
      }

      // Insert Expense record
      const [insertedExpense] = await tx
        .insert(expenses)
        .values({
          businessId,
          categoryId: (payload['category_id'] as string) ?? null,
          amountPaise: expenseAmountPaise,
          taxableAmountPaise,
          cgstPaise,
          sgstPaise,
          igstPaise,
          roundOffPaise: 0n,
          gstRateBps: (payload['gst_rate_bps'] as number) ?? 0,
          isItcClaimed,
          paymentMethod: payload['payment_method'] as 'cash' | 'bank_transfer' | 'upi' | 'card' | 'other',
          expenseDate,
          vendorName: (payload['vendor_name'] as string) ?? null,
          vendorGstin: (payload['vendor_gstin'] as string) ?? null,
          description: String(payload['description'] ?? 'Expense'),
          status: 'posted',
        })
        .returning();

      if (!insertedExpense) {
        throw new Error('EXPENSE_INSERTION_FAILED');
      }
      executedEntityId = insertedExpense.id;

      // Double-Entry Ledger Posting
      const bankAccount = await requireGlAccountByCode(
        tx,
        businessId,
        '1110',
        'HDFC Current Account',
        'asset',
      );
      const expenseAccountId =
        typeof payload['gl_account_id'] === 'string'
          ? (payload['gl_account_id'] as string)
          : (
              await requireGlAccountByCode(
                tx,
                businessId,
                '5100',
                'Office Supplies Expense',
                'expense',
              )
            ).id;

      const entryNumber = await getNextJournalEntryNumber(tx, businessId, expenseDate);
      const [journalEntry] = await tx
        .insert(journalEntries)
        .values({
          businessId,
          entryNumber,
          entryDate: expenseDate,
          sourceEntityType: 'expense',
          sourceEntityId: insertedExpense.id,
          narration: `Expense: ${payload['description']} (${payload['payment_method']})`,
        })
        .returning();

      if (journalEntry) {
        if (isItcClaimed) {
          // ITC Eligible: Debit Expense Account with net taxable amount
          await tx.insert(journalLines).values({
            businessId,
            journalEntryId: journalEntry.id,
            accountId: expenseAccountId,
            debitPaise: taxableAmountPaise,
            creditPaise: 0n,
          });

          // Debit Input Tax Credit accounts
          if (cgstPaise > 0n) {
            const inputCgst = await requireGlAccountByCode(
              tx,
              businessId,
              '1210',
              'Input CGST Credit',
              'asset',
            );
            await tx.insert(journalLines).values({
              businessId,
              journalEntryId: journalEntry.id,
              accountId: inputCgst.id,
              debitPaise: cgstPaise,
              creditPaise: 0n,
            });
          }
          if (sgstPaise > 0n) {
            const inputSgst = await requireGlAccountByCode(
              tx,
              businessId,
              '1220',
              'Input SGST Credit',
              'asset',
            );
            await tx.insert(journalLines).values({
              businessId,
              journalEntryId: journalEntry.id,
              accountId: inputSgst.id,
              debitPaise: sgstPaise,
              creditPaise: 0n,
            });
          }
          if (igstPaise > 0n) {
            const inputIgst = await requireGlAccountByCode(
              tx,
              businessId,
              '1230',
              'Input IGST Credit',
              'asset',
            );
            await tx.insert(journalLines).values({
              businessId,
              journalEntryId: journalEntry.id,
              accountId: inputIgst.id,
              debitPaise: igstPaise,
              creditPaise: 0n,
            });
          }
        } else {
          // Blocked or Unclaimed ITC (Section 17(5) of CGST Act / AS 2 / Ind AS 16):
          // Ineligible input taxes are capitalized directly into expense cost.
          // Debit Expense Account for full gross amount, NO debits to input GST asset accounts.
          await tx.insert(journalLines).values({
            businessId,
            journalEntryId: journalEntry.id,
            accountId: expenseAccountId,
            debitPaise: expenseAmountPaise,
            creditPaise: 0n,
          });
        }

        // Credit Bank Account (Total Amount)
        await tx.insert(journalLines).values({
          businessId,
          journalEntryId: journalEntry.id,
          accountId: bankAccount.id,
          debitPaise: 0n,
          creditPaise: expenseAmountPaise,
        });
      }

      executionSummary = `Expense of ${formatInr(expenseAmountPaise)} for "${
        payload['description']
      }" posted to ledger under journal ${entryNumber}.`;
    } else if (pending.actionType === 'create_invoice') {
      const issueDate = new Date(String(payload['issue_date']));
      const dueDate = new Date(String(payload['due_date']));
      const { year: invYear, month: invMonth0 } = getBusinessDateParts(issueDate);
      const invMonth = invMonth0 + 1;

      // Period serialization lock: serialize concurrent postings and month-close operations
      await acquirePeriodLock(tx, businessId, invYear, invMonth);

      // Period lock check: reject postings to closed periods
      await assertPeriodOpen(tx, businessId, issueDate, 'invoice');

      const financialYear = String(payload['financial_year']);
      const invoiceNumber = await getNextInvoiceNumber(tx, businessId, financialYear);
      const subtotalPaise = BigInt(String(payload['subtotal_paise']));
      const totalPaise = BigInt(String(payload['total_paise']));
      const cgstPaise = BigInt(String(payload['cgst_paise']));
      const sgstPaise = BigInt(String(payload['sgst_paise']));
      const igstPaise = BigInt(String(payload['igst_paise']));

      // Insert Invoice record
      const [insertedInvoice] = await tx
        .insert(invoices)
        .values({
          businessId,
          customerId: String(payload['customer_id']),
          invoiceNumber,
          financialYear,
          issueDate,
          dueDate,
          placeOfSupplyStateCode: String(payload['place_of_supply_state_code']),
          isInterState: Boolean(payload['is_inter_state']),
          subtotalPaise,
          cgstPaise,
          sgstPaise,
          igstPaise,
          totalPaise,
          paidAmountPaise: 0n,
          roundOffPaise: 0n,
          status: 'issued',
        })
        .returning();

      if (!insertedInvoice) {
        throw new Error('INVOICE_INSERTION_FAILED');
      }
      executedEntityId = insertedInvoice.id;

      // Insert Line Items with tenant-scoping
      interface InvoiceLinePayload {
        description: string;
        hsn_sac_code?: string;
        quantity: number | string;
        unit_price_paise: number | string;
        taxable_amount_paise: number | string;
        gst_rate_bps: number;
        cgst_paise: number | string;
        sgst_paise: number | string;
        igst_paise: number | string;
        total_paise: number | string;
      }
      const lineItems = (payload['line_items'] as Array<InvoiceLinePayload>) ?? [];
      for (const item of lineItems) {
        await tx.insert(invoiceItems).values({
          businessId,
          invoiceId: insertedInvoice.id,
          description: item.description,
          hsnSacCode: item.hsn_sac_code ?? null,
          quantity: BigInt(item.quantity),
          unitPricePaise: BigInt(item.unit_price_paise),
          taxableAmountPaise: BigInt(item.taxable_amount_paise),
          gstRateBps: item.gst_rate_bps,
          cgstPaise: BigInt(item.cgst_paise),
          sgstPaise: BigInt(item.sgst_paise),
          igstPaise: BigInt(item.igst_paise),
          totalPaise: BigInt(item.total_paise),
        });
      }

      // Double-Entry Ledger Posting
      const arAccount = await requireGlAccountByCode(
        tx,
        businessId,
        '1120',
        'Accounts Receivable',
        'asset',
      );
      const salesAccount = await requireGlAccountByCode(
        tx,
        businessId,
        '4100',
        'Design & Consulting Revenue',
        'revenue',
      );

      const entryNumber = await getNextJournalEntryNumber(tx, businessId, issueDate);
      const [journalEntry] = await tx
        .insert(journalEntries)
        .values({
          businessId,
          entryNumber,
          entryDate: issueDate,
          sourceEntityType: 'invoice',
          sourceEntityId: insertedInvoice.id,
          narration: `Invoice issued: ${invoiceNumber} to ${payload['customer_name']}`,
        })
        .returning();

      if (journalEntry) {
        // Line 1: Debit Accounts Receivable (Total)
        await tx.insert(journalLines).values({
          businessId,
          journalEntryId: journalEntry.id,
          accountId: arAccount.id,
          debitPaise: totalPaise,
          creditPaise: 0n,
        });

        // Line 2: Credit Sales Revenue (Subtotal)
        await tx.insert(journalLines).values({
          businessId,
          journalEntryId: journalEntry.id,
          accountId: salesAccount.id,
          debitPaise: 0n,
          creditPaise: subtotalPaise,
        });

        // Lines 3-5: Credit Output Tax Liabilities
        if (cgstPaise > 0n) {
          const outputCgst = await requireGlAccountByCode(
            tx,
            businessId,
            '2110',
            'Output CGST Liability',
            'liability',
          );
          await tx.insert(journalLines).values({
            businessId,
            journalEntryId: journalEntry.id,
            accountId: outputCgst.id,
            debitPaise: 0n,
            creditPaise: cgstPaise,
          });
        }
        if (sgstPaise > 0n) {
          const outputSgst = await requireGlAccountByCode(
            tx,
            businessId,
            '2120',
            'Output SGST Liability',
            'liability',
          );
          await tx.insert(journalLines).values({
            businessId,
            journalEntryId: journalEntry.id,
            accountId: outputSgst.id,
            debitPaise: 0n,
            creditPaise: sgstPaise,
          });
        }
        if (igstPaise > 0n) {
          const outputIgst = await requireGlAccountByCode(
            tx,
            businessId,
            '2130',
            'Output IGST Liability',
            'liability',
          );
          await tx.insert(journalLines).values({
            businessId,
            journalEntryId: journalEntry.id,
            accountId: outputIgst.id,
            debitPaise: 0n,
            creditPaise: igstPaise,
          });
        }
      }

      executionSummary = `Invoice ${invoiceNumber} for ${formatInr(totalPaise)} issued to ${
        payload['customer_name']
      } and posted to ledger under journal ${entryNumber}.`;
    } else if (pending.actionType === 'send_payment_reminder') {
      const [reminder] = await tx
        .insert(paymentReminders)
        .values({
          businessId,
          customerId: String(payload['customer_id']),
          invoiceId: String(payload['invoice_id']),
          channel: payload['channel'] as 'whatsapp' | 'email' | 'sms',
          tone: payload['tone'] as 'polite' | 'firm' | 'urgent',
          recipientContact: String(payload['recipient_contact']),
          messageBody: String(payload['message_body']),
          status: 'sent_demo',
          sentAt: new Date(),
        })
        .returning();

      executedEntityId = reminder?.id ?? pending.id;
      executionSummary = `Payment reminder sent to ${payload['recipient_name']} (${payload['recipient_contact']}) via ${payload['channel']}.`;

      // Upsert customer tone/channel preference into cross-session business memory
      const entityKey = `customer:${payload['customer_id']}`;
      const memoryValue = {
        preferred_tone: payload['tone'],
        preferred_channel: payload['channel'],
        last_contact: payload['recipient_contact'],
        updated_at: new Date().toISOString(),
      };

      const existingMemory = await tx
        .select({ id: businessMemory.id })
        .from(businessMemory)
        .where(
          and(
            eq(businessMemory.businessId, businessId),
            eq(businessMemory.category, 'customer_preference'),
            eq(businessMemory.entityKey, entityKey),
          ),
        )
        .limit(1);

      if (existingMemory[0]) {
        await tx
          .update(businessMemory)
          .set({
            memoryValue,
            isActive: true,
            source: 'confirmed_action',
            updatedAt: new Date(),
          })
          .where(eq(businessMemory.id, existingMemory[0].id));
      } else {
        await tx.insert(businessMemory).values({
          businessId,
          category: 'customer_preference',
          entityKey,
          memoryValue,
          confidence: '0.95',
          source: 'confirmed_action',
          isActive: true,
        });
      }
    } else if (pending.actionType === 'close_month') {
      const month = Number(payload['month']);
      const year = Number(payload['year']);

      // Period serialization lock: serialize close confirmation and all concurrent postings
      await acquirePeriodLock(tx, businessId, year, month);

      // 1. Revalidate that the period is not already closed
      const existingClosed = await tx
        .select()
        .from(monthEndReports)
        .where(
          and(
            eq(monthEndReports.businessId, businessId),
            eq(monthEndReports.month, month),
            eq(monthEndReports.year, year),
            eq(monthEndReports.isClosed, true),
          ),
        )
        .limit(1);

      if (existingClosed.length > 0) {
        throw new Error(
          `PERIOD_ALREADY_CLOSED: Month ${month}/${year} is already closed and books are locked.`,
        );
      }

      // 2. Re-verify reconciliation / ledger balance in IST date range
      const { startDate, endDate } = getMonthDateRangeIst(month, year);
      const entries = await tx
        .select({ id: journalEntries.id, entryNumber: journalEntries.entryNumber })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.businessId, businessId),
            gte(journalEntries.entryDate, startDate),
            lt(journalEntries.entryDate, endDate),
          ),
        );

      let totalDebits = 0n;
      let totalCredits = 0n;
      const unbalancedEntryNumbers: string[] = [];

      if (entries.length > 0) {
        const entryIds = entries.map((e) => e.id);
        const lines = await tx
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

        const entryBalanceMap = new Map<string, { debits: bigint; credits: bigint }>();
        for (const entry of entries) {
          entryBalanceMap.set(entry.id, { debits: 0n, credits: 0n });
        }

        for (const line of lines) {
          totalDebits += line.debitPaise;
          totalCredits += line.creditPaise;
          const entryBal = entryBalanceMap.get(line.journalEntryId);
          if (entryBal) {
            entryBal.debits += line.debitPaise;
            entryBal.credits += line.creditPaise;
          }
        }

        // Check balance per individual journal entry to prevent masking
        for (const entry of entries) {
          const bal = entryBalanceMap.get(entry.id);
          if (!bal || bal.debits !== bal.credits) {
            unbalancedEntryNumbers.push(entry.entryNumber);
          }
        }
      }

      if (totalDebits !== totalCredits || unbalancedEntryNumbers.length > 0) {
        if (unbalancedEntryNumbers.length > 0) {
          throw new Error(
            `RECONCILIATION_FAILED: Individual journal entry [${unbalancedEntryNumbers.join(', ')}] is unbalanced (debits != credits). Every double-entry journal must balance individually.`,
          );
        }
        throw new Error(
          `RECONCILIATION_FAILED: Total debits (${totalDebits}) do not equal total credits (${totalCredits}) for ${month}/${year}. Cannot lock unbalanced books.`,
        );
      }

      // 3. Recompute live period totals under period lock and verify against prepared snapshot to prevent stale close reports
      const monthInvoices = await tx
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

      const liveBilledInvoices = monthInvoices.filter((i) => i.status !== 'cancelled');
      let liveBilledRevenuePaise = 0n;
      let liveOutputCgstPaise = 0n;
      let liveOutputSgstPaise = 0n;
      let liveOutputIgstPaise = 0n;
      for (const inv of liveBilledInvoices) {
        liveBilledRevenuePaise += inv.subtotalPaise;
        liveOutputCgstPaise += inv.cgstPaise;
        liveOutputSgstPaise += inv.sgstPaise;
        liveOutputIgstPaise += inv.igstPaise;
      }

      const monthExpenses = await tx
        .select({
          id: expenses.id,
          categoryId: expenses.categoryId,
          amountPaise: expenses.amountPaise,
          taxableAmountPaise: expenses.taxableAmountPaise,
          cgstPaise: expenses.cgstPaise,
          sgstPaise: expenses.sgstPaise,
          igstPaise: expenses.igstPaise,
          isItcClaimed: expenses.isItcClaimed,
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

      let liveExpensesPaise = 0n;
      let liveInputCgstPaise = 0n;
      let liveInputSgstPaise = 0n;
      let liveInputIgstPaise = 0n;
      let liveUncategorizedCount = 0;
      for (const exp of monthExpenses) {
        if (exp.status !== 'cancelled') {
          liveExpensesPaise += exp.amountPaise;
          if (exp.isItcClaimed) {
            liveInputCgstPaise += exp.cgstPaise;
            liveInputSgstPaise += exp.sgstPaise;
            liveInputIgstPaise += exp.igstPaise;
          }
          if (!exp.categoryId) {
            liveUncategorizedCount++;
          }
        }
      }

      const monthPayments = await tx
        .select({ id: payments.id, amountPaise: payments.amountPaise })
        .from(payments)
        .where(
          and(
            eq(payments.businessId, businessId),
            gte(payments.paymentDate, startDate),
            lt(payments.paymentDate, endDate),
          ),
        );

      let liveCollectionsPaise = 0n;
      for (const p of monthPayments) {
        liveCollectionsPaise += p.amountPaise;
      }

      const liveOutputGst = liveOutputCgstPaise + liveOutputSgstPaise + liveOutputIgstPaise;
      const liveInputGst = liveInputCgstPaise + liveInputSgstPaise + liveInputIgstPaise;

      const liveSetOff = computeGstSetOff({
        outputTax: {
          cgstPaise: liveOutputCgstPaise,
          sgstPaise: liveOutputSgstPaise,
          igstPaise: liveOutputIgstPaise,
        },
        availableItc: {
          cgstPaise: liveInputCgstPaise,
          sgstPaise: liveInputSgstPaise,
          igstPaise: liveInputIgstPaise,
        },
      });

      const preparedSummary = payload['summary_json'] as Record<string, unknown> | undefined;
      if (preparedSummary) {
        const prepRevenue = BigInt(String(preparedSummary['billed_revenue_paise'] ?? 0));
        const prepExpenses = BigInt(String(preparedSummary['total_expenses_paise'] ?? 0));
        const prepCollections = BigInt(String(preparedSummary['collections_paise'] ?? 0));
        const prepOutputGst = BigInt(String(preparedSummary['gst_output_paise'] ?? 0));
        const prepInputItc = BigInt(String(preparedSummary['gst_input_itc_paise'] ?? 0));

        if (
          prepRevenue !== liveBilledRevenuePaise ||
          prepExpenses !== liveExpensesPaise ||
          prepCollections !== liveCollectionsPaise ||
          prepOutputGst !== liveOutputGst ||
          prepInputItc !== liveInputGst
        ) {
          throw new Error(
            `STALE_CLOSE_SNAPSHOT: Postings changed between close preparation and confirmation for ${month}/${year}. Prepared billed revenue was ${formatInr(
              prepRevenue,
            )} but current is ${formatInr(liveBilledRevenuePaise)}; prepared expenses were ${formatInr(
              prepExpenses,
            )} but current is ${formatInr(
              liveExpensesPaise,
            )}. Re-run prepare_close before confirming to reflect the updated transactions.`,
          );
        }

        const prepUncategorized =
          typeof preparedSummary['uncategorized_expenses_count'] === 'number'
            ? (preparedSummary['uncategorized_expenses_count'] as number)
            : null;

        if (prepUncategorized !== null && prepUncategorized !== liveUncategorizedCount) {
          throw new Error(
            `STALE_CLOSE_SNAPSHOT: Expense categorisation changed between close preparation and confirmation for ${month}/${year}. Prepared uncategorized count was ${prepUncategorized} but current count is ${liveUncategorizedCount}. Re-run prepare_close before confirming to reflect the updated categorisation.`,
          );
        }
      }

      // Verify complete double-entry ledger coverage under the period lock
      const ledgerCoverage = await verifyPeriodLedgerCoverage(
        tx,
        businessId,
        startDate,
        endDate,
        monthInvoices,
        monthExpenses,
        monthPayments,
      );

      if (!ledgerCoverage.isBalanced) {
        if (ledgerCoverage.missingJournalTransactions.length > 0) {
          const firstMissing = ledgerCoverage.missingJournalTransactions[0]!;
          throw new Error(
            `UNJOURNALED_TRANSACTIONS_DETECTED: Month-end close cannot proceed because ${firstMissing.type} ${firstMissing.reference} lacks a valid, balanced, period-dated ledger entry.`,
          );
        }
        if (ledgerCoverage.duplicateJournalTransactions.length > 0) {
          const firstDup = ledgerCoverage.duplicateJournalTransactions[0]!;
          throw new Error(
            `DUPLICATE_JOURNAL_ENTRIES_DETECTED: Month-end close cannot proceed because ${firstDup.type} ${firstDup.reference} has ${firstDup.count} duplicate ledger entries in the period.`,
          );
        }
        if (ledgerCoverage.amountMismatchTransactions.length > 0) {
          const firstMismatch = ledgerCoverage.amountMismatchTransactions[0]!;
          throw new Error(
            `JOURNAL_AMOUNT_MISMATCH_DETECTED: Month-end close cannot proceed because journal entry ${firstMismatch.entryNumber} amount (${formatInr(BigInt(firstMismatch.actualAmountPaiseExact))}) does not match transaction ${firstMismatch.type} ${firstMismatch.reference} (${formatInr(BigInt(firstMismatch.expectedAmountPaiseExact))}).`,
          );
        }
        if (ledgerCoverage.unbalancedEntryNumbers.length > 0) {
          throw new Error(
            `UNBALANCED_JOURNAL_ENTRIES_DETECTED: Month-end close cannot proceed because journal entries [${ledgerCoverage.unbalancedEntryNumbers.join(', ')}] have invalid or unbalanced lines.`,
          );
        }
        throw new Error(
          `LEDGER_IMBALANCE_DETECTED: Month-end close cannot proceed because total debits (${formatInr(ledgerCoverage.totalDebitsPaise)}) do not match total credits (${formatInr(ledgerCoverage.totalCreditsPaise)}).`,
        );
      }

      const allowGeneralExpense = preparedSummary?.['allow_general_expense'] === true;
      const verifiedSummaryJson = {
        month,
        year,
        billed_revenue_paise: Number(liveBilledRevenuePaise),
        total_expenses_paise: Number(liveExpensesPaise),
        net_operating_profit_paise: Number(liveBilledRevenuePaise - liveExpensesPaise),
        collections_paise: Number(liveCollectionsPaise),
        gst_output_paise: Number(liveOutputGst),
        gst_input_itc_paise: Number(liveInputGst),
        net_gst_payable_paise: Number(liveSetOff.netPayable.totalCashPayablePaise),
        remaining_itc_paise: Number(liveSetOff.closingItcBalance.totalBalancePaise),
        uncategorized_expenses_count: liveUncategorizedCount,
        unresolved_treatment:
          liveUncategorizedCount > 0
            ? allowGeneralExpense
              ? 'general_operational_expense'
              : 'pending_approval'
            : 'none',
        allow_general_expense: allowGeneralExpense,
      };

      // 4. Upsert month-end report
      const existingReport = await tx
        .select({ id: monthEndReports.id })
        .from(monthEndReports)
        .where(
          and(
            eq(monthEndReports.businessId, businessId),
            eq(monthEndReports.month, month),
            eq(monthEndReports.year, year),
          ),
        )
        .limit(1);

      let reportId: string;
      if (existingReport[0]) {
        const [updated] = await tx
          .update(monthEndReports)
          .set({
            isClosed: true,
            summaryJson: verifiedSummaryJson,
            narrationMarkdown: String(payload['narration_markdown']),
            closedAt: new Date(),
            closedByUserId: callerUserId,
          })
          .where(eq(monthEndReports.id, existingReport[0].id))
          .returning();
        reportId = updated?.id ?? existingReport[0].id;
      } else {
        const [inserted] = await tx
          .insert(monthEndReports)
          .values({
            businessId,
            month,
            year,
            isClosed: true,
            summaryJson: verifiedSummaryJson,
            narrationMarkdown: String(payload['narration_markdown']),
            closedAt: new Date(),
            closedByUserId: callerUserId,
          })
          .returning();
        reportId = inserted?.id ?? pending.id;
      }

      executedEntityId = reportId;
      executionSummary = `Month ${payload['month']}/${payload['year']} officially closed and books locked by ${tenant.user.name}.`;

      // Synchronize session workflow state: month is now closed
      await saveActiveWorkflowState(
        tx,
        businessId,
        null,
        {
          month,
          year,
          step: 'closed',
          status: 'closed',
          closed_at: new Date().toISOString(),
          closed_by_user_id: callerUserId,
        },
        tenant.sessionId,
      );
    } else {
      throw new Error(`UNKNOWN_ACTION_TYPE: Action type "${pending.actionType}" is not supported`);
    }

    // 5. Append Serialized Hash-Chained Audit Log
    const auditResult = await appendAuditLog(tx, {
      businessId,
      userId: callerUserId,
      source: 'mcp_client',
      toolName: 'confirm_action',
      action: `confirm:${pending.actionType}`,
      entityType: pending.actionType.replace('record_', '').replace('create_', ''),
      entityId: executedEntityId,
      confirmationTokenHash: pending.tokenHash,
      payload: pending.payload,
    });


    // 5.1 Create Transactional Outbox Item for External Audit Anchoring (ADR-005)
    // Written inside the same ACID database transaction as the month close.
    // If this transaction fails or rolls back, the outbox record also rolls back (zero phantom anchors).
    let outboxId: string | null = null;
    if (pending.actionType === 'close_month') {
      const outboxRecord = await createAuditAnchorOutboxItem(tx, {
        businessId,
        targetEntityType: 'month_end_report',
        targetEntityId: executedEntityId,
        auditSequenceNumber: auditResult.sequenceNumber,
        headHash: auditResult.entryHash,
        idempotencyKey: args.idempotency_key ?? null,
      });
      outboxId = outboxRecord.id;
    }

    // 6. Mark Confirmation Token Consumed
    await tx
      .update(pendingConfirmations)
      .set({ consumedAt: new Date() })
      .where(eq(pendingConfirmations.id, pending.id));

    // 7. Compose Initial Execution Result
    const responsePayload: Record<string, unknown> = {
      status: 'executed',
      action_type: pending.actionType,
      entity_id: executedEntityId,
      audit_id: auditResult.id,
      sequence_number: auditResult.sequenceNumber.toString(),
      entry_hash: auditResult.entryHash,
      audit_anchor: pending.actionType === 'close_month' ? { anchored: false, status: 'pending', outbox_id: outboxId } : null,
      human_summary: executionSummary,
      executed_at: new Date().toISOString(),
    };

    // 8. Record Idempotency Result if client key was provided
    if (args.idempotency_key) {
      await tx
        .update(idempotencyRecords)
        .set({
          status: 'completed',
          responsePayload,
        })
        .where(
          and(
            eq(idempotencyRecords.businessId, businessId),
            eq(idempotencyRecords.idempotencyKey, args.idempotency_key),
          ),
        );
    }

    return {
      replay: false as const,
      responsePayload,
      isCloseMonth: pending.actionType === 'close_month',
      outboxId,
    };
  });

  if (txResult.replay) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(txResult.responsePayload, null, 2),
        },
      ],
    };
  }

  // 9. Post-Commit External Audit Trail Anchoring Flow (Phase 7 / ADR-005)
  // Guarantees zero phantom anchors: CloudWatch is ONLY written AFTER the database transaction commits.
  // Processes the durable outbox item and synchronizes the stored idempotency cache.
  if (txResult.isCloseMonth && txResult.outboxId) {
    const processResult = await processAuditAnchorOutboxItem(txResult.outboxId, db);
    if (processResult.status === 'anchored' && processResult.receipt) {
      txResult.responsePayload['audit_anchor'] = {
        anchored: true,
        status: 'anchored',
        outbox_id: txResult.outboxId,
        sink: processResult.receipt.sinkIdentifier,
        head_hash: processResult.receipt.headHash,
        sequence: processResult.receipt.sequenceNumber,
        anchored_at: processResult.receipt.anchoredAt,
      };
    } else {
      // Recoverable pending state: the ledger is safely committed, but external anchor dispatch failed.
      // Retained in audit_anchor_outbox for worker retry.
      txResult.responsePayload['audit_anchor'] = {
        anchored: false,
        status: 'pending_retry',
        outbox_id: txResult.outboxId,
        error: processResult.error ?? 'External audit anchor dispatch pending retry',
      };
    }
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(txResult.responsePayload, null, 2),
      },
    ],
  };
}
