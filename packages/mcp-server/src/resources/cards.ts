/**
 * HTML and JSON Card Renderers for Kanakku MCP Apps (ui:// resources).
 * Implements accessible (WCAG AA), responsive, self-contained UI components
 * for voice/visual conversational agents and rich MCP console hosts.
 */

import { APP_BRIDGE_SCRIPT } from '../apps/index.js';

export interface InvoiceCardData {
  title: string;
  invoiceNumber: string;
  customerName: string;
  customerGstin?: string | null;
  issueDate: string;
  dueDate: string;
  placeOfSupply: string;
  items: Array<{
    description: string;
    hsnSac: string;
    quantity: number;
    unitPriceFormatted: string;
    taxableAmountFormatted: string;
    gstRateFormatted: string;
    totalFormatted: string;
  }>;
  subtotalFormatted: string;
  cgstFormatted?: string;
  sgstFormatted?: string;
  igstFormatted?: string;
  totalFormatted: string;
  status: string;
  confirmationToken?: string;
  expiresInMinutes?: number;
}

export interface ExpenseCardData {
  title: string;
  vendorName: string;
  description: string;
  amountFormatted: string;
  category: string;
  paymentMethod: string;
  expenseDate: string;
  isItcEligible: boolean;
  itcBlockReason?: string | null;
  cgstFormatted?: string;
  sgstFormatted?: string;
  igstFormatted?: string;
  status: string;
  confirmationToken?: string;
  expiresInMinutes?: number;
}

export interface GstCardData {
  businessName: string;
  gstin: string;
  month: number;
  year: number;
  outputGstFormatted: string;
  inputItcFormatted: string;
  netPayableFormatted: string;
  cgstPayableFormatted: string;
  sgstPayableFormatted: string;
  igstPayableFormatted: string;
  remainingItcFormatted: string;
  dueDateFormatted: string;
  statutoryNotice: string;
}

export interface MonthEndCardData {
  businessName: string;
  month: number;
  year: number;
  currentStep: string;
  status: string;
  isBalanced: boolean;
  billedRevenueFormatted: string;
  collectionsFormatted: string;
  totalExpensesFormatted: string;
  netProfitFormatted: string;
  uncategorizedExpensesCount: number;
  allowGeneralExpense: boolean;
  unbalancedEntriesCount: number;
  missingJournalsCount: number;
  amountMismatchesCount: number;
  confirmationToken?: string;
}

export interface BriefingCardData {
  businessName: string;
  briefingText: string;
  activeReceivablesFormatted: string;
  overdueReceivablesFormatted: string;
  cashInflowsFormatted: string;
  cashOutflowsFormatted: string;
  netCashDeltaFormatted: string;
  gstDueFormatted: string;
  recentAuditStatus: string;
}

const BASE_STYLES = `
  :root {
    --bg-primary: #0f172a;
    --bg-card: #1e293b;
    --bg-subtle: #334155;
    --text-primary: #f8fafc;
    --text-secondary: #94a3b8;
    --text-muted: #64748b;
    --accent: #38bdf8;
    --accent-hover: #0284c7;
    --success: #10b981;
    --warning: #f59e0b;
    --danger: #ef4444;
    --border: #334155;
    --radius: 12px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background-color: var(--bg-primary);
    color: var(--text-primary);
    padding: 16px;
    display: flex;
    justify-content: center;
    line-height: 1.5;
  }
  .card {
    background-color: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    width: 100%;
    max-width: 520px;
    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border);
    padding-bottom: 12px;
    margin-bottom: 16px;
  }
  .title {
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--text-primary);
  }
  .badge {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 9999px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .badge-pending { background: rgba(245, 158, 11, 0.2); color: var(--warning); border: 1px solid var(--warning); }
  .badge-success { background: rgba(16, 185, 129, 0.2); color: var(--success); border: 1px solid var(--success); }
  .badge-danger { background: rgba(239, 68, 68, 0.2); color: var(--danger); border: 1px solid var(--danger); }
  .badge-info { background: rgba(56, 189, 248, 0.2); color: var(--accent); border: 1px solid var(--accent); }
  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 16px;
  }
  .data-item {
    display: flex;
    flex-direction: column;
  }
  .data-label {
    font-size: 0.75rem;
    color: var(--text-secondary);
    text-transform: uppercase;
    margin-bottom: 2px;
  }
  .data-value {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--text-primary);
  }
  .amount-hero {
    background: var(--bg-subtle);
    padding: 16px;
    border-radius: 8px;
    text-align: center;
    margin: 16px 0;
  }
  .amount-hero .data-label { font-size: 0.8rem; margin-bottom: 4px; }
  .amount-hero .big-amount { font-size: 1.75rem; font-weight: 800; color: var(--accent); }
  .table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 0.85rem;
  }
  .table th {
    text-align: left;
    color: var(--text-secondary);
    padding: 6px;
    border-bottom: 1px solid var(--border);
  }
  .table td {
    padding: 8px 6px;
    border-bottom: 1px solid rgba(51, 65, 85, 0.5);
  }
  .actions {
    display: flex;
    gap: 10px;
    margin-top: 18px;
  }
  .btn {
    flex: 1;
    padding: 10px 16px;
    border-radius: 8px;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    text-align: center;
    border: none;
    transition: all 0.2s ease;
  }
  .btn-primary { background: var(--accent); color: #0f172a; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-secondary { background: var(--bg-subtle); color: var(--text-primary); }
  .btn-secondary:hover { background: #475569; }
  .disclaimer {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 12px;
    text-align: center;
    font-style: italic;
  }
`;

export function renderInvoiceCardHtml(data: InvoiceCardData): string {
  const itemsHtml = data.items
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(item.description)}</td>
        <td style="text-align: center">${item.quantity}</td>
        <td style="text-align: right">${escapeHtml(item.totalFormatted)}</td>
      </tr>`,
    )
    .join('');

  const taxRows = [
    data.cgstFormatted
      ? `<div><span>CGST:</span> <strong>${escapeHtml(data.cgstFormatted)}</strong></div>`
      : '',
    data.sgstFormatted
      ? `<div><span>SGST:</span> <strong>${escapeHtml(data.sgstFormatted)}</strong></div>`
      : '',
    data.igstFormatted
      ? `<div><span>IGST:</span> <strong>${escapeHtml(data.igstFormatted)}</strong></div>`
      : '',
  ]
    .filter(Boolean)
    .join('');

  const actionsHtml = `
    <div class="actions">
      <button id="btn-confirm" class="btn btn-primary" ${data.confirmationToken ? `onclick="window.handleConfirm('${data.confirmationToken}')"` : 'disabled'}>
        Confirm &amp; Issue
      </button>
      <button id="btn-cancel" class="btn btn-secondary" ${data.confirmationToken ? `onclick="window.handleCancel('${data.confirmationToken}')"` : 'disabled'}>
        Cancel Draft
      </button>
    </div>
    <div id="card-disclaimer" class="disclaimer">
      ${data.confirmationToken ? `Expires in ${data.expiresInMinutes ?? 15} minutes. Token: ${data.confirmationToken.slice(0, 10)}...` : 'Awaiting confirmation token from host...'}
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(data.title)}</title>
  <style>${BASE_STYLES}</style>
</head>
<body>
  <div class="card" role="region" aria-label="Invoice Details Card">
    <div class="header">
      <span class="title">Invoice Draft</span>
      <span id="card-badge" class="badge badge-pending">${escapeHtml(data.status)}</span>
    </div>
    <div class="grid-2">
      <div class="data-item">
        <span class="data-label">Customer</span>
        <span id="card-recipient" class="data-value">${escapeHtml(data.customerName)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Invoice Number</span>
        <span id="card-invoice-number" class="data-value">${escapeHtml(data.invoiceNumber)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Issue Date</span>
        <span id="card-issue-date" class="data-value">${escapeHtml(data.issueDate)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Due Date</span>
        <span id="card-due-date" class="data-value">${escapeHtml(data.dueDate)}</span>
      </div>
      <div class="data-item" style="grid-column: span 2;">
        <span class="data-label">Place of Supply</span>
        <span id="card-place-of-supply" class="data-value">${escapeHtml(data.placeOfSupply)}</span>
      </div>
    </div>

    <table class="table" aria-label="Invoice Line Items">
      <thead>
        <tr>
          <th>Item</th>
          <th style="text-align: center">Qty</th>
          <th style="text-align: right">Total</th>
        </tr>
      </thead>
      <tbody id="card-items">
        ${itemsHtml}
      </tbody>
    </table>

    <div class="amount-hero">
      <div class="data-label">Total Amount Due (GST Inclusive)</div>
      <div id="card-total" class="big-amount">${escapeHtml(data.totalFormatted)}</div>
      <div id="card-taxes" style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 6px; display: flex; justify-content: center; gap: 12px;">
        ${taxRows}
      </div>
    </div>

    ${actionsHtml}
  </div>
  <script>
    window.currentToken = ${JSON.stringify(data.confirmationToken ?? null)};
  </script>
  ${APP_BRIDGE_SCRIPT}
</body>
</html>`;
}

export function renderExpenseCardHtml(data: ExpenseCardData): string {
  const actionsHtml = `
    <div class="actions">
      <button id="btn-confirm" class="btn btn-primary" ${data.confirmationToken ? `onclick="window.handleConfirm('${data.confirmationToken}')"` : 'disabled'}>
        Confirm &amp; Post
      </button>
      <button id="btn-cancel" class="btn btn-secondary" ${data.confirmationToken ? `onclick="window.handleCancel('${data.confirmationToken}')"` : 'disabled'}>
        Cancel Draft
      </button>
    </div>
    <div id="card-disclaimer" class="disclaimer">
      ${data.confirmationToken ? `Expires in ${data.expiresInMinutes ?? 15} minutes. Token: ${data.confirmationToken.slice(0, 10)}...` : 'Awaiting confirmation token from host...'}
    </div>`;

  const itcBadge = data.isItcEligible
    ? `<span class="badge badge-success">ITC Eligible</span>`
    : `<span class="badge badge-danger">Blocked ITC: ${escapeHtml(data.itcBlockReason || 'Sec 17(5)')}</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(data.title)}</title>
  <style>${BASE_STYLES}</style>
</head>
<body>
  <div class="card" role="region" aria-label="Expense Details Card">
    <div class="header">
      <span class="title">Expense Record</span>
      <span id="card-badge" class="badge badge-pending">${escapeHtml(data.status)}</span>
    </div>
    <div class="grid-2">
      <div class="data-item">
        <span class="data-label">Vendor / Description</span>
        <span id="card-recipient" class="data-value">${escapeHtml(data.vendorName || data.description)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Category</span>
        <span id="card-category" class="data-value">${escapeHtml(data.category)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Date</span>
        <span id="card-date" class="data-value">${escapeHtml(data.expenseDate)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Payment Mode</span>
        <span id="card-payment-mode" class="data-value">${escapeHtml(data.paymentMethod.toUpperCase())}</span>
      </div>
    </div>

    <div style="margin: 12px 0; display: flex; align-items: center; justify-content: space-between;">
      <span style="font-size: 0.85rem; color: var(--text-secondary);">Input Tax Credit Treatment</span>
      <span id="card-itc-container">${itcBadge}</span>
    </div>

    <div class="amount-hero">
      <div class="data-label">Total Expense Amount</div>
      <div id="card-total" class="big-amount">${escapeHtml(data.amountFormatted)}</div>
      <div id="card-taxes" style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 6px; display: flex; justify-content: center; gap: 12px;"></div>
    </div>

    ${actionsHtml}
  </div>
  <script>
    window.currentToken = ${JSON.stringify(data.confirmationToken ?? null)};
  </script>
  ${APP_BRIDGE_SCRIPT}
</body>
</html>`;
}

export function renderGstCardHtml(data: GstCardData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GST Liability Summary</title>
  <style>${BASE_STYLES}</style>
</head>
<body>
  <div class="card" role="region" aria-label="GST Liability Summary Card">
    <div class="header">
      <span class="title">GST Liability (Period: ${data.month}/${data.year})</span>
      <span class="badge badge-info">${escapeHtml(data.gstin)}</span>
    </div>

    <div class="grid-2">
      <div class="data-item">
        <span class="data-label">Output GST (Gross)</span>
        <span class="data-value" style="color: var(--danger);">${escapeHtml(data.outputGstFormatted)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Input Tax Credit (ITC)</span>
        <span class="data-value" style="color: var(--success);">${escapeHtml(data.inputItcFormatted)}</span>
      </div>
    </div>

    <div class="amount-hero">
      <div class="data-label">Net GST Cash Payable (Sec 49 Set-Off)</div>
      <div class="big-amount" style="color: var(--warning);">${escapeHtml(data.netPayableFormatted)}</div>
      <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 6px;">
        Due by: <strong>${escapeHtml(data.dueDateFormatted)}</strong> (GSTR-3B)
      </div>
    </div>

    <div class="grid-2" style="font-size: 0.85rem; border-top: 1px solid var(--border); padding-top: 12px;">
      <div>CGST: <strong>${escapeHtml(data.cgstPayableFormatted)}</strong></div>
      <div>SGST: <strong>${escapeHtml(data.sgstPayableFormatted)}</strong></div>
      <div>IGST: <strong>${escapeHtml(data.igstPayableFormatted)}</strong></div>
      <div>Remaining ITC: <strong>${escapeHtml(data.remainingItcFormatted)}</strong></div>
    </div>

    <div class="disclaimer">
      ${escapeHtml(data.statutoryNotice)}
    </div>
  </div>
  ${APP_BRIDGE_SCRIPT}
</body>
</html>`;
}

export function renderMonthEndCardHtml(data: MonthEndCardData): string {
  const balanceBadge = data.isBalanced
    ? `<span class="badge badge-success">Ledger Balanced</span>`
    : `<span class="badge badge-danger">Unbalanced</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Month-End Close Card</title>
  <style>${BASE_STYLES}</style>
</head>
<body>
  <div class="card" role="region" aria-label="Month-End Close Card">
    <div class="header">
      <span class="title">Month Close: ${data.month}/${data.year}</span>
      ${balanceBadge}
    </div>

    <div class="grid-2">
      <div class="data-item">
        <span class="data-label">Billed Revenue</span>
        <span class="data-value">${escapeHtml(data.billedRevenueFormatted)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Collections</span>
        <span class="data-value">${escapeHtml(data.collectionsFormatted)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Expenses</span>
        <span class="data-value">${escapeHtml(data.totalExpensesFormatted)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Workflow Step</span>
        <span class="data-value">${escapeHtml(data.currentStep.toUpperCase())}</span>
      </div>
    </div>

    <div class="amount-hero">
      <div class="data-label">Net Operating Margin</div>
      <div class="big-amount">${escapeHtml(data.netProfitFormatted)}</div>
    </div>

    <div style="font-size: 0.85rem; color: var(--text-secondary); margin: 8px 0;">
      <div>Uncategorized Expenses: <strong>${data.uncategorizedExpensesCount}</strong></div>
      <div>Missing Ledger Entries: <strong>${data.missingJournalsCount}</strong></div>
      <div>Amount Mismatches: <strong>${data.amountMismatchesCount}</strong></div>
    </div>

    <div class="disclaimer">
      Books will be immutably locked upon confirmation.
    </div>
  </div>
  ${APP_BRIDGE_SCRIPT}
</body>
</html>`;
}

export function renderBriefingCardHtml(data: BriefingCardData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Executive Briefing</title>
  <style>${BASE_STYLES}</style>
</head>
<body>
  <div class="card" role="region" aria-label="Executive Briefing Card">
    <div class="header">
      <span class="title">Executive Financial Briefing</span>
      <span class="badge badge-info">${escapeHtml(data.businessName)}</span>
    </div>

    <div style="background: var(--bg-subtle); padding: 12px; border-radius: 8px; font-size: 0.95rem; margin-bottom: 16px; font-style: italic;">
      "${escapeHtml(data.briefingText)}"
    </div>

    <div class="grid-2">
      <div class="data-item">
        <span class="data-label">Active Receivables</span>
        <span class="data-value">${escapeHtml(data.activeReceivablesFormatted)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Overdue</span>
        <span class="data-value" style="color: var(--danger);">${escapeHtml(data.overdueReceivablesFormatted)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Cash Inflows</span>
        <span class="data-value" style="color: var(--success);">${escapeHtml(data.cashInflowsFormatted)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Net Cash Movement</span>
        <span class="data-value">${escapeHtml(data.netCashDeltaFormatted)}</span>
      </div>
    </div>

    <div class="disclaimer">
      Audit Hash Chain: ${escapeHtml(data.recentAuditStatus)}
    </div>
  </div>
  ${APP_BRIDGE_SCRIPT}
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
