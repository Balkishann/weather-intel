import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "./logger.js";

export interface RateLimitOptions {
  /** Minimum milliseconds between requests to the same host. */
  minIntervalMs?: number;
  /** Max retry attempts on transient failures (429/5xx/network). */
  maxRetries?: number;
  /** Base backoff in ms (doubled each attempt, with jitter). */
  baseBackoffMs?: number;
  /** Default headers added to every request (e.g. User-Agent). */
  defaultHeaders?: Record<string, string>;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Minimal HTTP client with per-host serialised rate limiting and exponential backoff.
 * Built on native fetch. One instance per upstream API keeps limits isolated.
 */
export class HttpClient {
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly hostQueues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly log: Logger,
    opts: RateLimitOptions = {},
  ) {
    this.minIntervalMs = opts.minIntervalMs ?? 200;
    this.maxRetries = opts.maxRetries ?? 4;
    this.baseBackoffMs = opts.baseBackoffMs ?? 500;
    this.defaultHeaders = opts.defaultHeaders ?? {};
  }

  /** GET and parse JSON. Throws after retries are exhausted. */
  async getJson<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.request(url, opts);
    return (await res.json()) as T;
  }

  /** Raw request with rate limiting + retries. */
  async request(url: string, opts: RequestOptions = {}): Promise<Response> {
    const host = new URL(url).host;
    // Serialise per host so minIntervalMs is honoured even under concurrency.
    const prev = this.hostQueues.get(host) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(() => this.executeWithRetry(url, opts, host));
    this.hostQueues.set(
      host,
      run.then(() => sleep(this.minIntervalMs)).catch(() => undefined),
    );
    return run;
  }

  private async executeWithRetry(
    url: string,
    opts: RequestOptions,
    host: string,
  ): Promise<Response> {
    let attempt = 0;
    for (;;) {
      try {
        const res = await this.fetchOnce(url, opts);
        if (res.ok) return res;
        if (RETRYABLE_STATUS.has(res.status) && attempt < this.maxRetries) {
          const wait = this.backoff(attempt, res.headers.get("retry-after"));
          this.log.warn(
            { url, status: res.status, attempt, waitMs: wait },
            "retryable HTTP status, backing off",
          );
          await sleep(wait);
          attempt++;
          continue;
        }
        const body = await res.text().catch(() => "");
        throw new Error(
          `HTTP ${res.status} for ${url}: ${body.slice(0, 300)}`,
        );
      } catch (err) {
        const isAbortOrNetwork =
          err instanceof Error &&
          !err.message.startsWith("HTTP ") /* not our thrown status error */;
        if (isAbortOrNetwork && attempt < this.maxRetries) {
          const wait = this.backoff(attempt, null);
          this.log.warn(
            { url, host, attempt, waitMs: wait, err: (err as Error).message },
            "network error, backing off",
          );
          await sleep(wait);
          attempt++;
          continue;
        }
        throw err;
      }
    }
  }

  private async fetchOnce(url: string, opts: RequestOptions): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? 20_000,
    );
    try {
      return await fetch(url, {
        headers: { ...this.defaultHeaders, ...opts.headers },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs)) return Math.min(secs * 1000, 60_000);
    }
    const expo = this.baseBackoffMs * 2 ** attempt;
    const jitter = Math.random() * this.baseBackoffMs;
    return Math.min(expo + jitter, 60_000);
  }
}
