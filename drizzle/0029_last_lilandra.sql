CREATE TABLE "item_creation_requests" (
	"actor_id" text NOT NULL,
	"backlog_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"item_id" uuid,
	"item_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_creation_requests_actor_id_backlog_id_key_pk" PRIMARY KEY("actor_id","backlog_id","key")
);
--> statement-breakpoint
ALTER TABLE "item_creation_requests" ADD CONSTRAINT "item_creation_requests_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_creation_requests" ADD CONSTRAINT "item_creation_requests_backlog_id_backlogs_id_fk" FOREIGN KEY ("backlog_id") REFERENCES "public"."backlogs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_creation_requests" ADD CONSTRAINT "item_creation_requests_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_creation_requests_item_idx" ON "item_creation_requests" USING btree ("item_id");