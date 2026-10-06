import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq, and, sql, inArray, gte } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { KanakkuDatabase } from '@kanakku/db';
import {
  customers,
  invoices,
  expenses,
  payments,
  chartOfAccounts,
  auditLogs,
  businessMemory,
  pendingConfirmations,
  monthEndReports,
} from '@kanakku/db';
import { formatInr } from '@kanakku/core';
import { getTenantContext } from '../auth/index.js';
import { verifyAuditChain } from '../audit/index.js';
import { computeMonthGst } from '../tools/gst-liability.js';
import {
  renderInvoiceCardHtml,
  renderExpenseCardHtml,
  renderGstCardHtml,
  renderMonthEndCardHtml,
  renderBriefingCardHtml,
} from './cards.js';
import { MCP_APP_MIME_TYPE } from '../apps/index.js';

export function registerResources(server: McpServer, db: KanakkuDatabase) {
  // 1. kanakku://business-summary
  server.resource(
    'business-summary',
    'kanakku://business-summary',
    async (uri) => {
      const tenant = getTenantContext();
      const businessId = tenant.businessId;

      // Active customer count
      const customerRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(customers)
        .where(eq(customers.businessId, businessId));
      const customerCount = customerRows[0]?.count ?? 0;

      // Total uncollected receivables
      const openInvoices = await db
        .select({
          totalPaise: invoices.totalPaise,
          paidAmountPaise: invoices.paidAmountPaise,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.businessId, businessId),
            inArray(invoices.status, ['issued', 'partially_paid']),
          ),
        );

      let totalOutstandingPaise = 0n;
      for (const inv of openInvoices) {
        totalOutstandingPaise += inv.totalPaise - inv.paidAmountPaise;
      }

      // Total YTD billed revenue
      const allInvoices = await db
        .select({ subtotalPaise: invoices.subtotalPaise })
        .from(invoices)
        .where(
          and(
            eq(invoices.businessId, businessId),
            sql`${invoices.status} != 'cancelled'`,
          ),
        );

      let totalRevenuePaise = 0n;
      for (const inv of allInvoices) {
        totalRevenuePaise += inv.subtotalPaise;
      }

      const summary = {
        business_id: tenant.business.id,
        name: tenant.business.name,
        legal_name: tenant.business.legalName,
        gstin: tenant.business.gstin,
        state_code: tenant.business.stateCode,
        currency: tenant.business.currency,
        financial_year_start_month: tenant.business.financialYearStartMonth,
        active_customers_count: customerCount,
        total_outstanding_receivables: formatInr(totalOutstandingPaise),
        total_ytd_billed_revenue: formatInr(totalRevenuePaise),
      };

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    },
  );

  // 2. kanakku://chart-of-accounts
  server.resource(
    'chart-of-accounts',
    'kanakku://chart-of-accounts',
    async (uri) => {
      const tenant = getTenantContext();
      const accounts = await db
        .select({
          code: chartOfAccounts.code,
          name: chartOfAccounts.name,
          type: chartOfAccounts.type,
        })
        .from(chartOfAccounts)
        .where(eq(chartOfAccounts.businessId, tenant.businessId))
        .orderBy(chartOfAccounts.code);

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify({ chart_of_accounts: accounts }, null, 2),
          },
        ],
      };
    },
  );

  // 3. kanakku://gst-rates
  server.resource(
    'gst-rates',
    'kanakku://gst-rates',
    async (uri) => {
      const gstSchedule = {
        standard_slabs: [
          { rate_bps: 0, percentage: '0%', description: 'Exempted goods and essential food items' },
          { rate_bps: 500, percentage: '5%', description: 'Household necessities and transport services' },
          { rate_bps: 1200, percentage: '12%', description: 'Standard consumer products and IT equipment' },
          { rate_bps: 1800, percentage: '18%', description: 'Most commercial and professional IT/design services' },
          { rate_bps: 2800, percentage: '28%', description: 'Luxury items and demerit goods' },
        ],
        rules: {
          intra_state: 'Equal 50-50 division between CGST and SGST',
          inter_state: '100% IGST applied',
          rounding_policy: 'Component-primary rounding convention (CGST and SGST rounded first, total sum of components)',
          statutory_reference: 'Central Goods and Services Tax Act, 2017 (Section 49)',
        },
      };

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(gstSchedule, null, 2),
          },
        ],
      };
    },
  );

  // 4. kanakku://audit-trail
  server.resource(
    'audit-trail',
    'kanakku://audit-trail',
    async (uri) => {
      const tenant = getTenantContext();
      const verification = await verifyAuditChain(tenant.businessId, db);

      const latestLog = await db
        .select({
          sequenceNumber: auditLogs.sequenceNumber,
          action: auditLogs.action,
          entryHash: auditLogs.entryHash,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(eq(auditLogs.businessId, tenant.businessId))
        .orderBy(sql`${auditLogs.sequenceNumber} DESC`)
        .limit(1);

      const auditTrailSummary = {
        chain_valid: verification.valid,
        total_entries: verification.totalEntries,
        head_sequence: verification.headSequence?.toString() ?? null,
        head_hash: verification.headHash,
        latest_action: latestLog[0]?.action ?? null,
        latest_timestamp: latestLog[0]?.createdAt.toISOString() ?? null,
        error: verification.error ?? null,
      };

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(auditTrailSummary, null, 2),
          },
        ],
      };
    },
  );

  // 5. kanakku://business-memory
  server.resource(
    'business-memory',
    'kanakku://business-memory',
    async (uri) => {
      const tenant = getTenantContext();
      const memories = await db
        .select({
          id: businessMemory.id,
          category: businessMemory.category,
          entityKey: businessMemory.entityKey,
          memoryValue: businessMemory.memoryValue,
          confidence: businessMemory.confidence,
          source: businessMemory.source,
          isActive: businessMemory.isActive,
          updatedAt: businessMemory.updatedAt,
        })
        .from(businessMemory)
        .where(
          and(
            eq(businessMemory.businessId, tenant.businessId),
            eq(businessMemory.isActive, true),
          ),
        );

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(memories, null, 2),
          },
        ],
      };
    },
  );

  // ==========================================
  // MCP APPS EXTENSION (ui:// resources & templates)
  // ==========================================

  // 6. UI Card Template: ui://cards/gst-liability
  // 6. UI Card: ui://cards/gst-liability
  server.resource(
    'ui-gst-liability-card',
    new ResourceTemplate('ui://cards/gst-liability', { list: undefined }),
    {
      description: 'Interactive HTML card displaying current GST liability, ITC set-off, and statutory deadline',
      mimeType: MCP_APP_MIME_TYPE,
    },
    async (uri) => {
      const tenant = getTenantContext();
      const now = new Date();
      const month = now.getUTCMonth() + 1;
      const year = now.getUTCFullYear();

      const currentLiability = await computeMonthGst(db, tenant.businessId, month, year);

      // Compute statutory filing deadline (20th of next month for GSTR-3B)
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;
      const dueDateFormatted = `20 ${new Date(Date.UTC(nextYear, nextMonth - 1, 20)).toLocaleString('en-IN', { month: 'short' })} ${nextYear}`;

      const cardHtml = renderGstCardHtml({
        businessName: tenant.business.name,
        gstin: tenant.business.gstin ?? 'Unregistered',
        month,
        year,
        outputGstFormatted: formatInr(currentLiability.outputTotalPaise),
        inputItcFormatted: formatInr(currentLiability.itcTotalPaise),
        netPayableFormatted: formatInr(currentLiability.netPayableTotalPaise),
        cgstPayableFormatted: formatInr(currentLiability.netPayableCgstPaise),
        sgstPayableFormatted: formatInr(currentLiability.netPayableSgstPaise),
        igstPayableFormatted: formatInr(currentLiability.netPayableIgstPaise),
        remainingItcFormatted: formatInr(currentLiability.remainingItcTotalPaise),
        dueDateFormatted,
        statutoryNotice:
          'Decision-support estimates under Section 49 of the CGST Act, 2017. Verify with a licensed CA before filing.',
      });

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: MCP_APP_MIME_TYPE,
            text: cardHtml,
          },
        ],
      };
    },
  );

  // 7. UI Card: ui://cards/business-briefing
  server.resource(
    'ui-business-briefing-card',
    new ResourceTemplate('ui://cards/business-briefing', { list: undefined }),
    {
      description: 'Executive financial briefing card with active receivables, cashflows, and recent audit status',
      mimeType: MCP_APP_MIME_TYPE,
    },
    async (uri) => {
      const tenant = getTenantContext();
      const businessId = tenant.businessId;

      // Receivables
      const openInvoices = await db
        .select({
          totalPaise: invoices.totalPaise,
          paidAmountPaise: invoices.paidAmountPaise,
          dueDate: invoices.dueDate,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.businessId, businessId),
            inArray(invoices.status, ['issued', 'partially_paid']),
          ),
        );

      let totalOutstandingPaise = 0n;
      let overduePaise = 0n;
      const today = new Date();
      for (const inv of openInvoices) {
        const bal = inv.totalPaise - inv.paidAmountPaise;
        totalOutstandingPaise += bal;
        if (new Date(inv.dueDate) < today) {
          overduePaise += bal;
        }
      }

      // Cash Inflows & Outflows in the last 30 days
      const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
      const recentPayments = await db
        .select({ amountPaise: payments.amountPaise })
        .from(payments)
        .where(
          and(
            eq(payments.businessId, businessId),
            gte(payments.paymentDate, thirtyDaysAgo),
          ),
        );
      let cashInflowsPaise = 0n;
      for (const p of recentPayments) {
        cashInflowsPaise += p.amountPaise;
      }

      const recentExpenses = await db
        .select({ amountPaise: expenses.amountPaise })
        .from(expenses)
        .where(
          and(
            eq(expenses.businessId, businessId),
            gte(expenses.expenseDate, thirtyDaysAgo),
          ),
        );
      let cashOutflowsPaise = 0n;
      for (const e of recentExpenses) {
        cashOutflowsPaise += e.amountPaise;
      }

      const auditVerification = await verifyAuditChain(businessId, db);

      const cardHtml = renderBriefingCardHtml({
        businessName: tenant.business.name,
        briefingText: `Operations are stable. Outstanding receivables stand at ${formatInr(totalOutstandingPaise)}, with ${formatInr(overduePaise)} overdue.`,
        activeReceivablesFormatted: formatInr(totalOutstandingPaise),
        overdueReceivablesFormatted: formatInr(overduePaise),
        cashInflowsFormatted: formatInr(cashInflowsPaise),
        cashOutflowsFormatted: formatInr(cashOutflowsPaise),
        netCashDeltaFormatted: formatInr(cashInflowsPaise - cashOutflowsPaise),
        gstDueFormatted: 'See GST Card',
        recentAuditStatus: auditVerification.valid
          ? `Verified (${auditVerification.totalEntries} entries)`
          : `Compromised (${auditVerification.error})`,
      });

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: MCP_APP_MIME_TYPE,
            text: cardHtml,
          },
        ],
      };
    },
  );

  function renderInvoicePendingCard(pending: typeof pendingConfirmations.$inferSelect, tokenSecret?: string) {
    const tenant = getTenantContext();
    const payload = pending.payload as Record<string, unknown>;
    const rawItems = ((payload['line_items'] ?? payload['items']) as Array<Record<string, unknown>>) ?? [];
    const items = rawItems.map((item) => ({
      description: String(item['description'] ?? 'Item'),
      hsnSac: String(item['hsn_sac_code'] ?? item['hsn_sac'] ?? ''),
      quantity: Number(item['quantity'] ?? 1),
      unitPriceFormatted: formatInr(BigInt(String(item['unit_price_paise'] ?? 0))),
      taxableAmountFormatted: formatInr(BigInt(String(item['taxable_amount_paise'] ?? 0))),
      gstRateFormatted: `${Number(item['gst_rate_bps'] ?? 0) / 100}%`,
      totalFormatted: formatInr(BigInt(String(item['total_paise'] ?? 0))),
    }));

    const subtotalPaise = BigInt(String(payload['subtotal_paise'] ?? 0));
    const totalPaise = BigInt(String(payload['total_paise'] ?? 0));
    const cgstPaise = payload['cgst_paise'] ? BigInt(String(payload['cgst_paise'])) : undefined;
    const sgstPaise = payload['sgst_paise'] ? BigInt(String(payload['sgst_paise'])) : undefined;
    const igstPaise = payload['igst_paise'] ? BigInt(String(payload['igst_paise'])) : undefined;

    const isExpired = new Date() > pending.expiresAt;
    const status = pending.consumedAt ? 'Confirmed' : isExpired ? 'Expired' : 'Pending Review';

    return renderInvoiceCardHtml({
      title: `Invoice Draft: ${String(payload['invoice_number'] ?? 'Draft')}`,
      invoiceNumber: String(payload['invoice_number'] ?? 'Draft'),
      customerName: String(payload['customer_name'] ?? 'Customer'),
      customerGstin: (payload['customer_gstin'] as string | null) ?? null,
      issueDate: String(payload['issue_date'] ?? new Date().toISOString().split('T')[0]),
      dueDate: String(payload['due_date'] ?? new Date().toISOString().split('T')[0]),
      placeOfSupply: String(payload['place_of_supply_state_code'] ?? tenant.business.stateCode),
      items,
      subtotalFormatted: formatInr(subtotalPaise),
      cgstFormatted: cgstPaise !== undefined ? formatInr(cgstPaise) : undefined,
      sgstFormatted: sgstPaise !== undefined ? formatInr(sgstPaise) : undefined,
      igstFormatted: igstPaise !== undefined ? formatInr(igstPaise) : undefined,
      totalFormatted: formatInr(totalPaise),
      status,
      confirmationToken: pending.consumedAt || isExpired ? undefined : tokenSecret,
      expiresInMinutes: Math.max(1, Math.round((pending.expiresAt.getTime() - Date.now()) / 60000)),
    });
  }

  function renderExpensePendingCard(pending: typeof pendingConfirmations.$inferSelect, tokenSecret?: string) {
    const payload = pending.payload as Record<string, unknown>;
    const amountPaise = BigInt(String(payload['amount_paise'] ?? 0));
    const cgstPaise = payload['cgst_paise'] ? BigInt(String(payload['cgst_paise'])) : undefined;
    const sgstPaise = payload['sgst_paise'] ? BigInt(String(payload['sgst_paise'])) : undefined;
    const igstPaise = payload['igst_paise'] ? BigInt(String(payload['igst_paise'])) : undefined;

    const isExpired = new Date() > pending.expiresAt;
    const status = pending.consumedAt ? 'Confirmed' : isExpired ? 'Expired' : 'Pending Review';

    return renderExpenseCardHtml({
      title: `Expense Record: ${String(payload['description'] ?? 'Expense')}`,
      vendorName: String(payload['vendor_name'] ?? ''),
      description: String(payload['description'] ?? 'Expense'),
      amountFormatted: formatInr(amountPaise),
      category: String(payload['category_name'] ?? 'General Expense'),
      paymentMethod: String(payload['payment_method'] ?? 'bank_transfer'),
      expenseDate: String(payload['expense_date'] ?? new Date().toISOString().split('T')[0]),
      isItcEligible: payload['is_itc_eligible'] === true,
      itcBlockReason: (payload['itc_block_reason'] as string | null) ?? null,
      cgstFormatted: cgstPaise !== undefined ? formatInr(cgstPaise) : undefined,
      sgstFormatted: sgstPaise !== undefined ? formatInr(sgstPaise) : undefined,
      igstFormatted: igstPaise !== undefined ? formatInr(igstPaise) : undefined,
      status,
      confirmationToken: pending.consumedAt || isExpired ? undefined : tokenSecret,
      expiresInMinutes: Math.max(1, Math.round((pending.expiresAt.getTime() - Date.now()) / 60000)),
    });
  }

  // 8. Static UI Card: ui://cards/invoice-draft (Tool-linked generic card template)
  server.resource(
    'ui-invoice-draft-generic-card',
    new ResourceTemplate('ui://cards/invoice-draft', { list: undefined }),
    {
      description: 'Interactive HTML card template for invoice draft preview and confirmation',
      mimeType: MCP_APP_MIME_TYPE,
    },
    async (uri) => {
      const html = renderInvoiceCardHtml({
        title: 'Invoice Draft Preview',
        invoiceNumber: 'DRAFT',
        customerName: 'Awaiting Draft Details...',
        customerGstin: null,
        placeOfSupply: '—',
        issueDate: '—',
        dueDate: '—',
        items: [],
        subtotalFormatted: '₹0.00',
        totalFormatted: '₹0.00',
        status: 'Draft Pending',
      });

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: MCP_APP_MIME_TYPE,
            text: html,
          },
        ],
      };
    },
  );

  // 9. Dynamic Resource Template: ui://cards/invoice-draft/{token}
  server.resource(
    'ui-invoice-draft-card',
    new ResourceTemplate('ui://cards/invoice-draft/{token}', { list: undefined }),
    {
      description: 'Interactive HTML card for reviewing and confirming an invoice draft',
      mimeType: MCP_APP_MIME_TYPE,
    },
    async (uri, variables) => {
      const tenant = getTenantContext();
      const tokenSecret = String(variables['token']);
      const tokenHash = createHash('sha256').update(tokenSecret).digest('hex');

      const [pending] = await db
        .select()
        .from(pendingConfirmations)
        .where(
          and(
            eq(pendingConfirmations.businessId, tenant.businessId),
            eq(pendingConfirmations.tokenHash, tokenHash),
          ),
        );

      if (!pending || pending.actionType !== 'create_invoice') {
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: MCP_APP_MIME_TYPE,
              text: '<div style="font-family: sans-serif; padding: 20px; color: #ef4444;"><h3>Draft Not Found or Expired</h3><p>The requested invoice confirmation draft could not be found or has expired.</p></div>',
            },
          ],
        };
      }

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: MCP_APP_MIME_TYPE,
            text: renderInvoicePendingCard(pending, tokenSecret),
          },
        ],
      };
    },
  );

  // 10. Static UI Card: ui://cards/expense-draft (Tool-linked generic card template)
  server.resource(
    'ui-expense-draft-generic-card',
    new ResourceTemplate('ui://cards/expense-draft', { list: undefined }),
    {
      description: 'Interactive HTML card template for expense draft preview and confirmation',
      mimeType: MCP_APP_MIME_TYPE,
    },
    async (uri) => {
      const html = renderExpenseCardHtml({
        title: 'Expense Draft Preview',
        vendorName: 'Awaiting Draft Details...',
        description: 'Awaiting expense details from host...',
        amountFormatted: '₹0.00',
        category: '—',
        paymentMethod: '—',
        expenseDate: '—',
        isItcEligible: true,
        status: 'Draft Pending',
      });

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: MCP_APP_MIME_TYPE,
            text: html,
          },
        ],
      };
    },
  );

  // 11. Dynamic Resource Template: ui://cards/expense-draft/{token}
  server.resource(
    'ui-expense-draft-card',
    new ResourceTemplate('ui://cards/expense-draft/{token}', { list: undefined }),
    {
      description: 'Interactive HTML card for reviewing and confirming an expense draft',
      mimeType: MCP_APP_MIME_TYPE,
    },
    async (uri, variables) => {
      const tenant = getTenantContext();
      const tokenSecret = String(variables['token']);
      const tokenHash = createHash('sha256').update(tokenSecret).digest('hex');

      const [pending] = await db
        .select()
        .from(pendingConfirmations)
        .where(
          and(
            eq(pendingConfirmations.businessId, tenant.businessId),
            eq(pendingConfirmations.tokenHash, tokenHash),
          ),
        );

      if (!pending || pending.actionType !== 'record_expense') {
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: MCP_APP_MIME_TYPE,
              text: '<div style="font-family: sans-serif; padding: 20px; color: #ef4444;"><h3>Draft Not Found or Expired</h3><p>The requested expense confirmation draft could not be found or has expired.</p></div>',
            },
          ],
        };
      }

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: MCP_APP_MIME_TYPE,
            text: renderExpensePendingCard(pending, tokenSecret),
          },
        ],
      };
    },
  );

  async function renderMonthEndReportCard(month: number, year: number) {
    const tenant = getTenantContext();
    const [report] = await db
      .select()
      .from(monthEndReports)
      .where(
        and(
          eq(monthEndReports.businessId, tenant.businessId),
          eq(monthEndReports.month, month),
          eq(monthEndReports.year, year),
        ),
      );

    const summary = (report?.summaryJson as Record<string, unknown>) ?? {};
    const billedPaise = BigInt(String(summary['billed_revenue_paise'] ?? 0));
    const expPaise = BigInt(String(summary['total_expenses_paise'] ?? 0));
    const colPaise = BigInt(String(summary['collections_paise'] ?? 0));
    const netProfitPaise = billedPaise - expPaise;

    return renderMonthEndCardHtml({
      businessName: tenant.business.name,
      month,
      year,
      currentStep: String(summary['step'] ?? 'not_started'),
      status: report ? 'Report Available' : 'In Progress',
      isBalanced: summary['ledger_balanced'] === true,
      billedRevenueFormatted: formatInr(billedPaise),
      collectionsFormatted: formatInr(colPaise),
      totalExpensesFormatted: formatInr(expPaise),
      netProfitFormatted: formatInr(netProfitPaise),
      uncategorizedExpensesCount: Number(summary['uncategorized_expenses_count'] ?? 0),
      allowGeneralExpense: summary['allow_general_expense'] === true,
      unbalancedEntriesCount: Array.isArray(summary['unbalanced_entries'])
        ? summary['unbalanced_entries'].length
        : 0,
      missingJournalsCount: Array.isArray(summary['missing_journal_transactions'])
        ? summary['missing_journal_transactions'].length
        : 0,
      amountMismatchesCount: Array.isArray(summary['amount_mismatch_transactions'])
        ? summary['amount_mismatch_transactions'].length
        : 0,
    });
  }

  // 12. Static UI Card: ui://cards/month-end-summary (Tool-linked generic card)
  server.resource(
    'ui-month-end-summary-generic-card',
    new ResourceTemplate('ui://cards/month-end-summary', { list: undefined }),
    {
      description: 'Interactive HTML card for current month-end close status',
      mimeType: MCP_APP_MIME_TYPE,
    },
    async (uri) => {
      const now = new Date();
      const month = now.getUTCMonth() + 1;
      const year = now.getUTCFullYear();
      const cardHtml = await renderMonthEndReportCard(month, year);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: MCP_APP_MIME_TYPE,
            text: cardHtml,
          },
        ],
      };
    },
  );

  // 13. Dynamic Resource Template: ui://cards/month-end-summary/{month}/{year}
  server.resource(
    'ui-month-end-card',
    new ResourceTemplate('ui://cards/month-end-summary/{month}/{year}', { list: undefined }),
    {
      description: 'Interactive HTML card displaying month-end close status and financial metrics',
      mimeType: MCP_APP_MIME_TYPE,
    },
    async (uri, variables) => {
      const month = Number(variables['month']);
      const year = Number(variables['year']);
      const cardHtml = await renderMonthEndReportCard(month, year);

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: MCP_APP_MIME_TYPE,
            text: cardHtml,
          },
        ],
      };
    },
  );
}
