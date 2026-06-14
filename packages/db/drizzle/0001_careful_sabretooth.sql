CREATE TABLE "market_resolutions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"venue" text NOT NULL,
	"source" text NOT NULL,
	"result" text,
	"settled_value" double precision,
	"settled_value_unit" text,
	"resolution_date" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
ALTER TABLE "market_resolutions" ADD CONSTRAINT "market_resolutions_market_id_markets_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("market_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "market_resolutions_natural_key_idx" ON "market_resolutions" USING btree ("market_id","source");--> statement-breakpoint
CREATE INDEX "market_resolutions_date_idx" ON "market_resolutions" USING btree ("resolution_date");