import express, { type NextFunction, type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { InputError, parsePosting, SUPPORTED, UpstreamError, type Verification } from "./core/verify";
import { log } from "./core/log";
import { Ledger } from "./ledger";
import { registrationFile, reputation, ReviewError, submitReview, type Identity } from "./reputation";

/** One way to pay for a call (shown to buyers in the 402 response). */
export interface PaymentOption {
  scheme: "exact" | "session";
  network: `${string}:${string}`;
  payTo: string;
  price: string;
  label: string;
}

export interface AppDeps {
  verify: (url: string) => Promise<Verification>;
  payments: { server: x402ResourceServer; options: PaymentOption[]; syncOnStart?: boolean };
  /** Durable record of settled payments (and session receipts and reviews). In-memory if omitted. */
  ledger?: Ledger;
  identity?: Partial<Identity>;
  /** How long a result is reused for the same URL, so repeat calls don't hammer the employer's board. */
  cacheMs?: number;
  now?: () => number;
}

const VERIFY_ROUTE = "GET /v1/verify";
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1f6feb"/><path d="M18 33l9 9 19-20" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/**
 * Last-resort error handler: a JSON code, never a stack trace or internal path (Express's default
 * handler sends err.stack whenever NODE_ENV isn't "production"). Register it after the routes it covers.
 */
export function jsonErrors(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  const e = err as { status?: unknown; statusCode?: unknown; type?: unknown };
  const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : 500;
  const code = status === 413 ? "PAYLOAD_TOO_LARGE" : status === 415 ? "UNSUPPORTED_MEDIA_TYPE" : status >= 400 && status < 500 ? "BAD_REQUEST" : "INTERNAL";
  if (status >= 500) log.error({ err: err instanceof Error ? err.message : String(err) }, "unhandled error");
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: code });
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  const cacheMs = deps.cacheMs ?? 10 * 60_000;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; value: Verification }>();
  const ledger = deps.ledger ?? new Ledger();
  const identity: Identity = {
    name: "Verified Jobs API",
    description: "Checks a job posting against the employer's own job board (official APIs only): open or closed, with evidence, and whether someone based in India can apply. Pay per call in USDC over x402.",
    baseUrl: "http://localhost:3000",
    registrations: [],
    ...deps.identity,
  };

  // Every settled payment is recorded, whatever the method, so reviews can prove they were paid for.
  deps.payments.server.onAfterSettle(async (ctx) => {
    if (!ctx.result.success || !ctx.result.transaction) return;
    ledger.recordPayment({
      id: ctx.result.transaction,
      scheme: ctx.requirements.scheme,
      network: ctx.requirements.network,
      payer: ctx.result.payer ?? "unknown",
      payTo: ctx.requirements.payTo,
      amount: ctx.result.amount ?? ctx.requirements.amount,
      resource: ctx.paymentPayload.resource?.url ?? null,
    });
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/icon.svg", (_req, res) => {
    res.type("image/svg+xml").send(ICON);
  });

  /** ERC-8004 agent registration file: who this service is and how to reach and pay it. */
  app.get("/.well-known/agent-registration.json", (_req, res) => {
    res.json(registrationFile(identity));
  });

  /** Free: what this API does, what it costs and how to pay. */
  app.get("/v1", (_req, res) => {
    res.json({
      name: identity.name,
      description: identity.description,
      endpoints: {
        verify: { method: "GET", path: "/v1/verify", query: { url: "https posting URL on a supported board" }, paid: true },
        feedback: { method: "POST", path: "/v1/feedback", body: "ERC-8004 feedback file with proofOfPayment.txHash = the PAYMENT-RESPONSE transaction", header: "X-Feedback-Signature" },
        reputation: { method: "GET", path: "/v1/reputation" },
        registration: { method: "GET", path: "/.well-known/agent-registration.json" },
      },
      boards: SUPPORTED,
      payment: deps.payments.options.map(({ label, scheme, network, price, payTo }) => ({ label, scheme, network, price, payTo })),
      charging: "You're charged only for a completed check (HTTP 200), whether the job turns out open or closed. Bad input is rejected before payment; if the employer's board can't be reached you get an error and aren't charged.",
    });
  });

  app.post("/v1/feedback", express.raw({ type: "application/json", limit: "16kb" }), async (req: Request, res: Response) => {
    try {
      const body = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array();
      const r = await submitReview(ledger, identity, body, req.header("x-feedback-signature") ?? undefined);
      res.status(201).json({ accepted: true, feedbackHash: r.hash, score: r.score });
    } catch (e) {
      if (e instanceof ReviewError) return void res.status(e.code === "DUPLICATE" ? 409 : e.code === "BAD_SIGNATURE" || e.code === "NOT_PAYER" ? 403 : 400).json({ error: e.code, message: e.message });
      log.error({ err: e instanceof Error ? e.message : String(e) }, "feedback failed");
      res.status(500).json({ error: "INTERNAL" });
    }
  });

  app.get("/v1/reputation", (_req, res) => {
    res.json(reputation(ledger));
  });

  // Validate before asking for payment, so a malformed request is never billed.
  app.get("/v1/verify", (req: Request, res: Response, next: NextFunction) => {
    const url = typeof req.query.url === "string" ? req.query.url : "";
    if (url.length > 2048) return void res.status(400).json({ error: "INVALID_URL", message: "URL too long" });
    try {
      parsePosting(url);
      next();
    } catch (e) {
      if (e instanceof InputError) return void res.status(400).json({ error: e.code, message: e.message });
      // Anything else thrown while parsing user input is still bad input, and still free.
      log.warn({ err: e instanceof Error ? e.message : String(e) }, "unparseable posting URL");
      res.status(400).json({ error: "INVALID_URL", message: "Not a valid posting URL" });
    }
  });

  app.use(
    paymentMiddleware(
      {
        [VERIFY_ROUTE]: {
          accepts: deps.payments.options.map(({ scheme, network, payTo, price }) => ({ scheme, network, payTo, price, maxTimeoutSeconds: 120 })),
          description: "Verify one job posting against the employer's official job board",
          mimeType: "application/json",
        },
      },
      deps.payments.server,
      undefined,
      undefined,
      deps.payments.syncOnStart ?? true,
    ),
  );

  app.get("/v1/verify", async (req: Request, res: Response) => {
    const url = String(req.query.url);
    const hit = cache.get(url);
    if (hit && now() - hit.at < cacheMs) return void res.json({ ...hit.value, cached: true });
    try {
      const value = await deps.verify(url);
      cache.set(url, { at: now(), value });
      if (cache.size > 5000) cache.delete(cache.keys().next().value!);
      res.json({ ...value, cached: false });
    } catch (e) {
      // Any 4xx/5xx here cancels settlement in the x402 middleware: the buyer isn't charged.
      if (e instanceof UpstreamError) return void res.status(e.status).json({ error: e.status === 404 ? "BOARD_NOT_FOUND" : "UPSTREAM_UNAVAILABLE", message: e.message });
      log.error({ err: e instanceof Error ? e.message : String(e) }, "verify failed");
      res.status(500).json({ error: "INTERNAL" });
    }
  });

  app.use(jsonErrors);
  return app;
}
