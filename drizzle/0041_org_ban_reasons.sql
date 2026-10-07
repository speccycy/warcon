CREATE TABLE "org_ban_reasons" (
	"org_id" text PRIMARY KEY NOT NULL,
	"reasons" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_ban_reasons" ADD CONSTRAINT "org_ban_reasons_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;