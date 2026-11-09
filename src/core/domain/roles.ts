/**
 * Deterministic role & domain classification from title/description.
 */

const SOFTWARE_TITLE =
  /\b(software|engineer|engineering|developer|programmer|swe|sde|sre|devops|backend|back-end|frontend|front-end|full[- ]?stack|platform|infrastructure|infra|protocol|blockchain|smart contract|quant(?:itative)? (?:developer|engineer)|machine learning|ml engineer|ai engineer|data engineer|systems)\b/i;
const NON_SOFTWARE_TITLE =
  /\b(developer advocate|developer relations|devrel|evangelist|brand rep|technical writer|mechanical|electrical|civil|chemical|hardware|manufacturing|technician|sales|account (?:executive|manager)|marketing|recruit(?:er|ing)|talent|hr\b|human resources|legal|counsel|finance manager|accountant|designer|product designer|copywriter|customer success|support specialist|operations manager|business development|bd\b|community|social media|content|analyst(?! developer)|trader|traders|nurse|driver)\b/i;
const GENERAL_APPLICATION =
  /\b(don'?t see|general application|talent (?:pool|community|network)|future opportunities|open application|spontaneous application|expression of interest)\b/i;

export interface RoleClassification {
  isSoftwareRole: boolean;
  category: string;
  isGeneralApplication: boolean;
}

export function classifyRole(title: string): RoleClassification {
  const isGeneralApplication = GENERAL_APPLICATION.test(title);
  const sw = SOFTWARE_TITLE.test(title);
  const nonSw = NON_SOFTWARE_TITLE.test(title);
  // "Sales Engineer"/"Solutions Engineer" are customer-facing; treat as non-core.
  const customerFacing = /\b(sales|solutions?|customer|support|field) engineer/i.test(title);
  const isSoftwareRole = sw && !customerFacing && !(nonSw && !/\bsoftware\b/i.test(title));
  let category = "other";
  const t = title.toLowerCase();
  if (/quant/.test(t)) category = "quant-dev";
  else if (/(trading|exchange|market data|matching|low[- ]latency|execution|hft)/.test(t)) category = "trading-infra";
  else if (/(platform|infrastructure|infra|sre|devops|reliability)/.test(t)) category = "platform";
  else if (/(distributed|systems|consensus|storage|database)/.test(t)) category = "distributed-systems";
  else if (/(blockchain|protocol|smart contract|solana|web3|crypto|defi|rust)/.test(t)) category = "protocol";
  else if (/(full[- ]?stack)/.test(t)) category = "full-stack";
  else if (/(backend|back-end|api)/.test(t)) category = "backend";
  else if (/(frontend|front-end|ui)/.test(t)) category = "frontend";
  else if (/(ai|ml|machine learning|llm)/.test(t)) category = "applied-ai";
  else if (isSoftwareRole) category = "software";
  return { isSoftwareRole: isSoftwareRole && !isGeneralApplication, category, isGeneralApplication };
}

const FINANCE_TERMS: [RegExp, string][] = [
  [/\b(trading|trader|algorithmic trading|algo trading|hft|high[- ]frequency)\b/i, "trading"],
  [/\b(exchange|matching engine|order ?book|order matching)\b/i, "exchange"],
  [/\b(market data|market[- ]making|market maker|liquidity)\b/i, "market-data"],
  [/\b(risk engine|risk management|risk systems?|margin|liquidation)\b/i, "risk"],
  [/\b(payments?|settlement|clearing|ledger|reconciliation|treasury|remittance)\b/i, "payments"],
  [/\b(fintech|financial services|banking|brokerage|lending|credit|capital markets|asset management|wealth)\b/i, "fintech"],
  [/\b(quant(?:itative)?|derivatives|options|futures|perpetuals?|pricing models?)\b/i, "quant"],
  [/\b(stablecoins?|defi|dex|amm|on-?chain finance)\b/i, "defi"],
  [/\b(low[- ]latency|latency[- ]sensitive|microsecond|nanosecond)\b/i, "low-latency"],
];

const INFRA_TERMS: [RegExp, string][] = [
  [/\b(distributed systems?|consensus|replication|fault[- ]tolerant)\b/i, "distributed-systems"],
  [/\b(infrastructure|platform engineering|kubernetes|observability)\b/i, "infrastructure"],
  [/\b(solana|ethereum|blockchain|web3|crypto|validators?|rpc)\b/i, "blockchain"],
  [/\b(rust)\b/i, "rust"],
  [/\b(indexer|indexing|data pipelines?|streaming|event[- ]driven|kafka)\b/i, "data-infra"],
];

export interface DomainResult {
  financeRelevance: number; // 0..1
  domainScore: number; // 0..1 — overall domain alignment with the candidate's tracks
  tags: string[];
}

export function classifyDomain(title: string, description: string, companyTracks: string[] = []): DomainResult {
  const text = `${title}\n${title}\n${description}`; // title weighted double
  const financeTags = FINANCE_TERMS.filter(([re]) => re.test(text)).map(([, t]) => t);
  const infraTags = INFRA_TERMS.filter(([re]) => re.test(text)).map(([, t]) => t);
  const titleFinance = FINANCE_TERMS.some(([re]) => re.test(title));
  let financeRelevance = Math.min(1, financeTags.length * 0.18 + (titleFinance ? 0.3 : 0));
  if (companyTracks.includes("finance")) financeRelevance = Math.max(financeRelevance, 0.5);
  const infra = Math.min(1, infraTags.length * 0.2);
  // Primary track is engineering × finance; infra/systems is strong secondary.
  const domainScore = Math.min(1, financeRelevance * 0.7 + infra * 0.5 + (companyTracks.includes("blockchain") ? 0.1 : 0));
  return {
    financeRelevance: Math.round(financeRelevance * 100) / 100,
    domainScore: Math.round(domainScore * 100) / 100,
    tags: [...new Set([...financeTags, ...infraTags])],
  };
}
