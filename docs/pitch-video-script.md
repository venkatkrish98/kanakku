# Kanakku (கணக்கு) — Pitch Video Script & Shot List (2m 48s)

> **Track**: Alexa+ (Model Context Protocol / Agentic AI)  
> **Mini Challenge**: AWS Builder  
> **Target Duration**: 2 Minutes 48 Seconds (168s — strictly under Devpost 3-minute limit)  
> **Architecture Clarification**: Self-hosted Model Context Protocol (MCP) server paired with an interactive Alexa+ Conversational Experience Simulator (as participants do not have access to unreleased private Alexa+ developer tools).  
> **Tone**: Confident, empathetic, professional, and product-focused.  
> **Language**: English (Public on YouTube/Vimeo).

---

## Shot List & Timing Overview

| Timestamp       | Segment                                    | Visual / On-Screen Content                                                                                                                    | Audio / Spoken Script Focus                                                                                           |
| :-------------- | :----------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------- |
| **0:00 - 0:30** | **The Problem**                            | Montage: Small business owner buried in paper receipts, clunky desktop accounting software, GST calculator spreadsheets.                      | The painful reality of bookkeeping for 63M Indian MSMEs; why traditional software fails.                              |
| **0:30 - 0:55** | **The Solution**                           | Kanakku logo animation (கணக்கு); transition to modern Books Dashboard and clean web interface.                                                | Introducing Kanakku; voice-first financial OS built on institutional double-entry principles.                         |
| **0:55 - 1:55** | **Live App & MCP in Action**               | Screen capture of Alexa+ Simulator (`/voice`); push-to-talk waveform; MCP Streamable HTTP tool execution; interactive MCP App Card (`ui://`). | Demonstrating voice invoice creation, GST calculation, and visual approval via Model Context Protocol.                |
| **1:55 - 2:30** | **Institutional Rigor & AWS Architecture** | Close-month state machine; period lock error screen; CloudWatch audit trail anchor; AWS architecture diagram.                                 | Double-entry integrity; month-end locking; CloudWatch append-only audit anchoring; AWS App Runner + RDS architecture. |
| **2:30 - 2:48** | **Vision & Closing**                       | Executive briefing cards; closing title card with live GitHub repository & Devpost links.                                                     | Summary of impact for Bharat; empowering small businesses through voice AI.                                           |

---

## Detailed Script & Director's Notes

### [0:00 - 0:30] Part 1: The Problem — The Burden of Bookkeeping in Bharat

- **Visual**:
  - Quick cut to Ramesh, an owner of a creative studio in Chennai. He has an open notebook, stacks of crumpled GST receipts, and a frustrating desktop ERP screen showing an "unbalanced trial balance" warning.
- **Voiceover**:  
  _"In India, over 63 million small businesses power a third of the economy. But bookkeeping is exhausting.  
  Traditional accounting software was designed for desktop accountants, not active entrepreneurs. Business owners spend hours typing invoices, calculating complex CGST and SGST splits, and chasing late receivables.  
  Worse, bill-tracking apps lack true double-entry bookkeeping—leading to unjournaled expenses, tax errors, and painful audit penalties."_

---

### [0:30 - 0:55] Part 2: Introducing Kanakku (கணக்கு) — The Voice-First Bookkeeper

- **Visual**:
  - Sleek transition to the Kanakku logo. The tagline appears: _Voice-First AI Financial Operating System for Indian MSMEs_.
  - Show the modern, responsive Books Dashboard at `http://localhost:3000/`.
- **Voiceover**:  
  _"Meet Kanakku—named after the Tamil word for 'accounts'. Kanakku is a voice-first, agentic financial operating system built specifically for Indian MSMEs.  
  Kanakku allows business owners to manage their entire financial lifecycle through natural voice commands in everyday Indian English.  
  It unites conversational simplicity with institutional accounting rigor: pure integer-paise math, double-entry general ledgers, and a strict 'Draft -> Confirm -> Execute' safety architecture."_

---

### [0:55 - 1:55] Part 3: Live Demo — Model Context Protocol (MCP) in Action

- **Visual**:
  - Switch to full-screen screencast of the Alexa+ Voice Simulator at `/voice`.
  - Operator presses Push-to-Talk. The audio waveform pulses smoothly.
  - Spoken Input: _"Issue an invoice to Apex Labs for 50,000 rupees plus 18% GST, due in 15 days."_
  - On-screen: Bedrock Converse parses intent and dispatches the `create_invoice` tool call to our self-hosted Streamable HTTP MCP server.
  - An interactive **MCP App Card (`ui://cards/invoice-draft`)** renders seamlessly inside the session showing the customer name, HSN code, CGST (₹4,500), SGST (₹4,500), and total ₹59,000.
  - Operator clicks **Approve & Issue** (or says _"Confirm"_).
  - The single-use confirmation token is consumed; journal entries post immediately.
- **Voiceover**:  
  _"Here is Kanakku in action on our Alexa+ web simulator, powered by a self-hosted Model Context Protocol server over Streamable HTTP.  
  When Ramesh says: 'Issue an invoice to Apex Labs for 50,000 rupees plus 18% GST', Amazon Bedrock Converse routes the intent directly to our self-hosted MCP Server.  
  Kanakku calculates the exact GST split using pure TypeScript integer paise math.  
  Using the new MCP Apps extension, Kanakku renders an interactive visual approval card directly in the stream. Nothing touches the general ledger until Ramesh inspects the card and confirms.  
  Upon confirmation, Kanakku atomically posts balanced debit and credit lines to Accounts Receivable and Sales Revenue."_

---

### [1:55 - 2:30] Part 4: Institutional Rigor, Audit Anchoring & AWS Cloud

- **Visual**:
  - Operator triggers month close: _"Reconcile and close the month for October."_
  - The multi-step state machine executes (`scan` -> `categorise` -> `reconcile` -> `prepare_close`).
  - Attempting to post a backdated invoice shows: `PERIOD_CLOSED: Books are locked`.
  - Cut to AWS CloudWatch Logs showing the tamper-evident HMAC-SHA256 audit anchor payload in `/kanakku/production/audit-anchors`.
  - Quick view of AWS Architecture: App Runner, RDS PostgreSQL 16 Multi-AZ, Secrets Manager, Bedrock Converse.
- **Voiceover**:  
  _"Kanakku doesn't stop at invoicing. It manages full month-end closures with an automated state machine. Once a month is closed, Kanakku locks the ledger: backdated postings are strictly rejected.  
  To provide external tamper-evidence, the head of our serialized cryptographic hash chain is anchored to Amazon CloudWatch Logs using a durable PostgreSQL transactional outbox.  
  The entire platform is architected and packaged for production on AWS: declarative Terraform infrastructure for AWS App Runner, private VPC egress to Amazon RDS PostgreSQL 16, and AWS Secrets Manager."_

---

### [2:30 - 2:48] Part 5: Impact & Conclusion

- **Visual**:
  - Cut to the executive briefing dashboard: real-time cashflow metrics, GST liability, and aging receivables.
  - Closing screen displaying project name:  
    **Kanakku (கணக்கு)**  
    _Built for Bharat with Alexa+ MCP & AWS_  
    _GitHub: https://github.com/venkatkrish98/kanakku_  
    _Devpost: amazonappdev2026.devpost.com_
- **Voiceover**:  
  _"What used to take small business owners an entire weekend of stress now takes a thirty-second conversation on the shop floor.  
  By uniting the agentic flexibility of the Model Context Protocol with the reliability of AWS, Kanakku brings institutional-grade bookkeeping to every small enterprise across India.  
  Kanakku: Your books, spoken simply."_
