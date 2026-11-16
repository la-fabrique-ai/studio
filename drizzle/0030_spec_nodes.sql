CREATE TYPE "public"."spec_node_kind" AS ENUM('folder', 'document');--> statement-breakpoint
CREATE TABLE "spec_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"backlog_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"action" "activity_action" NOT NULL,
	"field" text,
	"old_value" text,
	"new_value" text,
	"request_correlation_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" "activity_source" DEFAULT 'ui' NOT NULL,
	"token_id" uuid
);
--> statement-breakpoint
CREATE TABLE "spec_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"backlog_id" uuid NOT NULL,
	"parent_id" uuid,
	"kind" "spec_node_kind" NOT NULL,
	"title" text NOT NULL,
	"content" text,
	"rank" text NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "spec_nodes_not_own_parent" CHECK ("spec_nodes"."parent_id" is null or "spec_nodes"."parent_id" <> "spec_nodes"."id"),
	CONSTRAINT "spec_nodes_folder_has_no_content" CHECK ("spec_nodes"."kind" = 'document' or "spec_nodes"."content" is null),
	CONSTRAINT "spec_nodes_title_length" CHECK (char_length("spec_nodes"."title") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "spec_activities" ADD CONSTRAINT "spec_activities_node_id_spec_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."spec_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_activities" ADD CONSTRAINT "spec_activities_backlog_id_backlogs_id_fk" FOREIGN KEY ("backlog_id") REFERENCES "public"."backlogs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_activities" ADD CONSTRAINT "spec_activities_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_activities" ADD CONSTRAINT "spec_activities_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_nodes" ADD CONSTRAINT "spec_nodes_backlog_id_backlogs_id_fk" FOREIGN KEY ("backlog_id") REFERENCES "public"."backlogs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_nodes" ADD CONSTRAINT "spec_nodes_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_nodes" ADD CONSTRAINT "spec_nodes_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The self-reference needs its unique target index first.
CREATE UNIQUE INDEX "spec_nodes_backlog_id_idx" ON "spec_nodes" USING btree ("backlog_id","id");--> statement-breakpoint
ALTER TABLE "spec_nodes" ADD CONSTRAINT "spec_nodes_parent_same_backlog_fk" FOREIGN KEY ("backlog_id","parent_id") REFERENCES "public"."spec_nodes"("backlog_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spec_activities_node_at_idx" ON "spec_activities" USING btree ("node_id","at");--> statement-breakpoint
CREATE INDEX "spec_nodes_backlog_parent_rank_idx" ON "spec_nodes" USING btree ("backlog_id","parent_id","rank");--> statement-breakpoint
-- Every existing backlog starts with the BMAD folders, as new ones do.
INSERT INTO "spec_nodes" ("backlog_id", "kind", "title", "rank")
SELECT b."id", 'folder', d."title", d."rank"
  FROM "backlogs" b
 CROSS JOIN (VALUES ('Brief', 'a0'), ('PRD', 'a1'), ('UX', 'a2')) AS d("title", "rank");
