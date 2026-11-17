CREATE TABLE "spec_creation_requests" (
	"actor_id" text NOT NULL,
	"backlog_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"node_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_creation_requests_actor_id_backlog_id_key_pk" PRIMARY KEY("actor_id","backlog_id","key")
);
--> statement-breakpoint
ALTER TABLE "spec_creation_requests" ADD CONSTRAINT "spec_creation_requests_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_creation_requests" ADD CONSTRAINT "spec_creation_requests_backlog_id_backlogs_id_fk" FOREIGN KEY ("backlog_id") REFERENCES "public"."backlogs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_creation_requests" ADD CONSTRAINT "spec_creation_requests_node_id_spec_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."spec_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spec_creation_requests_node_idx" ON "spec_creation_requests" USING btree ("node_id");