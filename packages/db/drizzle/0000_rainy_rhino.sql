CREATE TABLE "collection_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"collector" text NOT NULL,
	"task" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"records_written" integer DEFAULT 0 NOT NULL,
	"errors" jsonb
);
--> statement-breakpoint
CREATE TABLE "data_quality_checks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" integer,
	"subject" text,
	"check_name" text NOT NULL,
	"passed" boolean NOT NULL,
	"details" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forecasts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"station_id" text,
	"location" text,
	"source" text NOT NULL,
	"target_date" timestamp with time zone NOT NULL,
	"forecast_high_c" double precision,
	"forecast_low_c" double precision,
	"variables" jsonb,
	"forecast_run_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "market_price_history" (
	"token_id" text NOT NULL,
	"t" timestamp with time zone NOT NULL,
	"price" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"yes_price" double precision,
	"no_price" double precision,
	"best_bid" double precision,
	"best_ask" double precision,
	"midpoint" double precision,
	"spread" double precision,
	"volume" double precision,
	"liquidity" double precision,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"market_id" text PRIMARY KEY NOT NULL,
	"venue" text DEFAULT 'polymarket' NOT NULL,
	"slug" text,
	"question" text,
	"event_title" text,
	"location" text,
	"resolution_date" timestamp with time zone,
	"resolution_station" text,
	"resolution_source" text,
	"resolution_url" text,
	"resolution_rules" text,
	"threshold" text,
	"contract_structure" text,
	"is_temperature_market" boolean DEFAULT false NOT NULL,
	"clob_token_ids" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"source" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"temp_c" double precision,
	"is_hourly" boolean DEFAULT true NOT NULL,
	"daily_max_temp_c" double precision,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "orderbook_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"token_id" text NOT NULL,
	"bids" jsonb NOT NULL,
	"asks" jsonb NOT NULL,
	"hash" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weather_stations" (
	"station_id" text PRIMARY KEY NOT NULL,
	"name" text,
	"lat" double precision,
	"lon" double precision,
	"source" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "market_snapshots_market_id_markets_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("market_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orderbook_snapshots" ADD CONSTRAINT "orderbook_snapshots_market_id_markets_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("market_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_runs_collector_idx" ON "collection_runs" USING btree ("collector","started_at");--> statement-breakpoint
CREATE INDEX "dq_check_name_idx" ON "data_quality_checks" USING btree ("check_name","checked_at");--> statement-breakpoint
CREATE INDEX "forecasts_station_target_idx" ON "forecasts" USING btree ("station_id","target_date");--> statement-breakpoint
CREATE INDEX "forecasts_fetched_idx" ON "forecasts" USING btree ("fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "price_history_token_t_idx" ON "market_price_history" USING btree ("token_id","t");--> statement-breakpoint
CREATE INDEX "market_snapshots_market_time_idx" ON "market_snapshots" USING btree ("market_id","captured_at");--> statement-breakpoint
CREATE INDEX "markets_is_temp_idx" ON "markets" USING btree ("is_temperature_market");--> statement-breakpoint
CREATE INDEX "markets_resolution_date_idx" ON "markets" USING btree ("resolution_date");--> statement-breakpoint
CREATE INDEX "markets_venue_idx" ON "markets" USING btree ("venue");--> statement-breakpoint
CREATE INDEX "observations_station_time_idx" ON "observations" USING btree ("station_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "observations_natural_key_idx" ON "observations" USING btree ("station_id","source","observed_at","is_hourly");--> statement-breakpoint
CREATE INDEX "orderbook_token_time_idx" ON "orderbook_snapshots" USING btree ("token_id","captured_at");