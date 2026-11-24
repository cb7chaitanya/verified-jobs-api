import Link from "next/link";
import { Code } from "@/components/code";
import { HeroExchange } from "@/components/hero-exchange";
import { ArrowRight, ArrowUpRight, Bolt, Check, Coin, Layers, Search, Shield } from "@/components/icons";
import { Badge, ButtonLink, Card, Container, RailDot, SectionHeading } from "@/components/ui";
import { BENCH, fmtInt, fmtMs } from "@/lib/bench";
import { RAILS, SITE, railColor } from "@/lib/site";

const d = BENCH.devnet;

const STATS = [
  { value: `${d.exact.served + d.session.served + BENCH.gateway.served}`, label: "paid calls served in the latest testnet runs", sub: "across all three payment methods" },
  { value: fmtMs(d.session.latencyMs.p50), label: "typical payment overhead with a session", sub: "receipt checked off-chain" },
  { value: `${d.session.onchainTransactions}`, label: "on-chain transactions per 100 session calls", sub: "open + one redeem" },
  { value: `${d.exact.chargedNotServed}`, label: "payments charged without an answer", sub: `${d.exact.recoveredOnChain} slow settlements recovered` },
];

const RESPONSE = `{
  "status": "OPEN",
  "checkedAt": "2026-11-19T14:15:02.311Z",
  "evidence": {
    "type": "ATS_DETAIL_ACTIVE",
    "board": "LEVER",
    "endpoint": "https://api.lever.co/v0/postings/acme/…",
    "httpStatus": 200,
    "ms": 1429
  },
  "job": {
    "title": "Senior Software Engineer - Backend",
    "location": "Bengaluru",
    "workplace": "ONSITE",
    "isSoftwareRole": true
  },
  "india": {
    "eligibility": "ELIGIBLE",
    "tier": "INDIA_CITY",
    "reasons": ["Location lists India (Bengaluru)"]
  }
}`;

export default function Home() {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-line">
        <div aria-hidden className="grid-bg pointer-events-none absolute inset-0" />
        <Container className="relative grid items-center gap-12 py-16 sm:py-24 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <div className="mb-6 flex flex-wrap items-center gap-2">
              <Badge tone="accent">
                <span className="pulse-dot size-1.5 rounded-full bg-accent" /> Live on testnet
              </Badge>
              <Badge>x402 · USDC · Solana · Arc</Badge>
            </div>
            <h1 className="text-4xl leading-[1.08] font-semibold tracking-tight text-balance sm:text-5xl lg:text-[56px]">
              Is this job still open? <span className="text-muted">Ask the employer&apos;s own job board.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg text-pretty text-muted">
              A pay-per-call API for AI agents. Send a posting URL and get back <span className="text-fg">open or closed, with evidence</span>, and whether someone in India can apply. Each answer costs <span className="text-fg">{SITE.price} in USDC</span>, paid over x402. No API keys, accounts or subscriptions.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink href="/playground">Try the playground</ButtonLink>
              <ButtonLink href="/docs" variant="secondary">
                Read the docs
              </ButtonLink>
            </div>
            <p className="mt-6 text-sm text-faint">Greenhouse · Lever · Ashby · Workable, through their official APIs only.</p>
          </div>
          <HeroExchange />
        </Container>
      </section>

      {/* Stats */}
      <section className="border-b border-line">
        <Container>
          <div className="grid grid-cols-2 gap-px border-x border-line bg-line lg:grid-cols-4">
            {STATS.map((s) => (
              <div key={s.label} className="bg-bg px-4 py-8 sm:px-6">
                <div className="font-mono text-3xl font-semibold tracking-tight tabular-nums">{s.value}</div>
                <div className="mt-2 text-sm text-fg">{s.label}</div>
                <div className="mt-1 text-xs text-faint">{s.sub}</div>
              </div>
            ))}
          </div>
        </Container>
      </section>

      {/* How it works */}
      <section className="py-20 sm:py-28">
        <Container>
          <SectionHeading eyebrow="How a paid call works" title="HTTP 402, finally used for what it was reserved for." lead="Your agent asks. The API answers with a price. The agent pays within its owner's limits and asks again, with the payment attached. Nothing to sign up for." />
          <ol className="grid gap-4 md:grid-cols-4">
            {[
              { icon: <Search />, title: "Ask", body: "GET /v1/verify with the posting URL. Bad input is refused here, before any price is quoted, so mistakes are free." },
              { icon: <Coin />, title: "Get a price", body: "A 402 response lists the ways to pay: network, token, amount and payee, for each payment method this API accepts." },
              { icon: <Shield />, title: "Pay within limits", body: "The agent checks the payee, token, price and daily cap against its owner's policy, then signs a payment." },
              { icon: <Check />, title: "Get the answer", body: "The board is only contacted after payment is verified. You are charged only for a completed check." },
            ].map((s, i) => (
              <li key={s.title} className="relative">
                <Card className="h-full p-5">
                  <div className="mb-4 flex items-center justify-between">
                    <span className="inline-flex size-9 items-center justify-center rounded-lg bg-accent-soft text-accent">{s.icon}</span>
                    <span className="font-mono text-xs text-faint">0{i + 1}</span>
                  </div>
                  <h3 className="font-medium">{s.title}</h3>
                  <p className="mt-1.5 text-sm text-muted">{s.body}</p>
                </Card>
              </li>
            ))}
          </ol>
        </Container>
      </section>

      {/* Payment methods */}
      <section className="border-y border-line bg-surface/50 py-20 sm:py-28">
        <Container>
          <SectionHeading
            eyebrow="Three ways to pay"
            title="Sub-cent payments, from one transfer per call to none at all."
            lead={
              <>
                Every route sells the same answer for the same {SITE.price}. They differ in what happens on-chain. Circle Gateway batches on EVM chains; <span className="text-fg">pay_session</span>, this project&apos;s Solana program, brings the same idea to Solana.
              </>
            }
          />
          <div className="grid gap-4 lg:grid-cols-3">
            {RAILS.map((r) => {
              const p50 = r.id === "session" ? d.session.latencyMs.p50 : r.id === "exact" ? d.exact.latencyMs.p50 : BENCH.gateway.latencyMs.p50;
              return (
                <Card key={r.id} className="flex flex-col p-6">
                  <div className="flex items-center gap-2">
                    <RailDot color={railColor[r.id]} />
                    <h3 className="font-mono text-sm font-semibold">{r.name}</h3>
                    <span className="ml-auto text-xs text-faint">{r.network}</span>
                  </div>
                  <p className="mt-4 text-sm text-muted">{r.settles}</p>
                  <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-line pt-5">
                    <div>
                      <dt className="text-xs text-faint">On-chain tx / 100 calls</dt>
                      <dd className="mt-1 font-mono text-xl font-semibold tabular-nums">{r.txPer100}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-faint">Payment latency, p50</dt>
                      <dd className="mt-1 font-mono text-xl font-semibold tabular-nums">{fmtMs(p50)}</dd>
                    </div>
                  </dl>
                  <p className="mt-5 text-xs text-faint">
                    Best for: <span className="text-muted">{r.bestFor}</span>
                  </p>
                </Card>
              );
            })}
          </div>
          <div className="mt-6 flex justify-end">
            <Link href="/benchmarks" className="group inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
              See the full benchmark runs <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
        </Container>
      </section>

      {/* The answer */}
      <section className="py-20 sm:py-28">
        <Container className="grid gap-12 lg:grid-cols-2 lg:items-start">
          <div>
            <SectionHeading eyebrow="What you get back" title="A point-in-time observation, with the receipt." lead="An answer is returned only when the employer's own board gave direct evidence. When the board can't be reached, you get a 502 and the payment isn't settled." />
            <ul className="space-y-5">
              {[
                ["status", "OPEN or CLOSED, derived from the board's own answer, never guessed from a scraped page."],
                ["evidence", "Which official endpoint answered, its HTTP status and timing, and how the status was derived."],
                ["job", "Title, company, location and workplace, as the board publishes them."],
                ["india", "Can someone based in India apply? Deterministic rules over the posting's own data, with reasons. Text that tries to instruct the reader is ignored."],
              ].map(([k, v]) => (
                <li key={k} className="flex gap-4">
                  <code className="mt-0.5 h-fit shrink-0 rounded-md bg-raised px-2 py-0.5 font-mono text-xs text-code-key">{k}</code>
                  <p className="text-sm text-muted">{v}</p>
                </li>
              ))}
            </ul>
          </div>
          <Code code={RESPONSE} lang="json" title="200 OK · GET /v1/verify" />
        </Container>
      </section>

      {/* Safety */}
      <section className="border-y border-line bg-surface/50 py-20 sm:py-28">
        <Container>
          <SectionHeading eyebrow="Safe to pay" title="Charging rules an agent can rely on." lead="Each rule is enforced in code and covered by a test, and the code was reviewed with three published security-audit skills." />
          <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
            {[
              [<Bolt key="a" />, "Bad input is free", "A URL that isn't a single posting on a supported board gets a 400 before any payment is requested."],
              [<Shield key="b" />, "Pay only for a completed check", "If the board can't be reached you get a 502, and the payment isn't settled."],
              [<Layers key="c" />, "No result without settlement", "If settlement fails, the answer is withheld and you get a 402. No free answers, no paid non-answers."],
              [<Check key="d" />, "A payment that lands is served", "When a facilitator reports a pending settlement, the transfer is confirmed on-chain and the call served."],
              [<Coin key="e" />, "Sessions never double-charge", "The buyer re-signs the same running total after a failure, so a failed call never costs extra."],
              [<Search key="f" />, "No unpaid board calls", "The employer's board isn't contacted until payment is verified."],
            ].map(([icon, title, body]) => (
              <div key={String(title)} className="flex gap-3">
                <span className="mt-0.5 text-accent">{icon}</span>
                <div>
                  <h3 className="text-sm font-medium">{title}</h3>
                  <p className="mt-1 text-sm text-muted">{body}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-10">
            <Link href="/security" className="group inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
              Read the security review <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
        </Container>
      </section>

      {/* CTA */}
      <section className="py-20 sm:py-28">
        <Container>
          <Card className="relative overflow-hidden p-8 sm:p-12">
            <div aria-hidden className="grid-bg pointer-events-none absolute inset-0 opacity-60" />
            <div className="relative flex flex-col items-start gap-6 lg:flex-row lg:items-center lg:justify-between">
              <div className="max-w-xl">
                <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Watch an agent pay for an answer.</h2>
                <p className="mt-3 text-muted">The playground runs a real buyer agent against the live API on testnet. Pick a posting and a payment method, and follow every step to the explorer.</p>
              </div>
              <div className="flex flex-wrap gap-3">
                <ButtonLink href="/playground">Open the playground</ButtonLink>
                <a href={SITE.repo} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium hover:bg-raised">
                  Source <ArrowUpRight />
                </a>
              </div>
            </div>
          </Card>
          <p className="mt-6 text-center text-xs text-faint">
            {fmtInt(d.calls)}-call devnet run on {new Date(d.at).toUTCString().slice(5, 16)}. Testnet only; not professionally audited.
          </p>
        </Container>
      </section>
    </>
  );
}
