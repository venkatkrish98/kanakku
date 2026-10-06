# Kanakku (கணக்கு) — 3-Minute Pitch Video Script & Shot List

> **Track**: Alexa+ (Model Context Protocol / Agentic AI)  
> **Mini Challenge**: AWS Builder  
> **Target Duration**: Exactly 3 Minutes (180 seconds)  
> **Tone**: Confident, empathetic, professional, and product-focused.  

---

## Shot List & Timing Overview

| Timestamp | Segment | Visual / On-Screen Content | Audio / Spoken Script Focus |
| :--- | :--- | :--- | :--- |
| **0:00 - 0:35** | **The Problem** | Montage: Small business owner buried in paper receipts, clunky desktop accounting software, GST calculator spreadsheets. | The painful reality of bookkeeping for 63M Indian MSMEs; why traditional software fails. |
| **0:35 - 1:05** | **The Solution** | Kanakku logo animation (கணக்கு); transition to modern Books Dashboard and clean mobile web interface. | Introducing Kanakku; voice-first financial OS built on institutional double-entry principles. |
| **1:05 - 2:05** | **Live App & MCP in Action** | Screen capture of `/voice` simulator; push-to-talk waveform; MCP tool execution; interactive MCP App Card (`ui://`). | Demonstrating voice invoice creation, GST calculation, and visual approval via Model Context Protocol. |
| **2:05 - 2:40** | **Institutional Rigor & AWS Architecture** | Close-month state machine; period lock error screen; CloudWatch audit trail anchor; AWS architecture diagram. | Double-entry integrity; month-end locking; CloudWatch WORM anchoring; AWS App Runner + RDS. |
| **2:40 - 3:00** | **Vision & Closing** | Smiling business owner concluding month close; final title card with GitHub & Devpost links. | Summary of impact for Bharat; empowering small businesses through voice AI. |

---

## Detailed Script & Director's Notes

### [0:00 - 0:35] Part 1: The Problem — The Burden of Bookkeeping in Bharat
- **Visual**:  
  - Quick cut to Ramesh, an owner of a creative studio in Chennai. He has an open notebook, stacks of crumpled GST receipts, and a frustrating desktop ERP screen showing an "unbalanced trial balance" warning.
- **Voiceover**:  
  *"In India, over 63 million small business owners power nearly a third of the economy. But ask any of them about bookkeeping, and they’ll tell you the same story: it’s exhausting.  
  Traditional accounting software was designed for accountants sitting at desktop computers, not entrepreneurs on the move. Small business owners spend hours manually typing invoices, calculating complex CGST and SGST splits, and chasing late payments.  
  Worse, most mobile bill-tracking apps lack true double-entry accounting—leading to unjournaled expenses, tax filing mistakes, and crippling audit penalties."*

---

### [0:35 - 1:05] Part 2: Introducing Kanakku (கணக்கு) — The Voice-First Bookkeeper
- **Visual**:  
  - Sleek transition to the Kanakku logo. The tagline appears: *The Voice-First AI Financial Operating System for Indian MSMEs*.
  - Show the modern, responsive Books Dashboard at `http://localhost:3000/`.
- **Voiceover**:  
  *"Meet Kanakku. Named after the Tamil word for 'accounts', Kanakku is a voice-first, agentic financial operating system built specifically for Indian MSMEs.  
  Kanakku allows business owners to manage their entire financial lifecycle through natural voice commands in everyday Indian English.  
  It combines conversational simplicity with institutional financial rigor: pure integer-paise math, double-entry general ledgers, and a strict 'Draft -> Confirm -> Execute' safety architecture."*

---

### [1:05 - 2:05] Part 3: Live Demo — Model Context Protocol (MCP) in Action
- **Visual**:  
  - Switch to full-screen screencast of the Alexa+ Voice Simulator at `/voice`.
  - Operator presses Push-to-Talk. The audio waveform pulses smoothly.
  - Spoken Input: *"Issue an invoice to Apex Labs for 50,000 rupees plus 18% GST, due in 15 days."*
  - On-screen: Bedrock Converse parses intent, and calls the MCP tool `create_invoice` on the self-hosted Streamable HTTP MCP server.
  - An interactive **MCP App Card (`ui://invoice/draft`)** renders seamlessly inside the session showing the customer name, HSN code, CGST (₹4,500), SGST (₹4,500), and total ₹59,000.
  - Operator clicks **Approve & Issue** (or says *"Confirm"*).
  - The single-use confirmation token is consumed; journal entries post immediately.
- **Voiceover**:  
  *"Here is Kanakku in action on our Alexa+ web simulator, powered by the official Model Context Protocol (MCP) SDK over Streamable HTTP.  
  When Ramesh says: 'Issue an invoice to Apex Labs for 50,000 rupees plus 18% GST', Amazon Bedrock Converse routes the intent to our self-hosted MCP Server.  
  Instead of guessing, Kanakku calculates the exact GST split using pure TypeScript integer paise math.  
  Using the new MCP Apps extension, Kanakku renders an interactive visual approval card directly in the stream. Nothing touches the general ledger until Ramesh inspects the card and confirms.  
  When he confirms, Kanakku atomically posts balanced debit and credit lines to Accounts Receivable and Sales Revenue."*

---

### [2:05 - 2:40] Part 4: Institutional Rigor, Audit Anchoring & AWS Cloud
- **Visual**:  
  - Operator triggers month close: *"Reconcile and close the month for October."*
  - The multi-step state machine executes (`scan` -> `categorise` -> `reconcile` -> `prepare_close`).
  - Attempting to post a backdated invoice shows: `PERIOD_CLOSED: Books are locked`.
  - Cut to AWS Console / CloudWatch Logs showing the tamper-evident HMAC-SHA256 audit anchor payload in `/kanakku/production/audit-anchors`.
  - Quick animated view of the AWS Architecture: App Runner, RDS PostgreSQL 16 Multi-AZ, Secrets Manager, Bedrock Converse.
- **Voiceover**:  
  *"Kanakku doesn't stop at invoicing. It manages full month-end closures with an automated state machine. Once a month is closed, Kanakku locks the ledger: backdated postings are strictly rejected.  
  To guarantee non-repudiation, the head of our serialized cryptographic hash chain is anchored to Amazon CloudWatch Logs using a durable PostgreSQL transactional outbox. Even a database superuser cannot alter past records without breaking the chain.  
  The entire platform is production-ready on AWS: containerized on AWS App Runner with private VPC egress, Amazon RDS PostgreSQL 16, and AWS Secrets Manager."*

---

### [2:40 - 3:00] Part 5: Impact & Conclusion
- **Visual**:  
  - Cut to the executive briefing dashboard: real-time cashflow metrics, GST liability, and aging receivables.
  - Closing screen displaying project name:  
    **Kanakku (கணக்கு)**  
    *Built for Bharat with Alexa+ MCP & AWS*  
    *GitHub: https://github.com/... | Devpost: amazonappdev2026.devpost.com*
- **Voiceover**:  
  *"What used to take small business owners an entire weekend of stress now takes a thirty-second conversation while walking through their shop floor.  
  By uniting the agentic flexibility of the Model Context Protocol with the reliability of AWS, Kanakku brings institutional-grade bookkeeping to every small enterprise across India.  
  Kanakku: Your books, spoken simply. Thank you."*
