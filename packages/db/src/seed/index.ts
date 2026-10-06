/**
 * Deterministic 3-Month Seed Dataset for Kanakku.
 * Represents realistic Indian SMB operations (July 2026 to September 2026).
 * Zero placeholder names. All money in integer paise.
 */

import { createHash, randomBytes } from 'node:crypto';
import { computeAuditEntryHash, hashPayload } from '@kanakku/core';

export interface SeedOptions {
  /**
   * Optional owner API key supplied out of band.
   * If omitted and process.env.SEED_OWNER_API_KEY is not set, a cryptographically
   * secure random key will be generated dynamically and returned for one-time display.
   */
  ownerApiKey?: string;
}

export interface SeedDataResult {
  generatedOwnerApiKey: string;
  business: {
    id: string;
    name: string;
    legalName: string;
    gstin: string;
    stateCode: string;
    pan: string;
  };
  users: Array<{
    id: string;
    businessId: string;
    email: string;
    name: string;
    role: string;
    apiKeyHash: string;
  }>;
  customers: Array<{
    id: string;
    businessId: string;
    name: string;
    contactName: string;
    email: string;
    phone: string;
    gstin: string;
    stateCode: string;
  }>;
  chartOfAccounts: Array<{
    id: string;
    businessId: string;
    code: string;
    name: string;
    type: string;
  }>;
  expenseCategories: Array<{
    id: string;
    businessId: string;
    name: string;
    glAccountId: string;
    defaultGstRateBps: number;
    isItcEligible: boolean;
  }>;
  invoices: Array<{
    id: string;
    businessId: string;
    customerId: string;
    invoiceNumber: string;
    financialYear: string;
    issueDate: Date;
    dueDate: Date;
    placeOfSupplyStateCode: string;
    isInterState: boolean;
    subtotalPaise: bigint;
    cgstPaise: bigint;
    sgstPaise: bigint;
    igstPaise: bigint;
    roundOffPaise: bigint;
    totalPaise: bigint;
    paidAmountPaise: bigint;
    status: string;
  }>;
  expenses: Array<{
    id: string;
    businessId: string;
    categoryId: string | null;
    amountPaise: bigint;
    taxableAmountPaise: bigint;
    cgstPaise: bigint;
    sgstPaise: bigint;
    igstPaise: bigint;
    roundOffPaise: bigint;
    gstRateBps: number;
    isItcClaimed: boolean;
    paymentMethod: string;
    expenseDate: Date;
    vendorName: string;
    vendorGstin: string | null;
    description: string;
    status: string;
  }>;
  payments: Array<{
    id: string;
    businessId: string;
    customerId: string;
    invoiceId: string | null;
    amountPaise: bigint;
    paymentDate: Date;
    paymentMode: string;
    referenceNumber: string | null;
    status: string;
    notes: string | null;
  }>;
  journalEntries: Array<{
    id: string;
    businessId: string;
    entryNumber: string;
    entryDate: Date;
    sourceEntityType: string;
    sourceEntityId: string;
    narration: string;
  }>;
  journalLines: Array<{
    id: string;
    businessId: string;
    journalEntryId: string;
    accountId: string;
    debitPaise: bigint;
    creditPaise: bigint;
  }>;
  businessMemory: Array<{
    id: string;
    businessId: string;
    category: string;
    entityKey: string;
    memoryValue: Record<string, unknown>;
    confidence: string;
    isActive: boolean;
  }>;
  auditLogs: Array<{
    id: string;
    businessId: string;
    sequenceNumber: bigint;
    requestId: string;
    source: string;
    toolName: string;
    action: string;
    entityType: string;
    entityId: string;
    payloadHash: string;
    prevHash: string;
    entryHash: string;
    createdAt: Date;
  }>;
}

export function generateSeedDataset(options?: SeedOptions): SeedDataResult {
  const businessId = 'b0000000-0000-0000-0000-000000000001';
  const userId = '10000000-0000-0000-0000-000000000001';

  // Do not seed a usable fixed credential. Require an out-of-band secret or generate one dynamically for local development.
  const ownerApiKey =
    options?.ownerApiKey || process.env['SEED_OWNER_API_KEY'] || randomBytes(24).toString('hex');
  const ownerApiKeyHash = createHash('sha256').update(ownerApiKey).digest('hex');

  const business = {
    id: businessId,
    name: 'Kanakku Creative Services',
    legalName: 'Kanakku Creative Services Private Limited',
    gstin: '33AAAAK1234A1Z5',
    stateCode: '33', // Tamil Nadu
    pan: 'AAAAK1234A',
  };

  const users = [
    {
      id: userId,
      businessId,
      email: 'ramesh@kanakku.in',
      name: 'Ramesh Kumar',
      role: 'owner',
      apiKeyHash: ownerApiKeyHash,
    },
  ];

  const customers = [
    {
      id: 'c0000000-0000-0000-0000-000000000001',
      businessId,
      name: 'Meena Textiles',
      contactName: 'Meena Sundaram',
      email: 'meena@meenatextiles.com',
      phone: '+919840011223',
      gstin: '33AABCM5678B1Z2',
      stateCode: '33', // Intra-state (Tamil Nadu)
    },
    {
      id: 'c0000000-0000-0000-0000-000000000002',
      businessId,
      name: 'Ravi Traders',
      contactName: 'Ravi Chandran',
      email: 'ravi@ravitraders.in',
      phone: '+919841122334',
      gstin: '33AABCR9012C1Z4',
      stateCode: '33', // Intra-state (Tamil Nadu) - Has Overdue invoice
    },
    {
      id: 'c0000000-0000-0000-0000-000000000003',
      businessId,
      name: 'Anand Enterprises',
      contactName: 'Anand Rao',
      email: 'accounts@anandent.com',
      phone: '+919842233445',
      gstin: '29AABCA3456D1Z6',
      stateCode: '29', // Inter-state (Karnataka)
    },
    {
      id: 'c0000000-0000-0000-0000-000000000004',
      businessId,
      name: 'Priya Technologies',
      contactName: 'Priya Reddy',
      email: 'billing@priyatech.io',
      phone: '+919843344556',
      gstin: '36AABCP7890E1Z8',
      stateCode: '36', // Inter-state (Telangana)
    },
  ];

  const chartOfAccounts = [
    {
      id: 'a0000000-0000-0000-0000-000000001110',
      businessId,
      code: '1110',
      name: 'HDFC Current Account',
      type: 'asset',
    },
    {
      id: 'a0000000-0000-0000-0000-000000001120',
      businessId,
      code: '1120',
      name: 'Accounts Receivable',
      type: 'asset',
    },
    {
      id: 'a0000000-0000-0000-0000-000000001210',
      businessId,
      code: '1210',
      name: 'Input CGST Credit',
      type: 'asset',
    },
    {
      id: 'a0000000-0000-0000-0000-000000001220',
      businessId,
      code: '1220',
      name: 'Input SGST Credit',
      type: 'asset',
    },
    {
      id: 'a0000000-0000-0000-0000-000000001230',
      businessId,
      code: '1230',
      name: 'Input IGST Credit',
      type: 'asset',
    },
    {
      id: 'a0000000-0000-0000-0000-000000002110',
      businessId,
      code: '2110',
      name: 'Output CGST Liability',
      type: 'liability',
    },
    {
      id: 'a0000000-0000-0000-0000-000000002120',
      businessId,
      code: '2120',
      name: 'Output SGST Liability',
      type: 'liability',
    },
    {
      id: 'a0000000-0000-0000-0000-000000002130',
      businessId,
      code: '2130',
      name: 'Output IGST Liability',
      type: 'liability',
    },
    {
      id: 'a0000000-0000-0000-0000-000000004100',
      businessId,
      code: '4100',
      name: 'Design & Consulting Revenue',
      type: 'revenue',
    },
    {
      id: 'a0000000-0000-0000-0000-000000005100',
      businessId,
      code: '5100',
      name: 'Office Supplies Expense',
      type: 'expense',
    },
    {
      id: 'a0000000-0000-0000-0000-000000005200',
      businessId,
      code: '5200',
      name: 'Cloud Infrastructure Expense',
      type: 'expense',
    },
    {
      id: 'a0000000-0000-0000-0000-000000005300',
      businessId,
      code: '5300',
      name: 'Client Entertainment (Blocked ITC)',
      type: 'expense',
    },
  ];

  const expenseCategories = [
    {
      id: 'e0000000-0000-0000-0000-000000000001',
      businessId,
      name: 'Office Supplies',
      glAccountId: 'a0000000-0000-0000-0000-000000005100',
      defaultGstRateBps: 1800,
      isItcEligible: true,
    },
    {
      id: 'e0000000-0000-0000-0000-000000000002',
      businessId,
      name: 'Cloud Infrastructure',
      glAccountId: 'a0000000-0000-0000-0000-000000005200',
      defaultGstRateBps: 1800,
      isItcEligible: true,
    },
    {
      id: 'e0000000-0000-0000-0000-000000000003',
      businessId,
      name: 'Client Hospitality & Meals',
      glAccountId: 'a0000000-0000-0000-0000-000000005300',
      defaultGstRateBps: 500,
      isItcEligible: false, // Section 17(5) Blocked Credit
    },
  ];

  const invoices = [
    // July 2026 Invoice - Paid
    {
      id: 'f0000000-0000-0000-0000-000000000001',
      businessId,
      customerId: customers[0]!.id, // Meena Textiles
      invoiceNumber: 'KAN/2026-27/0001',
      financialYear: '2026-27',
      issueDate: new Date('2026-07-10T10:00:00Z'),
      dueDate: new Date('2026-07-25T10:00:00Z'),
      placeOfSupplyStateCode: '33',
      isInterState: false,
      subtotalPaise: 4000000n, // ₹40,000
      cgstPaise: 360000n, // 9% = ₹3,600
      sgstPaise: 360000n, // 9% = ₹3,600
      igstPaise: 0n,
      roundOffPaise: 0n,
      totalPaise: 4720000n, // ₹47,200
      paidAmountPaise: 4720000n,
      status: 'paid',
    },
    // August 2026 Invoice - Overdue for Ravi Traders
    {
      id: 'f0000000-0000-0000-0000-000000000002',
      businessId,
      customerId: customers[1]!.id, // Ravi Traders
      invoiceNumber: 'KAN/2026-27/0002',
      financialYear: '2026-27',
      issueDate: new Date('2026-08-05T10:00:00Z'),
      dueDate: new Date('2026-08-20T10:00:00Z'), // Overdue as of September!
      placeOfSupplyStateCode: '33',
      isInterState: false,
      subtotalPaise: 5500000n, // ₹55,000
      cgstPaise: 495000n, // 9% = ₹4,950
      sgstPaise: 495000n, // 9% = ₹4,950
      igstPaise: 0n,
      roundOffPaise: 0n,
      totalPaise: 6490000n, // ₹64,900
      paidAmountPaise: 2000000n, // Partially paid ₹20,000 -> ₹44,900 overdue
      status: 'partially_paid',
    },
    // September 2026 Invoice - Inter-State (Anand Enterprises)
    {
      id: 'f0000000-0000-0000-0000-000000000003',
      businessId,
      customerId: customers[2]!.id, // Anand Enterprises
      invoiceNumber: 'KAN/2026-27/0003',
      financialYear: '2026-27',
      issueDate: new Date('2026-09-02T10:00:00Z'),
      dueDate: new Date('2026-09-30T10:00:00Z'),
      placeOfSupplyStateCode: '29', // Karnataka
      isInterState: true,
      subtotalPaise: 8000000n, // ₹80,000
      cgstPaise: 0n,
      sgstPaise: 0n,
      igstPaise: 1440000n, // 18% IGST = ₹14,400
      roundOffPaise: 0n,
      totalPaise: 9440000n, // ₹94,400
      paidAmountPaise: 0n,
      status: 'issued',
    },
  ];

  const expenses = [
    // July Regular Expense
    {
      id: 'd0000000-0000-0000-0000-000000000001',
      businessId,
      categoryId: expenseCategories[0]!.id, // Office Supplies
      amountPaise: 590000n, // ₹5,900
      taxableAmountPaise: 500000n, // ₹5,000
      cgstPaise: 45000n, // ₹450
      sgstPaise: 45000n, // ₹450
      igstPaise: 0n,
      roundOffPaise: 0n,
      gstRateBps: 1800,
      isItcClaimed: true,
      paymentMethod: 'bank_transfer',
      expenseDate: new Date('2026-07-15T10:00:00Z'),
      vendorName: 'Coimbatore Stationery Mart',
      vendorGstin: '33AABCC1234D1Z8',
      description: 'Office stationery and printer paper',
      status: 'posted',
    },
    // August Blocked Credit Expense (Client Hospitality)
    {
      id: 'd0000000-0000-0000-0000-000000000002',
      businessId,
      categoryId: expenseCategories[2]!.id, // Client Hospitality
      amountPaise: 420000n, // ₹4,200
      taxableAmountPaise: 400000n, // ₹4,000
      cgstPaise: 10000n, // ₹100
      sgstPaise: 10000n, // ₹100
      igstPaise: 0n,
      roundOffPaise: 0n,
      gstRateBps: 500,
      isItcClaimed: false, // Ineligible under Sec 17(5)
      paymentMethod: 'card',
      expenseDate: new Date('2026-08-18T19:30:00Z'),
      vendorName: 'Taj Connemara Hotel',
      vendorGstin: '33AABCT9999M1Z1',
      description: 'Client project discussion dinner',
      status: 'posted',
    },
    // September Uncategorised Expense 1: ₹2,400 for printer ink (Canonical Demo Scene 2!)
    // 203390 + 18305 + 18305 = 240000 exactly
    {
      id: 'd0000000-0000-0000-0000-000000000003',
      businessId,
      categoryId: null, // Uncategorised!
      amountPaise: 240000n, // ₹2,400
      taxableAmountPaise: 203390n,
      cgstPaise: 18305n,
      sgstPaise: 18305n,
      igstPaise: 0n,
      roundOffPaise: 0n,
      gstRateBps: 1800,
      isItcClaimed: false,
      paymentMethod: 'upi',
      expenseDate: new Date('2026-09-22T14:15:00Z'),
      vendorName: 'Madras Computer Cartridges',
      vendorGstin: '33AABCM4444N1Z9',
      description: 'Printer ink refill cartridges',
      status: 'posted',
    },
    // September Uncategorised Expense 2: ₹8,500 AWS Cloud bill (Canonical Demo Scene 4 clarification!)
    // Taxable: 720339, CGST: 64831, SGST: 64831 -> sum = 850001, roundOff = -1 -> amountPaise = 850000
    {
      id: 'd0000000-0000-0000-0000-000000000004',
      businessId,
      categoryId: null, // Uncategorised!
      amountPaise: 850000n, // ₹8,500
      taxableAmountPaise: 720339n,
      cgstPaise: 64831n,
      sgstPaise: 64831n,
      igstPaise: 0n,
      roundOffPaise: -1n,
      gstRateBps: 1800,
      isItcClaimed: false,
      paymentMethod: 'card',
      expenseDate: new Date('2026-09-15T09:00:00Z'),
      vendorName: 'Amazon Web Services India',
      vendorGstin: '33AABCA8888P1Z3',
      description: 'Monthly cloud hosting servers',
      status: 'posted',
    },
  ];

  const payments = [
    {
      id: 'e1000000-0000-0000-0000-000000000001',
      businessId,
      customerId: customers[0]!.id,
      invoiceId: invoices[0]!.id,
      amountPaise: 4720000n,
      paymentDate: new Date('2026-07-20T11:00:00Z'),
      paymentMode: 'neft',
      referenceNumber: 'NEFT-HDFC-788912',
      status: 'reconciled',
      notes: 'Full payment received for invoice KAN/2026-27/0001',
    },
    {
      id: 'e1000000-0000-0000-0000-000000000002',
      businessId,
      customerId: customers[1]!.id,
      invoiceId: invoices[1]!.id,
      amountPaise: 2000000n,
      paymentDate: new Date('2026-08-15T14:30:00Z'),
      paymentMode: 'upi',
      referenceNumber: 'UPI-HDFC-991234',
      status: 'reconciled',
      notes: 'Partial payment received for invoice KAN/2026-27/0002',
    },
  ];

  const journalEntries = [
    {
      id: 'e2000000-0000-0000-0000-000000000001',
      businessId,
      entryNumber: 'JE-202607-0001',
      entryDate: new Date('2026-07-10T10:00:00Z'),
      sourceEntityType: 'invoice',
      sourceEntityId: invoices[0]!.id,
      narration: 'Invoice issued: KAN/2026-27/0001 to Meena Textiles',
    },
    {
      id: 'e2000000-0000-0000-0000-000000000002',
      businessId,
      entryNumber: 'JE-202607-0002',
      entryDate: new Date('2026-07-20T11:00:00Z'),
      sourceEntityType: 'payment',
      sourceEntityId: payments[0]!.id,
      narration: 'Payment received for KAN/2026-27/0001 via NEFT',
    },
    {
      id: 'e2000000-0000-0000-0000-000000000003',
      businessId,
      entryNumber: 'JE-202607-0003',
      entryDate: new Date('2026-07-15T10:00:00Z'),
      sourceEntityType: 'expense',
      sourceEntityId: expenses[0]!.id,
      narration: 'Expense: Office stationery and printer paper (bank_transfer)',
    },
    {
      id: 'e2000000-0000-0000-0000-000000000004',
      businessId,
      entryNumber: 'JE-202608-0001',
      entryDate: new Date('2026-08-05T10:00:00Z'),
      sourceEntityType: 'invoice',
      sourceEntityId: invoices[1]!.id,
      narration: 'Invoice issued: KAN/2026-27/0002 to Ravi Traders',
    },
    {
      id: 'e2000000-0000-0000-0000-000000000005',
      businessId,
      entryNumber: 'JE-202608-0002',
      entryDate: new Date('2026-08-15T14:30:00Z'),
      sourceEntityType: 'payment',
      sourceEntityId: payments[1]!.id,
      narration: 'Partial payment received for KAN/2026-27/0002 via UPI',
    },
    {
      id: 'e2000000-0000-0000-0000-000000000006',
      businessId,
      entryNumber: 'JE-202608-0003',
      entryDate: new Date('2026-08-18T19:30:00Z'),
      sourceEntityType: 'expense',
      sourceEntityId: expenses[1]!.id,
      narration: 'Expense: Client project discussion dinner (card)',
    },
    {
      id: 'e2000000-0000-0000-0000-000000000007',
      businessId,
      entryNumber: 'JE-202609-0001',
      entryDate: new Date('2026-09-02T10:00:00Z'),
      sourceEntityType: 'invoice',
      sourceEntityId: invoices[2]!.id,
      narration: 'Invoice issued: KAN/2026-27/0003 to Anand Enterprises',
    },
    {
      id: 'e2000000-0000-0000-0000-000000000008',
      businessId,
      entryNumber: 'JE-202609-0002',
      entryDate: new Date('2026-09-22T14:15:00Z'),
      sourceEntityType: 'expense',
      sourceEntityId: expenses[2]!.id,
      narration: 'Expense: Printer ink refill cartridges (upi)',
    },
    {
      id: 'e2000000-0000-0000-0000-000000000009',
      businessId,
      entryNumber: 'JE-202609-0003',
      entryDate: new Date('2026-09-15T09:00:00Z'),
      sourceEntityType: 'expense',
      sourceEntityId: expenses[3]!.id,
      narration: 'Expense: Monthly cloud hosting servers (card)',
    },
  ];

  const journalLines = [
    // Entry 1 (Invoice 1): Total 4720000n = 4000000n + 360000n + 360000n
    {
      id: 'e3000000-0000-0000-0000-000000000001',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000001',
      accountId: 'a0000000-0000-0000-0000-000000001120', // Accounts Receivable
      debitPaise: 4720000n,
      creditPaise: 0n,
    },
    {
      id: 'e3000000-0000-0000-0000-000000000002',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000001',
      accountId: 'a0000000-0000-0000-0000-000000004100', // Design & Consulting Revenue
      debitPaise: 0n,
      creditPaise: 4000000n,
    },
    {
      id: 'e3000000-0000-0000-0000-000000000003',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000001',
      accountId: 'a0000000-0000-0000-0000-000000002110', // Output CGST Liability
      debitPaise: 0n,
      creditPaise: 360000n,
    },
    {
      id: 'e3000000-0000-0000-0000-000000000004',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000001',
      accountId: 'a0000000-0000-0000-0000-000000002120', // Output SGST Liability
      debitPaise: 0n,
      creditPaise: 360000n,
    },

    // Entry 2 (Payment 1): Total 4720000n
    {
      id: 'e3000000-0000-0000-0000-000000000005',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000002',
      accountId: 'a0000000-0000-0000-0000-000000001110', // HDFC Current Account
      debitPaise: 4720000n,
      creditPaise: 0n,
    },
    {
      id: 'e3000000-0000-0000-0000-000000000006',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000002',
      accountId: 'a0000000-0000-0000-0000-000000001120', // Accounts Receivable
      debitPaise: 0n,
      creditPaise: 4720000n,
    },

    // Entry 3 (Expense 1): Total 590000n = 500000n + 45000n + 45000n
    {
      id: 'e3000000-0000-0000-0000-000000000007',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000003',
      accountId: 'a0000000-0000-0000-0000-000000005100', // Office Supplies Expense
      debitPaise: 500000n,
      creditPaise: 0n,
    },
    {
      id: 'e3000000-0000-0000-0000-000000000008',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000003',
      accountId: 'a0000000-0000-0000-0000-000000001210', // Input CGST Credit
      debitPaise: 45000n,
      creditPaise: 0n,
    },
    {
      id: 'e3000000-0000-0000-0000-000000000009',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000003',
      accountId: 'a0000000-0000-0000-0000-000000001220', // Input SGST Credit
      debitPaise: 45000n,
      creditPaise: 0n,
    },
    {
      id: 'e3000000-0000-0000-0000-000000000010',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000003',
      accountId: 'a0000000-0000-0000-0000-000000001110', // HDFC Current Account
      debitPaise: 0n,
      creditPaise: 590000n,
    },

    // Entry 4 (Invoice 2): Total 6490000n = 5500000n + 495000n + 495000n
    {
      id: 'e3000000-0000-0000-0000-000000000011',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000004',
      accountId: 'a0000000-0000-0000-0000-000000001120', // Accounts Receivable
      debitPaise: 6490000n,
      creditPaise: 0n,
    },
    {
      id: 'e3000000-0000-0000-0000-000000000012',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000004',
      accountId: 'a0000000-0000-0000-0000-000000004100', // Design & Consulting Revenue
      debitPaise: 0n,
      creditPaise: 5500000n,
    },
    {
      id: 'e3000000-0000-0000-0000-000000000013',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000004',
      accountId: 'a0000000-0000-0000-0000-000000002110', // Output CGST Liability
      debitPaise: 0n,
      creditPaise: 495000n,
    },
    {
      id: 'e3000000-0000-0000-0000-000000000014',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000004',
      accountId: 'a0000000-0000-0000-0000-000000002120', // Output SGST Liability
      debitPaise: 0n,
      creditPaise: 495000n,
    },

    // Entry 5 (Payment 2): Total 2000000n
    {
      id: 'e3000000-0000-0000-0000-000000000015',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000005',
      accountId: 'a0000000-0000-0000-0000-000000001110', // HDFC Current Account
      debitPaise: 2000000n,
      creditPaise: 0n,
    },
    {
      id: 'e3000000-0000-0000-0000-000000000016',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000005',
      accountId: 'a0000000-0000-0000-0000-000000001120', // Accounts Receivable
      debitPaise: 0n,
      creditPaise: 2000000n,
    },

    // Entry 6 (Expense 2 - Blocked ITC): Total 420000n capitalized to expense
    {
      id: 'e3000000-0000-0000-0000-000000000017',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000006',
      accountId: 'a0000000-0000-0000-0000-000000005300', // Client Entertainment (Blocked ITC)
      debitPaise: 420000n,
      creditPaise: 0n,
    },
    {
      id: 'e3000000-0000-0000-0000-000000000018',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000006',
      accountId: 'a0000000-0000-0000-0000-000000001110', // HDFC Current Account
      debitPaise: 0n,
      creditPaise: 420000n,
    },

    // Entry 7 (Invoice 3 - Inter-State): Total 9440000n = 8000000n + 1440000n IGST
    {
      id: 'e3000000-0000-0000-0000-000000000019',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000007',
      accountId: 'a0000000-0000-0000-0000-000000001120', // Accounts Receivable
      debitPaise: 9440000n,
      creditPaise: 0n,
    },
    {
      id: 'e3000000-0000-0000-0000-000000000020',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000007',
      accountId: 'a0000000-0000-0000-0000-000000004100', // Design & Consulting Revenue
      debitPaise: 0n,
      creditPaise: 8000000n,
    },
    {
      id: 'e3000000-0000-0000-0000-000000000021',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000007',
      accountId: 'a0000000-0000-0000-0000-000000002130', // Output IGST Liability
      debitPaise: 0n,
      creditPaise: 1440000n,
    },

    // Entry 8 (Expense 3): Total 240000n
    {
      id: 'e3000000-0000-0000-0000-000000000022',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000008',
      accountId: 'a0000000-0000-0000-0000-000000005100', // Office Supplies Expense
      debitPaise: 240000n,
      creditPaise: 0n,
    },
    {
      id: 'e3000000-0000-0000-0000-000000000023',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000008',
      accountId: 'a0000000-0000-0000-0000-000000001110', // HDFC Current Account
      debitPaise: 0n,
      creditPaise: 240000n,
    },

    // Entry 9 (Expense 4): Total 850000n
    {
      id: 'e3000000-0000-0000-0000-000000000024',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000009',
      accountId: 'a0000000-0000-0000-0000-000000005200', // Cloud Infrastructure Expense
      debitPaise: 850000n,
      creditPaise: 0n,
    },
    {
      id: 'e3000000-0000-0000-0000-000000000025',
      businessId,
      journalEntryId: 'e2000000-0000-0000-0000-000000000009',
      accountId: 'a0000000-0000-0000-0000-000000001110', // HDFC Current Account
      debitPaise: 0n,
      creditPaise: 850000n,
    },
  ];

  const businessMemory = [
    {
      id: 'b1000000-0000-0000-0000-000000000001',
      businessId,
      category: 'customer_preference',
      entityKey: 'customer:c0000000-0000-0000-0000-000000000002', // Ravi Traders
      memoryValue: {
        preferredTone: 'polite',
        preferredChannel: 'whatsapp',
        contactName: 'Ravi Chandran',
      },
      confidence: '0.98',
      isActive: true,
    },
  ];

  // Serialized Hash-Chained Audit Logs adhering strictly to computeAuditEntryHash
  const genesisHash = '0000000000000000000000000000000000000000000000000000000000000000';
  let prevHash = genesisHash;

  const rawAuditEntries = [
    {
      id: 'b2000000-0000-0000-0000-000000000001',
      sequenceNumber: 1n,
      requestId: 'req-init-seed-001',
      source: 'mcp_client',
      toolName: 'system_seed',
      action: 'create_business',
      entityType: 'business',
      entityId: businessId,
      payload: { name: business.name, gstin: business.gstin },
      createdAt: new Date('2026-07-01T00:00:00Z'),
    },
    {
      id: 'b2000000-0000-0000-0000-000000000002',
      sequenceNumber: 2n,
      requestId: 'req-init-seed-002',
      source: 'mcp_client',
      toolName: 'create_invoice',
      action: 'issue_invoice',
      entityType: 'invoice',
      entityId: invoices[0]!.id,
      payload: { invoiceNumber: invoices[0]!.invoiceNumber, total: 4720000 },
      createdAt: new Date('2026-07-10T10:00:00Z'),
    },
    {
      id: 'b2000000-0000-0000-0000-000000000003',
      sequenceNumber: 3n,
      requestId: 'req-init-seed-003',
      source: 'mcp_client',
      toolName: 'create_invoice',
      action: 'issue_invoice',
      entityType: 'invoice',
      entityId: invoices[1]!.id,
      payload: { invoiceNumber: invoices[1]!.invoiceNumber, total: 6490000 },
      createdAt: new Date('2026-08-05T10:00:00Z'),
    },
  ];

  const auditLogs = rawAuditEntries.map((entry) => {
    const payloadHash = hashPayload(entry.payload);
    const entryHash = computeAuditEntryHash({
      prevHash,
      sequenceNumber: entry.sequenceNumber,
      timestamp: entry.createdAt,
      action: entry.action,
      entityId: entry.entityId,
      payloadHash,
    });

    const fullLog = {
      id: entry.id,
      businessId,
      sequenceNumber: entry.sequenceNumber,
      requestId: entry.requestId,
      source: entry.source,
      toolName: entry.toolName,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      payloadHash,
      prevHash,
      entryHash,
      createdAt: entry.createdAt,
    };

    prevHash = entryHash;
    return fullLog;
  });

  return {
    generatedOwnerApiKey: ownerApiKey,
    business,
    users,
    customers,
    chartOfAccounts,
    expenseCategories,
    invoices,
    expenses,
    payments,
    journalEntries,
    journalLines,
    businessMemory,
    auditLogs,
  };
}
