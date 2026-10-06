CREATE TABLE "audit_anchor_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"target_entity_type" text NOT NULL,
	"target_entity_id" uuid NOT NULL,
	"audit_sequence_number" bigint NOT NULL,
	"head_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"idempotency_key" text,
	"sink_identifier" text,
	"receipt_payload" jsonb,
	"last_error" text,
	"anchored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_audit_anchor_outbox_biz_entity" UNIQUE("business_id","target_entity_type","target_entity_id")
);
--> statement-breakpoint
ALTER TABLE "audit_anchor_outbox" ADD CONSTRAINT "audit_anchor_outbox_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;