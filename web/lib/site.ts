/** Facts about the service shown across the site. */
export const SITE = {
  name: "Verified Jobs",
  tagline: "Is this job still open? Ask the employer's own job board.",
  description:
    "A pay-per-call API for AI agents. It checks a job posting against the employer's own job board and answers open or closed, with evidence, and whether someone in India can apply. $0.001 per answer in USDC over x402.",
  repo: "https://github.com/cb7chaitanya/verified-jobs-api",
  price: "$0.001",
  programId: "E5fA3t5xQkhjSiwrE5EzJ4wgr9fWSbTZzXsVxgKjGy3T",
  upgradeAuthority: "CaBUb4ozaVpHRyrAfhYRrYWjMMCF7m9k3inuiYZ2wGCz",
} as const;

/** The API on Railway, e.g. https://verified-jobs-api.up.railway.app. Empty: the playground replays recordings. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");
/** Shown in docs examples when no API is configured. */
export const API_DISPLAY = API_URL || "https://<your-api-host>";

export const explorerAddress = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;
export const repoFile = (path: string) => `${SITE.repo}/blob/main/${path}`;

export type RailId = "gateway" | "exact" | "session";

export interface Rail {
  id: RailId;
  name: string;
  short: string;
  network: string;
  caip2: string;
  settles: string;
  perCall: string;
  txPer100: string;
  bestFor: string;
}

export const RAILS: Rail[] = [
  {
    id: "session",
    name: "pay_session",
    short: "Prepaid session",
    network: "Solana devnet",
    caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    settles: "Deposit once into a program-owned vault. Each call carries a signed running total; the seller redeems the latest one in a single transaction.",
    perCall: "Off-chain receipt check",
    txPer100: "2",
    bestFor: "Agents making many calls to one service",
  },
  {
    id: "gateway",
    name: "Circle Gateway",
    short: "Nanopayments",
    network: "Arc Testnet",
    caip2: "eip155:5042002",
    settles: "The buyer signs an EIP-3009 authorization against a Gateway deposit. Circle settles batches later; the buyer pays no gas.",
    perCall: "Gateway verify + settle API",
    txPer100: "0 per call",
    bestFor: "EVM agents with a Gateway balance",
  },
  {
    id: "exact",
    name: "x402 exact",
    short: "One transfer per call",
    network: "Solana devnet",
    caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    settles: "The buyer signs a USDC transfer; the facilitator pays the fee and submits it. Each call waits for confirmation.",
    perCall: "On-chain confirmation",
    txPer100: "100",
    bestFor: "One-off calls, no setup",
  },
];

export const railColor: Record<RailId, string> = {
  gateway: "var(--gateway)",
  exact: "var(--exact)",
  session: "var(--session)",
};

export const SAMPLES = [
  { label: "Groww · Internal Audit", board: "Greenhouse", url: "https://job-boards.eu.greenhouse.io/groww/jobs/4970739101" },
  { label: "Meesho · Risk & Decision Science", board: "Lever", url: "https://jobs.lever.co/meesho/7d9af9b5-c1c7-48ec-bbb5-9b25e49f6596" },
  { label: "Notion · Forward Deployed Engineer, India", board: "Ashby", url: "https://jobs.ashbyhq.com/notion/79c18580-c927-456c-9d5f-72efbc6c43cb" },
  { label: "Notion · Forward Deployed Engineer, AMER", board: "Ashby", url: "https://jobs.ashbyhq.com/notion/10437426-14c8-4c45-8075-67959ce80393" },
];
