import type { Metadata } from "next";
import { Code } from "@/components/code";
import { Badge, Card, Container, ExtLink, Mono, PageHeader, Table } from "@/components/ui";
import { API_DISPLAY, RAILS, SITE, explorerAddress, railColor, repoFile } from "@/lib/site";

export const metadata: Metadata = {
  title: "Docs",
  description: "API reference for the Verified Jobs API: endpoints, the response schema, and how to pay from your own agent over x402.",
};

const API = API_DISPLAY;
const POSTING = "https://jobs.lever.co/meesho/7d9af9b5-c1c7-48ec-bbb5-9b25e49f6596";

const TOC = [
  ["overview", "Overview"],
  ["quickstart", "Quickstart"],
  ["endpoints", "Endpoints"],
  ["verify", "GET /v1/verify"],
  ["response", "Response"],
  ["evidence", "Evidence and status"],
  ["eligibility", "India eligibility"],
  ["errors", "Status codes and charging"],
  ["payment", "Payment methods"],
  ["pay-typescript", "Paying from TypeScript"],
  ["buyer-agent", "The policy-checked buyer agent"],
  ["sessions", "Prepaid sessions"],
  ["reviews", "Reviews and reputation"],
] as const;

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="group mt-16 mb-4 scroll-mt-24 text-xl font-semibold tracking-tight first:mt-0">
      <a href={`#${id}`} className="no-underline">
        {children}
        <span className="ml-2 text-faint opacity-0 transition group-hover:opacity-100">#</span>
      </a>
    </h2>
  );
}

const P = ({ children }: { children: React.ReactNode }) => <p className="mb-4 leading-relaxed text-muted">{children}</p>;

export default function DocsPage() {
  return (
    <>
      <PageHeader eyebrow="Docs" title="API reference" lead="One paid endpoint, a few free ones, and three ways to pay. Everything here is on testnet: Solana devnet and Arc Testnet, with test USDC." />
      <Container className="grid gap-12 py-12 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="On this page" className="hidden lg:block">
          <ul className="sticky top-24 space-y-1 border-l border-line text-sm">
            {TOC.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="-ml-px block border-l border-transparent py-1 pl-4 text-muted transition-colors hover:border-fg hover:text-fg">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="min-w-0 max-w-3xl">
          <H2 id="overview">Overview</H2>
          <P>
            Give the API a job posting URL. It checks the posting against the employer&apos;s own job board, using official APIs only, and answers whether the job is open or closed, with evidence, and whether someone based in India can apply. Each check costs {SITE.price} in USDC, paid over{" "}
            <ExtLink href="https://x402.org">x402</ExtLink>: the server answers an unpaid request with <Mono>402 Payment Required</Mono> and a price, and the client retries with a signed payment in a header.
          </P>
          <Table
            head={["Base URL", "Boards", "Price"]}
            rows={[[<Mono key="u">{API}</Mono>, "Greenhouse, Lever, Ashby, Workable", `${SITE.price} USDC per completed check`]]}
          />

          <H2 id="quickstart">Quickstart</H2>
          <P>Ask without paying first. You&apos;ll get a 402 whose <Mono>PAYMENT-REQUIRED</Mono> header is base64 JSON listing every way to pay.</P>
          <Code
            lang="bash"
            code={`curl -s -D - -o /dev/null "${API}/v1/verify?url=${POSTING}" \\
  | grep -i '^payment-required:' | cut -d' ' -f2 | base64 -d | jq .accepts`}
          />
          <Code
            className="mt-3"
            lang="json"
            title="accepts (abridged)"
            code={`[
  { "scheme": "exact",   "network": "eip155:5042002", "amount": "1000", "asset": "0x3600000000000000000000000000000000000000", "payTo": "0x7709…279E" },
  { "scheme": "exact",   "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "amount": "1000", "asset": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", "payTo": "Eecx…eUeVJ" },
  { "scheme": "session", "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "amount": "1000", "asset": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", "payTo": "Eecx…eUeVJ" }
]`}
          />
          <P>
            <span className="mt-4 block">
              <Mono>amount</Mono> is in USDC&apos;s smallest unit (6 decimals): <Mono>1000</Mono> is $0.001. Then pay with any x402 client; see <a href="#pay-typescript" className="text-fg underline decoration-line-strong underline-offset-4">Paying from TypeScript</a>.
            </span>
          </P>

          <H2 id="endpoints">Endpoints</H2>
          <Table
            head={["Endpoint", "Cost", "Purpose"]}
            rows={[
              [<Mono key="1">GET /v1</Mono>, <Badge key="b1" tone="ok">free</Badge>, "What the API does, its price and payment options"],
              [<Mono key="2">GET /v1/verify?url=…</Mono>, <Badge key="b2" tone="accent">{SITE.price}</Badge>, "Verify one posting"],
              [<Mono key="3">POST /v1/feedback</Mono>, <Badge key="b3" tone="ok">free</Badge>, "Leave a payment-backed review"],
              [<Mono key="4">GET /v1/reputation</Mono>, <Badge key="b4" tone="ok">free</Badge>, "Review count, average and payment-weighted score"],
              [<Mono key="5">GET /.well-known/agent-registration.json</Mono>, <Badge key="b5" tone="ok">free</Badge>, "ERC-8004 agent registration file"],
              [<Mono key="6">GET /health</Mono>, <Badge key="b6" tone="ok">free</Badge>, "Liveness"],
            ]}
          />
          <P>
            <span className="mt-4 block">
              Every endpoint answers browsers on any origin (CORS), and exposes <Mono>PAYMENT-REQUIRED</Mono> and <Mono>PAYMENT-RESPONSE</Mono> to scripts, so x402 clients can run in a web page.
            </span>
          </P>

          <H2 id="verify">GET /v1/verify</H2>
          <Table
            head={["Query parameter", "Required", "Description"]}
            rows={[[<Mono key="u">url</Mono>, "yes", "An https URL of a single posting on Greenhouse, Lever, Ashby or Workable. At most 2,048 characters. A board's index page, or any other site, is refused with a 400 before a price is quoted."]]}
          />
          <P>
            <span className="mt-4 block">
              Headers: send <Mono>PAYMENT-SIGNATURE</Mono> (base64 JSON payment payload) on the paid retry. A successful answer carries <Mono>PAYMENT-RESPONSE</Mono>, the base64 JSON settlement receipt with the transaction or receipt reference. Results for the same URL are reused for 10 minutes (<Mono>cached: true</Mono>), so repeated calls don&apos;t hammer the employer&apos;s board; they&apos;re still paid calls.
            </span>
          </P>

          <H2 id="response">Response</H2>
          <Code
            lang="json"
            title="200 OK"
            code={`{
  "url": "https://jobs.lever.co/meesho/7d9af9b5-c1c7-48ec-bbb5-9b25e49f6596",
  "status": "OPEN",
  "checkedAt": "2026-11-23T23:17:52.157Z",
  "evidence": {
    "type": "ATS_DETAIL_ACTIVE",
    "board": "LEVER",
    "boardId": "meesho",
    "jobId": "7d9af9b5-c1c7-48ec-bbb5-9b25e49f6596",
    "endpoint": "https://api.lever.co/v0/postings/meesho/7d9af9b5-c1c7-48ec-bbb5-9b25e49f6596",
    "httpStatus": 200,
    "ms": 1930,
    "detail": "Published posting with an application URL"
  },
  "job": {
    "title": "AM/ Manager - Risk & Decision Science",
    "company": null,
    "location": "Bangalore, Karnataka",
    "workplace": "ONSITE",
    "postedAt": "2025-09-15T06:02:29.833Z",
    "applyUrl": "https://jobs.lever.co/meesho/7d9af9b5-c1c7-48ec-bbb5-9b25e49f6596/apply",
    "isSoftwareRole": false
  },
  "india": {
    "eligibility": "ELIGIBLE",
    "tier": "INDIA_CITY",
    "reasons": ["Location lists India (Bangalore, Karnataka)"]
  },
  "cached": false
}`}
          />
          <div className="mt-6">
            <Table
              head={["Field", "Type", "Meaning"]}
              rows={[
                [<Mono key="a">status</Mono>, "OPEN | CLOSED | UNKNOWN", "Derived from the evidence type (below)."],
                [<Mono key="b">checkedAt</Mono>, "ISO 8601", "When the board was asked. A check is a point-in-time observation."],
                [<Mono key="c">evidence</Mono>, "object", "Which official endpoint answered, its HTTP status and timing, and a one-line explanation."],
                [<Mono key="d">job</Mono>, "object | null", "As the board publishes it. company is null when the board doesn't name it. workplace is ONSITE, HYBRID, REMOTE or UNKNOWN."],
                [<Mono key="e">india</Mono>, "object | null", "ELIGIBLE, NEEDS_REVIEW or INELIGIBLE, with a location tier and the reasons."],
                [<Mono key="f">cached</Mono>, "boolean", "true when this answer was reused from a check in the last 10 minutes."],
              ]}
            />
          </div>

          <H2 id="evidence">Evidence and status</H2>
          <P>A status is returned only when the board gave direct evidence:</P>
          <Table
            head={["evidence.type", "Meaning", "status"]}
            rows={[
              ["ATS_DETAIL_ACTIVE", "The per-job endpoint returned the job with an application form", "OPEN"],
              ["ATS_FEED_LISTED_APPLY", "Listed in the complete official feed with an apply URL (Ashby and Workable have no per-job endpoint)", "OPEN"],
              ["ATS_FEED_LISTED", "Listed, but application availability not separately confirmed", "OPEN"],
              ["ATS_DETAIL_NOT_FOUND", "The job endpoint returned 404 while the board itself answered normally", "CLOSED"],
              ["ATS_DETAIL_INACTIVE", "The board reports the requisition inactive", "CLOSED"],
              ["PAGE_EXPIRED", "The application deadline has passed (Greenhouse)", "CLOSED"],
              ["FEED_MISSING", "Absent from a healthy, complete feed", "CLOSED"],
            ].map(([t, m, s]) => [<Mono key="t">{t}</Mono>, m, <Badge key="s" tone={s === "OPEN" ? "ok" : "bad"}>{s}</Badge>])}
          />
          <P>
            <span className="mt-4 block">
              SmartRecruiters is excluded because its API host&apos;s <Mono>robots.txt</Mono> disallows generic agents. Workday, LinkedIn and aggregators have no public API or prohibit automated access.
            </span>
          </P>

          <H2 id="eligibility">India eligibility</H2>
          <P>Decided by deterministic rules over the posting&apos;s own location data and text, not by a model:</P>
          <ul className="mb-4 list-disc space-y-2 pl-5 text-muted marker:text-faint">
            <li>A location in India is <Mono>ELIGIBLE</Mono>.</li>
            <li>A remote role restricted to another region is <Mono>INELIGIBLE</Mono> unless India is explicitly allowed.</li>
            <li>A region that isn&apos;t stated means <Mono>NEEDS_REVIEW</Mono>.</li>
            <li>Text in a description that tries to give instructions is detected, and any eligibility claims in that description are ignored.</li>
          </ul>

          <H2 id="errors">Status codes and charging</H2>
          <Table
            head={["Status", "error", "Charged?", "When"]}
            rows={[
              ["200", "–", <Badge key="1" tone="accent">yes</Badge>, "A completed check, open or closed."],
              ["400", "INVALID_URL · UNSUPPORTED_BOARD · NO_JOB_ID", <Badge key="2" tone="ok">no</Badge>, "Bad input. Refused before any price is quoted."],
              ["402", "–", <Badge key="3" tone="ok">no</Badge>, "No payment, an invalid one, or settlement failed. The answer is withheld."],
              ["404", "BOARD_NOT_FOUND", <Badge key="4" tone="ok">no</Badge>, "The board doesn't exist. Settlement is cancelled."],
              ["502", "UPSTREAM_UNAVAILABLE", <Badge key="5" tone="ok">no</Badge>, "The employer's board couldn't be reached. Settlement is cancelled."],
              ["500", "INTERNAL", <Badge key="6" tone="ok">no</Badge>, "Our fault. Settlement is cancelled."],
            ].map(([s, e, c, w]) => [<Mono key="s">{s}</Mono>, <span key="e" className="font-mono text-xs">{e}</span>, c, w])}
          />
          <P>
            <span className="mt-4 block">
              The employer&apos;s board isn&apos;t contacted until the payment is verified. With x402 <Mono>exact</Mono>, if the facilitator reports a settlement as pending, the server confirms the transfer on-chain and serves the call; if the transfer lands after the 30-second window, retry with the <em>same</em> <Mono>PAYMENT-SIGNATURE</Mono> and you&apos;ll be served once it confirms, without paying twice.
            </span>
          </P>

          <H2 id="payment">Payment methods</H2>
          <div className="grid gap-3">
            {RAILS.map((r) => (
              <Card key={r.id} className="p-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span aria-hidden className="size-2 rounded-full" style={{ background: railColor[r.id] }} />
                  <span className="font-mono text-sm font-medium">{r.name}</span>
                  <span className="text-xs text-faint">
                    scheme <Mono>{r.id === "session" ? "session" : "exact"}</Mono> · <Mono>{r.caip2}</Mono>
                  </span>
                </div>
                <p className="mt-2 text-sm text-muted">{r.settles}</p>
              </Card>
            ))}
          </div>
          <P>
            <span className="mt-4 block">
              Tokens: USDC on Solana devnet is <Mono>4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU</Mono>; on Arc Testnet it&apos;s <Mono>0x3600000000000000000000000000000000000000</Mono>. Get test USDC from{" "}
              <ExtLink href="https://faucet.circle.com">Circle&apos;s faucet</ExtLink>.
            </span>
          </P>

          <H2 id="pay-typescript">Paying from TypeScript</H2>
          <P>
            Any x402 v2 client works. With <Mono>@x402/fetch</Mono>, wrap <Mono>fetch</Mono> once and call the API as usual: on a 402 it signs a payment and retries.
          </P>
          <Code
            title="x402 exact on Solana devnet"
            code={`import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { readFileSync } from "node:fs";

// A devnet keypair holding devnet USDC. Testnet keys only.
const bytes = Uint8Array.from(JSON.parse(readFileSync("./devnet-buyer.json", "utf8")));
const signer = await createKeyPairSignerFromBytes(bytes);

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    client: new ExactSvmScheme(signer, { rpcUrl: "https://api.devnet.solana.com" }),
  }],
});

const posting = "${POSTING}";
const res = await pay(\`${API}/v1/verify?url=\${encodeURIComponent(posting)}\`);
console.log(await res.json());
console.log(decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!));`}
          />
          <Code
            className="mt-4"
            title="Circle Gateway on Arc Testnet (gas-free, after a one-time Gateway deposit)"
            code={`import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.ARC_TESTNET_KEY as \`0x\${string}\`);
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:5042002", client: new BatchEvmScheme(account) }],
});
const res = await pay(\`${API}/v1/verify?url=\${encodeURIComponent(posting)}\`);`}
          />
          <div className="mt-4 rounded-xl border border-warn/25 bg-warn-soft p-4 text-sm text-warn">
            A bare x402 client pays whatever a 402 asks, to whoever it names. For an agent, check the payee, token and price before signing, or use the buyer agent below.
          </div>

          <H2 id="buyer-agent">The policy-checked buyer agent</H2>
          <P>
            The repository ships a buyer agent that pays only within its owner&apos;s rules. Before it signs anything it checks the host, the network, that the payee and token match the pinned ones, the per-call limit, the price the service published, and a daily cap reserved in a durable spend log. Redirects are never followed, and everything a service returns is treated as data, never as instructions.
          </P>
          <Code
            lang="json"
            title="policy.json"
            code={`{
  "allowedHosts": ["${API.replace(/^https?:\/\//, "")}"],
  "networks": ["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "eip155:5042002"],
  "payees": {
    "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "EecxWpaA3DvMmT8TqyXAtGj93wzpfhWckyBkrJmEUeVJ",
    "eip155:5042002": "0x77090d091Bb68348fbe7FcF4Dc0402D71fE0279E"
  },
  "maxPerCallUsdc": "0.002",
  "dailyCapUsdc": "1.00"
}`}
          />
          <Code className="mt-3" lang="bash" code={`git clone ${SITE.repo} && cd verified-jobs-api && pnpm install
SOLANA_KEYPAIR=./devnet-buyer.json pnpm buyer --service ${API} --policy ./policy.json ${POSTING}`} />
          <P>
            <span className="mt-4 block">
              Source: <ExtLink href={repoFile("src/buyer/agent.ts")}>src/buyer/agent.ts</ExtLink>, with adversarial tests for redirected payees, price hikes, injected instructions and caps in <ExtLink href={repoFile("tests/buyer.test.ts")}>tests/buyer.test.ts</ExtLink>.
            </span>
          </P>

          <H2 id="sessions">Prepaid sessions</H2>
          <P>
            For many calls to one service, open a <Mono>pay_session</Mono>: deposit once into a vault owned by program <ExtLink href={explorerAddress(SITE.programId)}><span className="font-mono text-sm">{SITE.programId.slice(0, 8)}…</span></ExtLink>, then pay each call by signing a 96-byte receipt for the new running total with a short-lived agent key. The seller checks receipts off-chain and redeems the latest one in a single transaction; after expiry you take back whatever wasn&apos;t redeemed.
          </P>
          <Code
            lang="bash"
            code={`# 1. Open a session: 1 USDC for 24 hours
BUYER_KEYPAIR=./devnet-buyer.json pnpm session open \\
  --seller EecxWpaA3DvMmT8TqyXAtGj93wzpfhWckyBkrJmEUeVJ \\
  --mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU --deposit 1 --hours 24

# 2. Pay calls from it (no transaction per call)
SESSION_FILE=./data/session.json pnpm buyer --service ${API} --policy ./policy.json ${POSTING}

# 3. After expiry, take back the rest
pnpm session close --file ./data/session.json`}
          />
          <Code
            className="mt-3"
            lang="text"
            title="receipt message (signed with ed25519)"
            code={`"x402-session-v2\\0" || program id || session || opened_slot (u64 LE) || cumulative (u64 LE)   = 96 bytes`}
          />

          <H2 id="reviews">Reviews and reputation</H2>
          <P>
            <Mono>POST /v1/feedback</Mono> takes an <ExtLink href="https://eips.ethereum.org/EIPS/eip-8004">ERC-8004</ExtLink> feedback file, signed by the address that paid in <Mono>X-Feedback-Signature</Mono> (EIP-191 for EVM payers, ed25519 for Solana). It&apos;s accepted only for a payment this service actually settled, once per payment, so faking reviews means paying for them.
          </P>
          <Code
            lang="json"
            title="feedback file"
            code={`{
  "agentRegistry": "unregistered",
  "agentId": "0",
  "clientAddress": "<the address that paid>",
  "createdAt": "2026-11-24T10:00:00Z",
  "value": 90,
  "valueDecimals": 0,
  "endpoint": "${API}/v1",
  "proofOfPayment": {
    "fromAddress": "<the address that paid>",
    "toAddress": "<this service's payee>",
    "chainId": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    "txHash": "<transaction from PAYMENT-RESPONSE>"
  }
}`}
          />
          <P>
            <span className="mt-4 block">
              <Mono>GET /v1/reputation</Mono> returns the review count, a plain average, a payment-weighted score, and each review&apos;s <Mono>feedbackHash</Mono> (sha256 of the exact body), which can be posted on-chain.
            </span>
          </P>
        </article>
      </Container>
    </>
  );
}
