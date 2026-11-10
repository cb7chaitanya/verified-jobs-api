import { lookup } from "node:dns/promises";
import { lookup as lookupCb, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { log } from "../log";

/**
 * Polite HTTP client for external sources:
 *  - per-host minimum interval (rate limit; honors robots Crawl-delay)
 *  - bounded retries with exponential backoff + jitter for 429/5xx/network
 *  - honors Retry-After / x-rate-limit-reset
 *  - timeouts and response size cap
 *  - robots.txt enforcement for page fetches
 *  - SSRF guard for user-supplied URLs
 */

export interface HttpResponse {
  status: number;
  ok: boolean;
  url: string; // final URL after redirects
  redirected: boolean;
  headers: Headers;
  text: string;
  ms: number;
  attempts: number;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly kind: "NETWORK" | "TIMEOUT" | "RATE_LIMITED" | "SERVER" | "ROBOTS" | "BLOCKED_URL" | "TOO_LARGE",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
  /** "page" enforces robots.txt; "api" is a documented API endpoint. */
  purpose?: "api" | "page";
  /** Guard against SSRF for user-supplied URLs. */
  untrustedUrl?: boolean;
  maxAttempts?: number;
  timeoutMs?: number;
  /** Internal: redirects still allowed and absolute deadline for an untrusted chain. */
  redirectsLeft?: number;
  deadline?: number;
}

const MAX_REDIRECTS = 5;
const CHAIN_DEADLINE_MS = 30_000;

type FetchImpl = typeof fetch;

const MAX_BYTES = 8 * 1024 * 1024;

export class HttpClient {
  private nextSlot = new Map<string, number>();
  private robotsCache = new Map<string, { rules: RobotsRules; fetchedAt: number }>();

  constructor(
    private readonly opts: {
      userAgent: string;
      minIntervalMs?: number;
      fetchImpl?: FetchImpl;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
      /** SSRF host check for untrusted URLs (defaults to DNS-based assertPublicHost; tests inject a stub). */
      assertHost?: (hostname: string) => Promise<void>;
    },
  ) {}

  private get fetchImpl(): FetchImpl {
    return this.opts.fetchImpl ?? fetch;
  }
  /** Untrusted URLs connect only to addresses the guard approved at connect time (no DNS-rebinding window). */
  private fetchFor(untrusted: boolean | undefined): FetchImpl {
    if (this.opts.fetchImpl || !untrusted) return this.fetchImpl;
    return ((input: string, init: RequestInit) => undiciFetch(input, { ...(init as object), dispatcher: guardedAgent() })) as unknown as FetchImpl;
  }
  private sleep(ms: number) {
    return (this.opts.sleep ?? ((m: number) => new Promise((r) => setTimeout(r, m))))(ms);
  }
  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private async throttle(host: string, crawlDelayMs = 0): Promise<void> {
    const interval = Math.max(this.opts.minIntervalMs ?? 1000, crawlDelayMs);
    const now = this.now();
    const slot = Math.max(now, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, slot + interval);
    if (slot > now) await this.sleep(slot - now);
  }

  async request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new HttpError("Unsupported protocol", "BLOCKED_URL");
    if (options.untrustedUrl) {
      await (this.opts.assertHost ?? assertPublicHost)(u.hostname);
      if (options.deadline && this.now() > options.deadline) throw new HttpError("Request took too long", "TIMEOUT");
    }

    let crawlDelay = 0;
    if (options.purpose === "page") {
      const robots = await this.robotsFor(u, options.untrustedUrl);
      if (!robots.isAllowed(u.pathname + u.search)) {
        throw new HttpError(`Disallowed by robots.txt for ${u.host}`, "ROBOTS");
      }
      crawlDelay = (robots.crawlDelay ?? 0) * 1000;
    }

    const maxAttempts = Math.min(options.maxAttempts ?? 3, 5);
    let lastErr: HttpError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.throttle(u.host, crawlDelay);
      const started = this.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
      try {
        const res = await this.fetchFor(options.untrustedUrl)(url, {
          method: options.method ?? "GET",
          headers: { "User-Agent": this.opts.userAgent, Accept: "application/json, text/html;q=0.9, */*;q=0.5", ...options.headers },
          body: options.body,
          redirect: options.untrustedUrl ? "manual" : "follow",
          signal: controller.signal,
        });
        // Manual redirect handling for untrusted URLs: re-check each hop.
        if (options.untrustedUrl && res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          const next = new URL(res.headers.get("location")!, url).toString();
          clearTimeout(timer);
          const left = options.redirectsLeft ?? MAX_REDIRECTS;
          if (left <= 0) throw new HttpError("Too many redirects", "BLOCKED_URL", res.status);
          const deadline = options.deadline ?? started + CHAIN_DEADLINE_MS;
          const followed = await this.request(next, { ...options, maxAttempts: 1, redirectsLeft: left - 1, deadline });
          return { ...followed, redirected: true };
        }
        const len = Number(res.headers.get("content-length") ?? "0");
        if (len > MAX_BYTES) throw new HttpError("Response too large", "TOO_LARGE", res.status);
        const text = await readCapped(res, MAX_BYTES, controller);
        const ms = this.now() - started;
        if (res.status === 429 || res.status >= 500) {
          const wait = retryAfterMs(res.headers, this.now()) ?? backoffMs(attempt);
          lastErr = new HttpError(`HTTP ${res.status}`, res.status === 429 ? "RATE_LIMITED" : "SERVER", res.status);
          log.warn({ url: u.origin + u.pathname, status: res.status, attempt, wait }, "retryable response");
          if (attempt < maxAttempts && wait <= 60_000) {
            await this.sleep(wait);
            continue;
          }
          throw lastErr;
        }
        return { status: res.status, ok: res.ok, url: res.url || url, redirected: res.redirected, headers: res.headers, text, ms, attempts: attempt };
      } catch (e) {
        if (e instanceof HttpError) throw e;
        const aborted = (e as Error).name === "AbortError";
        lastErr = new HttpError(aborted ? "Request timed out" : `Network error: ${(e as Error).message}`, aborted ? "TIMEOUT" : "NETWORK");
        if (attempt < maxAttempts) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw lastErr;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr ?? new HttpError("Request failed", "NETWORK");
  }

  async json<T = unknown>(url: string, options: RequestOptions = {}): Promise<{ res: HttpResponse; data: T | null }> {
    const res = await this.request(url, { purpose: "api", ...options });
    if (!res.ok) return { res, data: null };
    try {
      return { res, data: JSON.parse(res.text) as T };
    } catch {
      throw new HttpError(`Invalid JSON from ${new URL(url).host}`, "SERVER", res.status);
    }
  }

  /**
   * robots.txt goes through the same guarded path as the page itself: host check
   * per redirect hop, pinned connect for untrusted URLs, timeout and size cap.
   */
  async robotsFor(u: URL, untrusted = false): Promise<RobotsRules> {
    const cached = this.robotsCache.get(u.origin);
    if (cached && this.now() - cached.fetchedAt < 24 * 3_600_000) return cached.rules;
    let rules: RobotsRules;
    try {
      const res = await this.request(`${u.origin}/robots.txt`, { purpose: "api", untrustedUrl: untrusted, maxAttempts: 1, timeoutMs: 10_000, headers: { Accept: "text/plain, */*;q=0.5" } });
      if (res.status >= 400 && res.status < 500) rules = RobotsRules.allowAll();
      else if (!res.ok) rules = RobotsRules.disallowAll(); // 5xx: assume disallowed (RFC 9309 §2.3.1.4)
      else rules = RobotsRules.parse(res.text.slice(0, 512 * 1024), "verified-jobs-api");
    } catch {
      rules = RobotsRules.disallowAll();
    }
    if (this.robotsCache.size > 2_000) this.robotsCache.delete(this.robotsCache.keys().next().value!);
    this.robotsCache.set(u.origin, { rules, fetchedAt: this.now() });
    return rules;
  }
}

export function backoffMs(attempt: number): number {
  const base = 1000 * 2 ** (attempt - 1);
  return Math.min(30_000, base + Math.floor(Math.random() * 250));
}

export function retryAfterMs(headers: Headers, now: number): number | null {
  const ra = headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const d = Date.parse(ra);
    if (!Number.isNaN(d)) return Math.max(0, d - now);
  }
  const reset = headers.get("x-rate-limit-reset") ?? headers.get("x-ratelimit-reset");
  if (reset) {
    const n = Number(reset);
    if (Number.isFinite(n)) return n > 1e9 ? Math.max(0, n * 1000 - now) : n * 1000;
  }
  return null;
}

// ---------------------------------------------------------------------------
// robots.txt (RFC 9309 subset: groups, Allow/Disallow longest match, * and $)
// ---------------------------------------------------------------------------

export class RobotsRules {
  constructor(
    private readonly rules: { allow: boolean; pattern: string }[],
    public readonly crawlDelay: number | null,
  ) {}

  static allowAll() {
    return new RobotsRules([], null);
  }
  static disallowAll() {
    return new RobotsRules([{ allow: false, pattern: "/" }], null);
  }

  static parse(txt: string, agent: string): RobotsRules {
    type Group = { agents: string[]; rules: { allow: boolean; pattern: string }[]; delay: number | null };
    const groups: Group[] = [];
    let cur: Group | null = null;
    let lastWasAgent = false;
    for (const rawLine of txt.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*/, "").trim();
      if (!line) continue;
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (key === "user-agent") {
        if (!cur || !lastWasAgent) {
          cur = { agents: [], rules: [], delay: null };
          groups.push(cur);
        }
        cur.agents.push(value.toLowerCase());
        lastWasAgent = true;
        continue;
      }
      lastWasAgent = false;
      if (!cur) continue;
      if (key === "allow" || key === "disallow") {
        if (value === "" && key === "disallow") continue; // empty disallow = allow all
        cur.rules.push({ allow: key === "allow", pattern: value });
      } else if (key === "crawl-delay") {
        const n = Number(value);
        if (Number.isFinite(n)) cur.delay = n;
      }
    }
    const a = agent.toLowerCase();
    const specific = groups.filter((g) => g.agents.some((x) => x !== "*" && a.includes(x)));
    const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
    return new RobotsRules(
      chosen.flatMap((g) => g.rules),
      chosen.find((g) => g.delay !== null)?.delay ?? null,
    );
  }

  isAllowed(path: string): boolean {
    let best: { allow: boolean; len: number } | null = null;
    for (const r of this.rules) {
      if (matchRobots(r.pattern, path)) {
        const len = r.pattern.length;
        if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
      }
    }
    return best ? best.allow : true;
  }
}

function matchRobots(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const p = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp("^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
  return re.test(path);
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

/** Read a response body, aborting once it exceeds `max` bytes (works without Content-Length). */
async function readCapped(res: Response, max: number, controller: AbortController): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      controller.abort();
      await reader.cancel().catch(() => {});
      throw new HttpError("Response too large", "TOO_LARGE", res.status);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const V4_BLOCKED: [number, number][] = [
  // [network, prefix] — non-public IPv4 (RFC 6890 special-purpose registry and multicast/reserved)
  [ip4("0.0.0.0"), 8], [ip4("10.0.0.0"), 8], [ip4("100.64.0.0"), 10], [ip4("127.0.0.0"), 8], [ip4("169.254.0.0"), 16],
  [ip4("172.16.0.0"), 12], [ip4("192.0.0.0"), 24], [ip4("192.0.2.0"), 24], [ip4("192.88.99.0"), 24], [ip4("192.168.0.0"), 16],
  [ip4("198.18.0.0"), 15], [ip4("198.51.100.0"), 24], [ip4("203.0.113.0"), 24], [ip4("224.0.0.0"), 3],
];

function ip4(s: string): number {
  return s.split(".").reduce((a, o) => a * 256 + Number(o), 0);
}

/** Expand any IPv6 text form to 8 hextets (handles ::, embedded dotted IPv4, zone ids). */
function hextets(v6: string): number[] | null {
  let s = v6.toLowerCase().split("%")[0]!;
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (isIP(dotted[1]!) !== 4) return null;
    const n = ip4(dotted[1]!);
    s = s.slice(0, -dotted[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array(Math.max(0, fill)).fill("0"), ...t].map((x) => parseInt(x || "0", 16));
  return parts.length === 8 && parts.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? parts : null;
}

/**
 * True for any address that is not plain public unicast. IPv4 embedded in IPv6
 * (mapped ::ffff:, compatible ::, NAT64 64:ff9b::/96, 6to4 2002::/16) is checked
 * as the IPv4 it reaches.
 */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = ip4(ip);
    return V4_BLOCKED.some(([net, bits]) => n >>> (32 - bits) === net >>> (32 - bits));
  }
  const h = hextets(ip);
  if (!h) return true; // unparseable: fail closed
  const v4 = (hi: number, lo: number) => `${hi >>> 8}.${hi & 255}.${lo >>> 8}.${lo & 255}`;
  const zero = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && h[5] === 0xffff) return isPrivateAddress(v4(h[6]!, h[7]!)); // ::ffff:a.b.c.d
  if (zero(0, 6)) return h[6] === 0 && h[7]! <= 1 ? true : isPrivateAddress(v4(h[6]!, h[7]!)); // ::, ::1, ::a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b && zero(2, 6)) return isPrivateAddress(v4(h[6]!, h[7]!)); // NAT64
  if (h[0] === 0x2002) return isPrivateAddress(v4(h[1]!, h[2]!)); // 6to4
  if ((h[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h[0]! & 0xffc0) === 0xfe80 || (h[0]! & 0xffc0) === 0xfec0) return true; // link/site local
  if ((h[0]! & 0xff00) === 0xff00) return true; // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
  if (h[0] === 0x0100 && zero(1, 4)) return true; // discard-only 100::/64
  if (h[0] === 0x2001 && h[1]! < 0x0200) return true; // 2001::/23 IETF protocol assignments (incl. Teredo)
  return false;
}

/** DNS lookup that refuses non-public answers; used by the pinned agent so the checked address is the connected one. */
function guardedLookup(hostname: string, options: { all?: boolean; family?: number } | number, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) {
  const opts = typeof options === "number" ? { family: options } : (options ?? {});
  lookupCb(hostname, { all: true, family: opts.family as 0 | 4 | 6 | undefined }, (err, addrs) => {
    if (err) return cb(err, "");
    const list = addrs as LookupAddress[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) return cb(new HttpError("Refusing to fetch a private network address", "BLOCKED_URL"), "");
    if (opts.all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
}

let agent: Agent | null = null;
function guardedAgent(): Agent {
  agent ??= new Agent({ connect: { lookup: guardedLookup as never, timeout: 10_000 }, headersTimeout: 15_000, bodyTimeout: 15_000 });
  return agent;
}

export async function assertPublicHost(hostname: string): Promise<void> {
  if (/^\[.*\]$/.test(hostname)) hostname = hostname.slice(1, -1); // bracketed IPv6 literal
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(hostname)) throw new HttpError("Refusing to fetch a local address", "BLOCKED_URL");
  const addrs = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new HttpError(`Could not resolve ${hostname}`, "NETWORK");
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new HttpError("Refusing to fetch a private network address", "BLOCKED_URL");
}
