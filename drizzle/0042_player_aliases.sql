CREATE TABLE "player_aliases" (
	"server_id" text NOT NULL,
	"steam_id" text NOT NULL,
	"name" text NOT NULL,
	"holder" text,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	CONSTRAINT "player_aliases_server_id_steam_id_name_pk" PRIMARY KEY("server_id","steam_id","name")
);
--> statement-breakpoint
CREATE INDEX "player_aliases_steam_idx" ON "player_aliases" USING btree ("steam_id");