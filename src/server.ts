import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { x402ResourceServer } from "@x402/express";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { BatchFacilitatorClient, GatewayEvmScheme } from "@circle-fin/x402-batching/server";
import { address } from "@solana/kit";
import { createApp, type PaymentOption } from "./app";
import { httpClient } from "./core/ats";
import { verifyPosting } from "./core/verify";
import { log } from "./core/log";
import { Ledger } from "./ledger";
import { caip2, connect, RpcSessionReader } from "./session/chain";
import { SessionFacilitator } from "./session/facilitator";
import { SessionServerScheme } from "./session/scheme";
import { SCHEME } from "./session/protocol";
import { ConfirmingFacilitator, rpcTxSource } from "./exact-confirm";
import { DemoSession, mountDemo, solanaExplorer, type DemoMethod } from "./demo/demo";
import { schemePayer, sessionPayer } from "./buyer/agent";
import { USDC } from "./buyer/policy";
import { readKeypair, signerFrom, usdc } from "./cli/keys";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { ExactSvmScheme as ExactSvmClient } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { privateKeyToAccount } from "viem/accounts";

/** Testnets only until this has been reviewed for real money. */
export const ARC_TESTNET = "eip155:5042002";
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Set ${name} (see .env.example)`);
  return v;
}

const price = env("PRICE", "$0.001");
const ledger = new Ledger(env("LEDGER_PATH", "./data/ledger.db"));
const options: PaymentOption[] = [];
const facilitators: FacilitatorClient[] = [];
const schemes: [string, Parameters<x402ResourceServer["register"]>[1]][] = [];
let sessionChain: ReturnType<typeof connect> | undefined;
let sessionNetwork: string | undefined;

// 1. Circle Gateway Nanopayments (Arc Testnet): gas-free, settled in batches by Gateway.
if (process.env.EVM_PAY_TO) {
  // Circle's SDK bundles its own copy of the x402 types (resource.description required vs optional in
  // @x402/core 2.30); the wire format is the same, so only the static type needs bridging.
  facilitators.push(new BatchFacilitatorClient({ url: env("CIRCLE_GATEWAY_URL", "https://gateway-api-testnet.circle.com") }) as unknown as FacilitatorClient);
  schemes.push([ARC_TESTNET, new GatewayEvmScheme()]);
  options.push({ scheme: "exact", network: ARC_TESTNET, payTo: process.env.EVM_PAY_TO, price, label: "USDC on Arc Testnet via Circle Gateway Nanopayments (gas-free, batched)" });
}

// 2. x402 exact on Solana devnet: one USDC transfer per call, fee paid by the facilitator.
if (process.env.SOLANA_PAY_TO) {
  // A "pending" settlement that lands anyway still serves the buyer (see src/exact-confirm.ts).
  const rpc = connect(env("SOLANA_RPC_URL", "https://api.devnet.solana.com")).rpc;
  facilitators.push(new ConfirmingFacilitator(new HTTPFacilitatorClient({ url: env("SOLANA_FACILITATOR_URL", "https://x402.org/facilitator") }), rpcTxSource(rpc), { used: (tx) => !!ledger.payment(tx) }));
  schemes.push([SOLANA_DEVNET, new ExactSvmScheme()]);
  options.push({ scheme: "exact", network: SOLANA_DEVNET, payTo: process.env.SOLANA_PAY_TO, price, label: "USDC on Solana devnet via x402 exact (one transfer per call)" });
}

// 3. Prepaid sessions on Solana (pay_session program): signed receipts per call, redeemed in batches.
if (process.env.SESSION_PAY_TO) {
  const chain = connect(env("SESSION_RPC_URL", "https://api.devnet.solana.com"), process.env.SESSION_WS_URL);
  const network = await caip2(chain.rpc);
  sessionChain = chain;
  sessionNetwork = network;
  facilitators.push(new SessionFacilitator({ network, reader: new RpcSessionReader(chain.rpc), ledger }));
  schemes.push([network, new SessionServerScheme({ mint: address(env("SESSION_MINT")) })]);
  options.push({ scheme: SCHEME, network, payTo: process.env.SESSION_PAY_TO, price, label: "USDC via a prepaid pay_session on Solana (signed receipt per call, redeemed in batches)" });
}

if (!options.length) throw new Error("Set EVM_PAY_TO, SOLANA_PAY_TO and/or SESSION_PAY_TO so callers have a way to pay (see .env.example)");

const server = new x402ResourceServer(facilitators);
for (const [network, scheme] of schemes) server.register(network as `${string}:${string}`, scheme);

const port = Number(env("PORT", "3000"));
const registrations = process.env.AGENT_REGISTRATIONS ? (JSON.parse(process.env.AGENT_REGISTRATIONS) as { agentRegistry: string; agentId: string }[]) : [];
const app = createApp({
  verify: (url) => verifyPosting(url, httpClient()),
  payments: { server, options },
  ledger,
  identity: { baseUrl: env("PUBLIC_URL", `http://localhost:${port}`), registrations },
});

// Testnet demo page at `/` (see src/demo/demo.ts). Off unless DEMO=1.
if (process.env.DEMO === "1") {
  const methods: DemoMethod[] = [];
  const atomic = usdc(price.replace(/^\$/, ""));
  if (process.env.EVM_PAY_TO && process.env.DEMO_EVM_PRIVATE_KEY) {
    const p = schemePayer(ARC_TESTNET, new BatchEvmScheme(privateKeyToAccount(process.env.DEMO_EVM_PRIVATE_KEY as `0x${string}`)));
    methods.push({ id: "gateway", network: ARC_TESTNET, payTo: process.env.EVM_PAY_TO, asset: USDC[ARC_TESTNET]!, payer: async () => p });
  }
  const buyerKey = process.env.DEMO_SOLANA_KEYPAIR;
  if (process.env.SOLANA_PAY_TO && buyerKey) {
    const p = schemePayer(SOLANA_DEVNET, new ExactSvmClient(await createKeyPairSignerFromBytes(readKeypair(buyerKey)), { rpcUrl: env("SOLANA_RPC_URL", "https://api.devnet.solana.com") }));
    methods.push({ id: "exact", network: SOLANA_DEVNET, payTo: process.env.SOLANA_PAY_TO, asset: USDC[SOLANA_DEVNET]!, explorer: solanaExplorer, payer: async () => p });
  }
  let session: DemoSession | undefined;
  if (process.env.SESSION_PAY_TO && buyerKey && sessionChain && sessionNetwork) {
    const net = sessionNetwork;
    session = new DemoSession(sessionChain, await signerFrom(buyerKey), address(process.env.SESSION_PAY_TO), address(env("SESSION_MINT")), usdc(env("DEMO_SESSION_DEPOSIT_USDC", "0.05")), env("DEMO_DIR", "./data"));
    const s = session;
    methods.push({ id: "session", network: net, payTo: process.env.SESSION_PAY_TO, asset: env("SESSION_MINT"), explorer: () => null, payer: async (emit, p) => sessionPayer(net, await s.get(emit, p)) });
  }
  if (!methods.length) throw new Error("DEMO=1 needs a buyer key: DEMO_EVM_PRIVATE_KEY and/or DEMO_SOLANA_KEYPAIR (testnet only)");
  const sellerKey = process.env.DEMO_SELLER_KEYPAIR;
  mountDemo(app, {
    selfBase: `http://127.0.0.1:${port}`,
    price: atomic,
    methods,
    dailyCap: usdc(env("DEMO_DAILY_CAP_USDC", "0.5")),
    session,
    redeem: sellerKey && sessionChain ? { chain: sessionChain, ledger, seller: await signerFrom(sellerKey) } : undefined,
  });
  log.warn({ methods: methods.map((m) => m.id) }, "DEMO=1: the page at / pays this API from the server's testnet keys");
}

app.listen(port, () => {
  log.info({ port, networks: options.map((o) => `${o.scheme}@${o.network}`), price }, "listening");
});
