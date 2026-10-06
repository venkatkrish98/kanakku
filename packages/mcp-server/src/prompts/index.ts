import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { KanakkuDatabase } from '@kanakku/db';
import { getTenantContext } from '../auth/index.js';

export function registerPrompts(server: McpServer, _db: KanakkuDatabase) {
  // 1. month_end_close
  server.prompt(
    'month_end_close',
    'Interactive workflow prompt guiding the assistant through a comprehensive month-end close with Kanakku.',
    {
      month: z.string().describe('Month to close (1-12)'),
      year: z.string().describe('Calendar year (e.g. 2026)'),
    },
    async (args) => {
      const tenant = getTenantContext();
      return {
        description: `Month-End Close workflow for ${tenant.business.name} (${args.month}/${args.year})`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `You are Kanakku, the trusted financial agent for ${tenant.business.name}.
We need to execute the month-end close for period ${args.month}/${args.year}.

Please follow this exact multi-step process:
1. Call tool "close_month" with step: "scan", month: ${args.month}, year: ${args.year}.
2. Check for any uncategorized expenses or uncollected invoices reported in the scan diagnostics.
3. If clarification is needed, ask the user succinctly. If no anomalies exist, proceed to call "close_month" with step: "prepare_close".
4. Present the complete financial summary (Revenue, Operating Expenses, Net Operating Profit, and Estimated GST Liability) along with the statutory disclaimer.
5. Provide the draft confirmation token and ask the business owner: "Would you like me to lock the books for ${args.month}/${args.year} now?"`,
            },
          },
        ],
      };
    },
  );

  // 2. weekly_briefing
  server.prompt(
    'weekly_briefing',
    'Executive briefing prompt summarizing cash movements, receivables ageing, and recommended collection actions.',
    {},
    async () => {
      const tenant = getTenantContext();
      return {
        description: `Weekly Executive Briefing for ${tenant.business.name}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `You are Kanakku, the financial co-pilot for ${tenant.business.name}.
Generate a comprehensive weekly executive briefing.

Steps:
1. Call "get_business_briefing" with timeframe: "weekly".
2. Call "list_outstanding_invoices" to inspect customer ageing buckets (overdue debt).
3. Call "get_gst_liability" for the current period.
4. Deliver the response in two parts:
   a. Alexa+ Voice Summary: Exactly 1 to 2 conversational, spoken sentences summarizing net cash position and the single most critical action item.
   b. Visual Card Breakdown: Detail cash inflow, aged receivables (1-30, 31-60, 60+ days), and draft payment reminder suggestions for overdue clients.`,
            },
          },
        ],
      };
    },
  );

  // 3. business_briefing
  server.prompt(
    'business_briefing',
    "On-demand daily financial pulse check summarizing today's activity and urgent alerts.",
    {},
    async () => {
      const tenant = getTenantContext();
      return {
        description: `Daily Financial Pulse Check for ${tenant.business.name}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `You are Kanakku, the voice-first financial agent for ${tenant.business.name}.
Provide an immediate executive pulse check for today.

Call tool "get_business_briefing" with timeframe: "today" and call "whats_changed_since" with reference: "last_briefing".
Summarize:
- Total cash received today
- Any new overdue invoices requiring attention
- Quick actions the user can confirm via voice right now.
Keep voice summary concise and strictly within 2 spoken sentences.`,
            },
          },
        ],
      };
    },
  );
}
