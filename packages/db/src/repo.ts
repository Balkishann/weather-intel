import { sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  collectionRuns,
  dataQualityChecks,
  forecasts,
  marketResolutions,
  marketSnapshots,
  marketPriceHistory,
  markets,
  observations,
  orderbookSnapshots,
  weatherStations,
} from "./schema.js";

type Insert<T extends { $inferInsert: unknown }> = T["$inferInsert"];

/**
 * Thin data-access helpers. Snapshot/observation/forecast inserts are append-only.
 * `markets` and `weather_stations` upsert on identity (dimension tables).
 */
export class Repo {
  constructor(private readonly db: Database) {}

  /**
   * Retry a DB op on transient connection drops. Neon terminates idle pooled connections
   * (e.g. during a collector's long HTTP fetch phase), so the first query after an idle gap
   * can reject with "Connection terminated unexpectedly" / ECONNRESET. The dead client is
   * evicted by the pool's error handler, so a retry simply gets a fresh connection.
   */
  private async withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const msg = (err as Error)?.message ?? "";
        const transient =
          /Connection terminated|ECONNRESET|terminating connection|server closed the connection|socket hang up|Client has encountered a connection error/i.test(
            msg,
          );
        if (!transient || i === attempts - 1) throw err;
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
    }
    throw lastErr;
  }

  // --- audit ---
  // These wrap each write in withRetry like the snapshot/forecast inserts: a weather cycle
  // keeps a connection idle for ~9 min during the HTTP forecast phase, so the trailing
  // finishRun/recordChecks land exactly when Neon is most likely to have dropped the pooled
  // connection. Without the retry a transient drop here throws unhandled → process.exit(1).
  async startRun(collector: string, task: string): Promise<number> {
    return this.withRetry(async () => {
      const [row] = await this.db
        .insert(collectionRuns)
        .values({ collector, task })
        .returning({ id: collectionRuns.id });
      return row!.id;
    });
  }

  async finishRun(
    id: number,
    status: "ok" | "error",
    recordsWritten: number,
    errors?: unknown,
  ): Promise<void> {
    await this.withRetry(() =>
      this.db
        .update(collectionRuns)
        .set({
          status,
          recordsWritten,
          finishedAt: new Date(),
          errors: errors ? (errors as object) : null,
        })
        .where(sql`${collectionRuns.id} = ${id}`),
    );
  }

  async recordChecks(
    runId: number,
    rows: { subject?: string; checkName: string; passed: boolean; details?: string }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    // Chunked: a single multi-row insert of many checks (e.g. one per settled market) can
    // exceed Postgres's 65,535 bind-parameter limit, which surfaces as the misleading
    // "bind message has N parameter formats but 0 parameters" error.
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await this.withRetry(() =>
        this.db.insert(dataQualityChecks).values(chunk.map((r) => ({ runId, ...r }))),
      );
    }
  }

  // --- dimensions (upsert on identity) ---
  async upsertMarket(m: Insert<typeof markets>): Promise<void> {
    await this.db
      .insert(markets)
      .values(m)
      .onConflictDoUpdate({
        target: markets.marketId,
        set: {
          venue: m.venue,
          slug: m.slug,
          question: m.question,
          eventTitle: m.eventTitle,
          location: m.location,
          resolutionDate: m.resolutionDate,
          resolutionStation: m.resolutionStation,
          resolutionSource: m.resolutionSource,
          resolutionUrl: m.resolutionUrl,
          resolutionRules: m.resolutionRules,
          threshold: m.threshold,
          contractStructure: m.contractStructure,
          isTemperatureMarket: m.isTemperatureMarket,
          clobTokenIds: m.clobTokenIds,
          lastSeenAt: new Date(),
          raw: m.raw,
        },
      });
  }

  /**
   * Bulk upsert markets in chunks. Same identity-update semantics as {@link upsertMarket},
   * but a handful of multi-row statements instead of one round-trip per market — discovery
   * of ~500 markets drops from minutes of serial Neon round-trips to seconds.
   */
  async upsertMarkets(rows: Insert<typeof markets>[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      await this.withRetry(() =>
        this.db
        .insert(markets)
        .values(chunk)
        .onConflictDoUpdate({
          target: markets.marketId,
          set: {
            venue: sql`excluded.venue`,
            slug: sql`excluded.slug`,
            question: sql`excluded.question`,
            eventTitle: sql`excluded.event_title`,
            location: sql`excluded.location`,
            resolutionDate: sql`excluded.resolution_date`,
            resolutionStation: sql`excluded.resolution_station`,
            resolutionSource: sql`excluded.resolution_source`,
            resolutionUrl: sql`excluded.resolution_url`,
            resolutionRules: sql`excluded.resolution_rules`,
            threshold: sql`excluded.threshold`,
            contractStructure: sql`excluded.contract_structure`,
            isTemperatureMarket: sql`excluded.is_temperature_market`,
            clobTokenIds: sql`excluded.clob_token_ids`,
            lastSeenAt: new Date(),
            raw: sql`excluded.raw`,
          },
        }),
      );
    }
  }

  async upsertStation(s: Insert<typeof weatherStations>): Promise<void> {
    await this.withRetry(() =>
      this.db
        .insert(weatherStations)
        .values(s)
        .onConflictDoNothing({ target: weatherStations.stationId }),
    );
  }

  // --- append-only inserts ---
  async insertMarketSnapshot(s: Insert<typeof marketSnapshots>): Promise<void> {
    await this.db.insert(marketSnapshots).values(s);
  }

  async insertOrderbookSnapshot(s: Insert<typeof orderbookSnapshots>): Promise<void> {
    await this.db.insert(orderbookSnapshots).values(s);
  }

  /**
   * Bulk append market snapshots in chunks. Collecting all rows in memory then writing
   * them in a few multi-row inserts keeps DB connections busy only briefly — avoids the
   * idle-connection drops Neon triggers when inserts are interleaved with slow HTTP calls.
   */
  async insertMarketSnapshots(rows: Insert<typeof marketSnapshots>[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      await this.withRetry(() => this.db.insert(marketSnapshots).values(chunk));
    }
  }

  async insertOrderbookSnapshots(rows: Insert<typeof orderbookSnapshots>[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      await this.withRetry(() => this.db.insert(orderbookSnapshots).values(chunk));
    }
  }

  async insertForecast(f: Insert<typeof forecasts>): Promise<void> {
    await this.withRetry(() => this.db.insert(forecasts).values(f));
  }

  /** Observations have a natural-key unique index; ignore exact duplicates. */
  async insertObservation(o: Insert<typeof observations>): Promise<void> {
    await this.withRetry(() =>
      this.db.insert(observations).values(o).onConflictDoNothing(),
    );
  }

  async insertPriceHistory(rows: Insert<typeof marketPriceHistory>[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(marketPriceHistory).values(rows).onConflictDoNothing();
  }

  /**
   * Append settled-market resolutions, idempotent on the (market_id, source) natural key.
   * onConflictDoNothing preserves the first-recorded settlement (append-only): re-runs of
   * the resolutions collector never overwrite a market's recorded outcome.
   */
  async insertMarketResolutions(rows: Insert<typeof marketResolutions>[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      await this.withRetry(() =>
        this.db
          .insert(marketResolutions)
          .values(chunk)
          .onConflictDoNothing({
            target: [marketResolutions.marketId, marketResolutions.source],
          }),
      );
    }
  }

  /** Market ids already resolved from a given source (to skip re-fetching settled detail). */
  async resolvedMarketIds(source: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ marketId: marketResolutions.marketId })
      .from(marketResolutions)
      .where(sql`${marketResolutions.source} = ${source}`);
    return new Set(rows.map((r) => r.marketId));
  }

  /** Markets we poll at high frequency for prices/order books. */
  async temperatureMarkets() {
    return this.db
      .select()
      .from(markets)
      .where(sql`${markets.isTemperatureMarket} = true`);
  }

  /** Distinct resolution stations referenced by temperature markets. */
  async temperatureStations(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ station: markets.resolutionStation })
      .from(markets)
      .where(
        sql`${markets.isTemperatureMarket} = true and ${markets.resolutionStation} is not null`,
      );
    return rows.map((r) => r.station).filter((s): s is string => s !== null);
  }

  /** Distinct cities (with their named station) referenced by temperature markets. */
  async temperatureLocations(): Promise<
    { location: string; resolutionStation: string | null }[]
  > {
    const rows = await this.db
      .selectDistinct({
        location: markets.location,
        resolutionStation: markets.resolutionStation,
      })
      .from(markets)
      .where(
        sql`${markets.isTemperatureMarket} = true and ${markets.location} is not null`,
      );
    return rows
      .filter((r): r is { location: string; resolutionStation: string | null } =>
        r.location !== null,
      );
  }
}
