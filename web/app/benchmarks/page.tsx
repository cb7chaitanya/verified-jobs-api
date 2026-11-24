import type { Metadata } from "next";
import { BarChart, LatencyChart, StackedBars } from "@/components/charts";
import { ArrowUpRight } from "@/components/icons";
import { Badge, Card, Container, ExtLink, Mono, PageHeader, SectionHeading, Table } from "@/components/ui";
import { BENCH, fmtDate, fmtInt, fmtMs, txId, usdc } from "@/lib/bench";
import { railColor, repoFile, SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Benchmarks",
  description: "Measured runs of x402 exact, Circle Gateway Nanopayments and pay_session sessions on Solana devnet and Arc Testnet.",
};

const { devnet, devnetRaw, gateway, localnet } = BENCH;

function Figure({ title, caption, children, source }: { title: string; caption?: React.ReactNode; children: React.ReactNode; source?: string }) {
  return (
    <Card className="p-5 sm:p-6">
      <h3 className="font-medium">{title}</h3>
      {caption && <p className="mt-1 text-sm text-muted">{caption}</p>}
      <div className="mt-6">{children}</div>
      {source && (
        <p className="mt-5 border-t border-line pt-3 text-xs text-faint">
          Source: <ExtLink href={repoFile(`bench/results/${source}`)}>{source}</ExtLink>
        </p>
      )}
    </Card>
  );
}

function Tx({ url, label }: { url: string; label: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-accent hover:underline">
      {label} {txId(url).slice(0, 6)}… <ArrowUpRight className="size-3" />
    </a>
  );
}

export default function BenchmarksPage() {
  return (
    <>
      <PageHeader
        eyebrow="Benchmarks"
        title="Measured on real testnets, reconciled to the micro-USDC."
        lead={
          <>
            Each run makes paid calls through the real API and the real buyer agent, then checks that the seller received exactly calls × {SITE.price}. Job checks are stubbed during benchmarks, so the numbers are payment overhead only.
          </>
        }
      >
        <div className="mt-6 flex flex-wrap gap-2">
          <Badge tone={devnet.balancesMatch ? "ok" : "bad"}>{devnet.balancesMatch ? "✓ Balances reconcile on devnet" : "Balances don't reconcile"}</Badge>
          <Badge>
            Solana devnet · {fmtDate(devnet.at)} · {devnet.calls} calls per method
          </Badge>
          <Badge>
            Arc Testnet · {fmtDate(gateway.at)} · {gateway.calls} calls
          </Badge>
        </div>
      </PageHeader>

      <Container className="space-y-6 py-12">
        <Figure
          title="Payment latency per call"
          caption="Time the payment adds to one call, from the agent's paid retry to the answer. A session is checked off-chain; Gateway calls Circle's API; exact waits for a Solana confirmation."
          source="devnet-2026-11-23.json"
        >
          <LatencyChart
            rows={[
              { label: "pay_session", sub: "Solana devnet", color: railColor.session, p50: devnet.session.latencyMs.p50, p95: devnet.session.latencyMs.p95 },
              { label: "Circle Gateway", sub: "Arc Testnet", color: railColor.gateway, p50: gateway.latencyMs.p50, p95: gateway.latencyMs.p95 },
              { label: "x402 exact", sub: "Solana devnet", color: railColor.exact, p50: devnet.exact.latencyMs.p50, p95: devnet.exact.latencyMs.p95 },
            ]}
          />
        </Figure>

        <div className="grid gap-6 lg:grid-cols-2">
          <Figure title="On-chain transactions per 100 calls" caption="What each route puts on-chain for the same 100 answers.">
            <BarChart
              max={100}
              rows={[
                { label: "pay_session", color: railColor.session, value: devnet.session.onchainTransactions, display: `${devnet.session.onchainTransactions} (open + redeem)`, note: "One open, then a single redeem for all 100 receipts." },
                { label: "Circle Gateway", color: railColor.gateway, value: 0, display: "0 per call", note: "Gateway settles authorizations in batches later; none are sent per call." },
                { label: "x402 exact", color: railColor.exact, value: devnet.exact.onchainTransactions, display: `${devnet.exact.onchainTransactions}`, note: "One USDC transfer per call." },
              ]}
            />
          </Figure>
          <Figure title="Solana network fees for 100 calls" caption="Lamports spent on fees, whoever paid them.">
            <BarChart
              rows={[
                { label: "pay_session", color: railColor.session, value: Number(devnet.session.feesLamports), display: `${fmtInt(devnet.session.feesLamports)} lamports`, note: "Buyer pays the open, seller pays the redeem: about 150 lamports per call." },
                { label: "x402 exact", color: railColor.exact, value: Number(devnet.exact.feesLamports), display: `${fmtInt(devnet.exact.feesLamports)} lamports`, note: "Paid by the x402.org facilitator: about 10,001 lamports per call." },
              ]}
            />
          </Figure>
        </div>

        <section className="pt-10">
          <SectionHeading
            eyebrow="Found and fixed"
            title="Charged, but not served."
            lead={
              <>
                The public facilitator often answers <Mono>settle</Mono> with <Mono>settlement_pending</Mono>: the transfer is broadcast, but it didn&apos;t see the confirmation in time. The x402 middleware treats that as a failure and withholds the answer, yet the transfer lands moments later. The fix confirms the pending transaction on-chain, checking its signer, amount, mint and payee, and serves the call.
              </>
            }
          />
          <Figure title="x402 exact on devnet, 100 paid calls each" source="devnet-2026-11-23-raw.json">
            <StackedBars
              total={100}
              legend={[
                { label: "Served on the first settle", value: 0, color: "var(--ok)" },
                { label: "Pending, confirmed on-chain and served", value: 0, color: "var(--ok)", hatch: true },
                { label: "Charged, not served", value: 0, color: "var(--bad)" },
              ]}
              rows={[
                {
                  label: "Before: facilitator answer only",
                  sub: fmtDate(devnetRaw.at),
                  segments: [
                    { label: "Served on the first settle", value: devnetRaw.exact.served, color: "var(--ok)" },
                    { label: "Charged, not served", value: devnetRaw.exact.chargedNotServed, color: "var(--bad)" },
                  ],
                },
                {
                  label: "After: pending settlements confirmed on-chain",
                  sub: fmtDate(devnet.at),
                  segments: [
                    { label: "Served on the first settle", value: devnet.exact.facilitatorSettle.ok, color: "var(--ok)" },
                    { label: "Pending, confirmed on-chain and served", value: devnet.exact.recoveredOnChain, color: "var(--ok)", hatch: true },
                    { label: "Charged, not served", value: devnet.exact.chargedNotServed, color: "var(--bad)" },
                  ],
                },
              ]}
            />
            <p className="mt-6 text-sm text-muted">
              Cost of the fix: latency on the recovered calls (p95 {fmtMs(devnet.exact.latencyMs.p95)}, against {fmtMs(devnetRaw.exact.latencyMs.p95)} without it). If a transfer lands after the 30-second window, the buyer agent resends the same signed payment and is served once it confirms, so a late landing never costs a second payment.
            </p>
          </Figure>
        </section>

        <section className="pt-10">
          <SectionHeading eyebrow="The numbers" title="Every run, side by side." lead="The same data as the charts above, plus the local-validator baseline." />
          <Table
            head={["", "pay_session", "Circle Gateway", "x402 exact"]}
            rows={[
              ["Network", "Solana devnet", "Arc Testnet", "Solana devnet"],
              ["Calls served", `${devnet.session.served} / ${devnet.calls}`, `${gateway.served} / ${gateway.calls}`, `${devnet.exact.served} / ${devnet.calls}`],
              [
                "Seller received",
                <span key="s" className="font-mono">{usdc(devnet.session.sellerReceived)} USDC ✓</span>,
                <span key="g" className="font-mono">
                  {usdc(Number(gateway.buyerGatewayAvailableBefore) - Number(gateway.buyerGatewayAvailableAfter))} USDC ✓ <span className="font-sans text-xs text-faint">(buyer&apos;s Gateway balance)</span>
                </span>,
                <span key="e" className="font-mono">{usdc(devnet.exact.sellerReceived)} USDC ✓</span>,
              ],
              ["On-chain transactions", `${devnet.session.onchainTransactions}`, "0 per call", `${devnet.exact.onchainTransactions}`],
              ["Latency p50 / p95", `${devnet.session.latencyMs.p50} / ${devnet.session.latencyMs.p95} ms`, `${gateway.latencyMs.p50} / ${gateway.latencyMs.p95} ms`, `${fmtInt(devnet.exact.latencyMs.p50)} / ${fmtInt(devnet.exact.latencyMs.p95)} ms`],
              ["One-off costs", `open ${fmtInt(devnet.session.openMs)} ms, redeem ${fmtInt(devnet.session.redeemMs)} ms; rent refunded on close`, "a Gateway deposit, once", "none"],
              ["Local validator p50 / p95", `${localnet.session.latencyMs.p50} / ${localnet.session.latencyMs.p95} ms`, "–", `${localnet.exact.latencyMs.p50} / ${localnet.exact.latencyMs.p95} ms`],
              [
                "Transactions",
                <div key="t" className="flex flex-col gap-1">
                  <Tx url={devnet.session.openTx} label="open" />
                  <Tx url={devnet.session.redeemTx} label="redeem" />
                  <Tx url={devnet.session.closeTx} label="close" />
                </div>,
                <span key="g2" className="text-xs text-faint">settled by Gateway in batches</span>,
                <Tx key="e2" url={devnet.exact.sampleTx} label="sample" />,
              ],
            ]}
          />
          <div className="mt-6 grid gap-4 text-sm text-muted md:grid-cols-2">
            <p>
              <span className="text-fg">How to reproduce.</span> <Mono>pnpm bench:devnet</Mono> runs the session and exact comparison against the deployed program; <Mono>pnpm bench:gateway</Mono> runs Circle Gateway; <Mono>pnpm bench:local</Mono> runs against <Mono>solana-test-validator</Mono>. Calls are paced 1 s apart on devnet so the public RPC doesn&apos;t rate-limit the run; the pause isn&apos;t counted.
            </p>
            <p>
              <span className="text-fg">What isn&apos;t measured.</span> The job-board check itself (stubbed), and mainnet. On a local validator, exact pays two 5,000-lamport signatures per call; a redeem pays for the seller&apos;s signature and the buyer&apos;s ed25519 receipt.
            </p>
          </div>
        </section>
      </Container>
    </>
  );
}
