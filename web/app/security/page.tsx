import type { Metadata } from "next";
import { Alert, Check, Shield } from "@/components/icons";
import { Badge, Card, Container, ExtLink, Mono, PageHeader, SectionHeading, Table } from "@/components/ui";
import { SITE, explorerAddress, repoFile } from "@/lib/site";

export const metadata: Metadata = {
  title: "Security",
  description: "How the Verified Jobs API and the pay_session program were reviewed, what was fixed, and the risks that remain.",
};

const REVIEWS = [
  {
    name: "cloudflare/security-audit-skill",
    href: "https://github.com/cloudflare/security-audit-skill",
    scope: "Whole repository, source-only",
    fixed: [
      "A dishonest service could inflate a buyer's session total",
      "Concurrent replays of one exact payment",
      "Unsettled payments that had been handed over dropping out of the daily cap",
      "An unpinned payment token",
      "An unlimited, uncoalesced demo redeem route",
      "Stack traces on malformed input",
    ],
    hardening: "Facilitator scoping per network, a bounded session cache, reviews bound to their payment, key files that never overwrite, redirects never followed.",
  },
  {
    name: "trailofbits solana-vulnerability-scanner",
    href: "https://github.com/trailofbits/skills",
    scope: "The Anchor program",
    fixed: [],
    hardening: "Arbitrary CPI, PDA validation, ownership, signer, sysvar and instruction-introspection checks are all clear, each backed by a hostile-input test.",
  },
  {
    name: "frankcastleauditor/safe-solana-builder",
    href: "https://github.com/frankcastleauditor/safe-solana-builder",
    scope: "The Anchor program, as a rulebook checklist",
    fixed: [
      "Receipts replayable after a close and re-open (confirmed by a test before the fix)",
      "Token-2022 mints with extensions",
      "Fee-on-transfer accounting",
      "Unchecked arithmetic",
      "Payouts to an account the seller doesn't own",
    ],
    hardening: "Per-pair nonces so a session address is never reused, and the missing security tests.",
  },
];

const PROPERTIES: [string, string][] = [
  ["A receipt can't be redeemed twice, and an older receipt does nothing", "redeems_receipts_incrementally_and_never_twice"],
  ["The seller can never take more than the deposit", "never_pays_out_more_than_the_deposit"],
  ["Only the session's agent key can sign receipts, not even the buyer's wallet key", "rejects_receipts_signed_by_anyone_but_the_session_signer"],
  ["A receipt for one session can't be used on another", "rejects_a_receipt_meant_for_another_session"],
  ["No redeem without the ed25519 check directly before it", "requires_the_signature_check_right_before_redeem"],
  ["Signature offsets pointing outside the ed25519 instruction are refused", "rejects_signature_offsets_that_point_outside_the_ed25519_instruction"],
  ["A closed session's receipts can't be replayed on a new one", "a_closed_session_cannot_be_reopened_or_its_receipts_replayed"],
  ["Mints with Token-2022 extensions are refused", "refuses_mints_with_token_2022_extensions"],
  ["Payouts go only to the seller's own token account", "pays_out_only_to_a_token_account_the_seller_owns"],
  ["A substituted token program or spoofed instructions sysvar is refused", "refuses_a_substituted_token_program"],
];

export default function SecurityPage() {
  return (
    <>
      <PageHeader
        eyebrow="Security"
        title="Reviewed in the open. Not yet audited for real money."
        lead="The API, the buyer agent and the pay_session program were reviewed with three published security-audit skills and Trail of Bits' Solana lints. Every issue they raised is fixed in the commit history, with a regression test."
      >
        <div className="mt-6 flex flex-wrap gap-2">
          <Badge tone="ok">
            <Check className="size-3" /> 38 program tests
          </Badge>
          <Badge tone="ok">
            <Check className="size-3" /> 76 API and agent tests
          </Badge>
          <Badge tone="ok">
            <Check className="size-3" /> pnpm audit: no known vulnerabilities
          </Badge>
          <Badge tone="warn">
            <Alert className="size-3" /> Testnet only
          </Badge>
        </div>
      </PageHeader>

      <Container className="space-y-20 py-12">
        <section>
          <SectionHeading eyebrow="Reviews" title="What was checked, and what was fixed." />
          <div className="grid gap-4 lg:grid-cols-3">
            {REVIEWS.map((r) => (
              <Card key={r.name} className="flex flex-col p-5">
                <a href={r.href} target="_blank" rel="noreferrer" className="font-mono text-sm font-medium hover:underline">
                  {r.name}
                </a>
                <p className="mt-1 text-xs text-faint">{r.scope}</p>
                {r.fixed.length > 0 ? (
                  <ul className="mt-4 space-y-2 text-sm">
                    {r.fixed.map((f) => (
                      <li key={f} className="flex gap-2">
                        <Check className="mt-0.5 shrink-0 text-ok" />
                        <span className="text-muted">{f}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-4 flex gap-2 text-sm text-muted">
                    <Shield className="mt-0.5 shrink-0 text-ok" /> No findings in the six vulnerability patterns it scans for.
                  </p>
                )}
                <p className="mt-auto border-t border-line pt-4 text-xs text-faint">{r.hardening}</p>
              </Card>
            ))}
          </div>
          <Card className="mt-4 p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-mono text-sm font-medium">crytic/solana-lints · all 7 lints</h3>
              <Badge tone="ok">2 warnings, both intended</Badge>
            </div>
            <ul className="mt-4 space-y-3 text-sm text-muted">
              <li>
                <Mono>Redeem.instructions</Mono> was flagged as a possible missing signer. It&apos;s the instructions sysvar, pinned by address; it can&apos;t sign. Covered by <Mono>refuses_a_spoofed_instructions_sysvar</Mono>.
              </li>
              <li>
                <Mono>CloseSession.buyer</Mono> was flagged too. It only receives the refund and is pinned to the session&apos;s recorded buyer; authority comes from <Mono>caller</Mono>, which must sign: the buyer after expiry, or the seller at any time, so a seller can refund an idle buyer. Covered by four close-session tests.
              </li>
            </ul>
          </Card>
        </section>

        <section>
          <SectionHeading
            eyebrow="pay_session"
            title="Safety properties, each with a test."
            lead={
              <>
                Program <ExtLink href={explorerAddress(SITE.programId)}><span className="font-mono text-sm">{SITE.programId}</span></ExtLink> on Solana devnet, built with Anchor 0.31.1. The deployed bytes match a local build. Tests run in LiteSVM: <ExtLink href={repoFile("solana/tests/src/lib.rs")}>solana/tests/src/lib.rs</ExtLink>.
              </>
            }
          />
          <Table head={["Property", "Test"]} rows={PROPERTIES.map(([p, t]) => [p, <span key={t} className="font-mono text-xs break-hash text-muted">{t}</span>])} />
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <Card className="p-5">
              <h3 className="text-sm font-medium">The seller&apos;s exposure</h3>
              <p className="mt-2 text-sm text-muted">At most what it has served but not yet redeemed. It redeems before expiry and stops accepting receipts 10 minutes before. Acceptance is a compare-and-set in a durable ledger, so two racing requests can&apos;t both be served on one receipt, and a restart can&apos;t reopen an old one.</p>
            </Card>
            <Card className="p-5">
              <h3 className="text-sm font-medium">The buyer&apos;s exposure</h3>
              <p className="mt-2 text-sm text-muted">At most one call&apos;s price ahead: a receipt it signed for a call that then failed, which it re-signs on the next call. Its running total advances only to receipts it signed itself, never to a total the seller reports.</p>
            </Card>
          </div>
        </section>

        <section>
          <SectionHeading eyebrow="Known limits" title="What a review can't fix." lead="These are deliberate, inherent or not done yet, and each is stated in the README." />
          <div className="grid gap-4 md:grid-cols-2">
            {[
              {
                title: "Upgrade authority",
                body: (
                  <>
                    The devnet program can be replaced by one key, <span className="font-mono text-xs break-hash">{SITE.upgradeAuthority}</span>, which could change the code and drain vaults. That&apos;s kept on purpose while this is a testnet project. Before mainnet: a Squads multisig with a time lock, a verifiable build, and optionally an immutable program.
                  </>
                ),
              },
              { title: "USDC's freeze authority", body: "Circle can freeze any USDC account, including session vaults. That's part of USDC itself; Token-2022 extension mints are refused, but a plain freeze authority can't be without refusing USDC." },
              { title: "Not professionally audited", body: "Agent-run review skills are a strong first pass, not a substitute for a paid audit before real money is involved." },
              { title: "The testnet demo holds keys", body: "The playground's buyer agent pays from testnet keys on the API server. It's capped per day, rate-limited, runs one call at a time, and only answers this site and the API's own page. It must never be given mainnet keys." },
            ].map((x) => (
              <Card key={x.title} className="p-5">
                <h3 className="flex items-center gap-2 text-sm font-medium">
                  <Alert className="text-warn" /> {x.title}
                </h3>
                <p className="mt-2 text-sm text-muted">{x.body}</p>
              </Card>
            ))}
          </div>
          <p className="mt-6 text-sm text-muted">
            Dependency scans: <Mono>pnpm audit</Mono> reports no known vulnerabilities. <Mono>cargo audit</Mono> passes; its advisories are all in the LiteSVM test harness, not the on-chain program, and each is documented with its dependency path in <ExtLink href={repoFile("solana/.cargo/audit.toml")}>solana/.cargo/audit.toml</ExtLink>. Found something? Open an issue on <ExtLink href={SITE.repo}>GitHub</ExtLink>.
          </p>
        </section>
      </Container>
    </>
  );
}
