import { screenUntrusted } from "./text";
import type { Eligibility, LocationTier, WorkplaceType } from "./types";

/**
 * Deterministic location classification + India eligibility gate.
 *
 * Principles:
 * - A remote role restricted to another region (US-only, EU-only, AMER…) is
 *   INELIGIBLE unless there is explicit evidence India is allowed.
 * - "Remote" with no region is REMOTE_UNSPECIFIED → NEEDS_REVIEW, never
 *   assumed globally eligible.
 * - Work-authorization requirements for other countries are a hard gate.
 */

export interface LocationInput {
  locationRaw: string | null | undefined;
  locations?: string[];
  workplaceHint?: WorkplaceType | null;
  /** ISO-3166 alpha-2 hints from the ATS (e.g. Lever `country`). */
  countryCodes?: string[];
  description?: string;
}

export interface LocationResult {
  tier: LocationTier;
  eligibility: Eligibility;
  workplaceType: WorkplaceType;
  reasons: string[];
  countryCodes: string[];
}

const INDIA_CITIES =
  /\b(bengaluru|bangalore|hyderabad|pune|mumbai|navi mumbai|chennai|kolkata|ahmedabad|jaipur|chandigarh|mohali|kochi|cochin|indore|thiruvananthapuram|trivandrum|coimbatore|bhubaneswar|nagpur|vadodara|lucknow|mysore|mysuru|visakhapatnam|gurugram|gurgaon|noida|greater noida|new delhi|delhi|delhi ncr|ncr|faridabad|ghaziabad)\b/i;
// Note: never match the bare code "IN" in free text — it is also Indiana (e.g. "Indianapolis, IN").
const INDIA = /\bindia\b/i;
const APAC_INCLUDING_INDIA = /\b(apac|asia[- ]pacific|asia|south asia|emea\s*\+\s*apac)\b/i;

const REMOTE = /\b(remote|work from home|wfh|distributed|anywhere)\b/i;
const HYBRID = /\bhybrid\b/i;
const GLOBAL_REMOTE =
  /\b(worldwide|anywhere in the world|global(?:ly)?(?: remote)?|remote[- ]first,? anywhere|work from anywhere|fully distributed across the world|any (?:country|timezone|location))\b/i;

// Regions that explicitly exclude India when they qualify a remote role.
const FOREIGN_REGION =
  /\b(us|u\.s\.|usa|united states|americas?|amer|north america|latam|latin america|canada|mexico|brazil|eu|europe|european union|emea|uk|united kingdom|england|ireland|germany|france|spain|portugal|netherlands|poland|switzerland|sweden|nordics?|cet|est|pst|australia|new zealand|anz|japan|singapore|hong kong|uae|dubai|israel|africa|nigeria|kenya|philippines|vietnam|indonesia|korea|taiwan|china)\b/i;

const US_STATES =
  /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|san francisco|sf|nyc|seattle|austin|boston|chicago|los angeles|denver|miami|san diego|palo alto|mountain view|menlo park)\b|,\s*(?:ca|ny|tx|wa|ma|il|co|fl|ga|nj|pa|va|or|nc)\b/i;
const FOREIGN_CITIES =
  /\b(london|berlin|paris|amsterdam|dublin|zurich|zug|lisbon|madrid|barcelona|warsaw|krakow|prague|vienna|stockholm|copenhagen|oslo|helsinki|toronto|vancouver|montreal|sydney|melbourne|tokyo|singapore|hong kong|dubai|tel aviv|são paulo|sao paulo|buenos aires|mexico city|lagos|nairobi|manila|seoul|taipei|shanghai|beijing|cayman|bermuda|chicago|new york|san francisco)\b/i;

/** Explicit restriction language in the description (hard gates). */
const AUTH_RESTRICTIONS: { re: RegExp; label: string }[] = [
  { re: /\b(?:must|need to|required to|should) (?:be )?(?:currently )?(?:located|based|reside|residing|live|living) (?:in|within) (?:the )?(?:us|u\.s\.|usa|united states|north america|canada|eu|europe|uk|united kingdom|emea|americas)\b/i, label: "Description requires residence outside India" },
  { re: /\b(?:authori[sz]ed|eligible|legally able|right) to work in (?:the )?(?:us|u\.s\.|usa|united states|uk|united kingdom|canada|eu|europe|germany|australia)\b/i, label: "Requires work authorization outside India" },
  { re: /\b(?:us|u\.s\.|usa|uk|eu) (?:citizens?|work authori[sz]ation|persons?) only\b/i, label: "Restricted to non-Indian citizens/authorization" },
  { re: /\b(?:security clearance|ts\/sci|secret clearance|itar)\b/i, label: "Requires government security clearance (non-Indian)" },
  { re: /\bremote (?:within|in) (?:the )?(?:us|u\.s\.|usa|united states|canada|europe|eu|uk|americas)\b/i, label: "Remote restricted to another region" },
  { re: /\b(?:us|u\.s\.|eu|uk|emea|americas|north america|european)[- ]based (?:candidates|applicants|only)\b/i, label: "Candidates must be based outside India" },
  { re: /\bwe (?:are )?(?:unable|not able) to (?:sponsor|hire) (?:outside|in countries other than)\b/i, label: "Employer cannot hire outside specific countries" },
];

const INDIA_ALLOWED: RegExp[] = [
  /\b(?:open to|hiring in|candidates (?:from|in)|based in|located in|anywhere in)\s+(?:[a-z ,]+\s)?india\b/i,
  /\bindia\b[^.]{0,40}\b(?:welcome|eligible|ok|okay|considered)\b/i,
  /\b(?:ist|indian standard time)\b/i,
];

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function classifyLocation(input: LocationInput): LocationResult {
  const reasons: string[] = [];
  const locs = [input.locationRaw ?? "", ...(input.locations ?? [])].map(norm).filter(Boolean);
  const locText = locs.join(" | ");
  const desc = input.description ?? "";
  const codes = new Set((input.countryCodes ?? []).map((c) => c.toUpperCase()));

  // Workplace type
  let workplaceType: WorkplaceType = input.workplaceHint ?? "UNKNOWN";
  if (workplaceType === "UNKNOWN") {
    if (HYBRID.test(locText)) workplaceType = "HYBRID";
    else if (REMOTE.test(locText)) workplaceType = "REMOTE";
    else if (locText) workplaceType = "ONSITE";
  }

  const mentionsIndia =
    INDIA_CITIES.test(locText) || INDIA.test(locText) || codes.has("IN");
  if (mentionsIndia) codes.add("IN");

  // Hard gates from the description apply regardless of tier, unless India is
  // explicitly part of the location list.
  const restrictions = AUTH_RESTRICTIONS.filter((r) => r.re.test(desc)).map((r) => r.label);

  const foreignText = FOREIGN_REGION.test(locText) || US_STATES.test(locText) || FOREIGN_CITIES.test(locText);
  const foreignCodes = [...codes].filter((c) => c !== "IN");
  const foreignInLocation = foreignText || foreignCodes.length > 0;

  // --- India-located roles -------------------------------------------------
  if (mentionsIndia) {
    const tier: LocationTier = workplaceType === "REMOTE" ? "INDIA_REMOTE" : "INDIA_CITY";
    reasons.push(`Location lists India (${locs[0] ?? "IN"})`);
    // A restriction in the description conflicts with an India location: flag, don't silently pass.
    if (restrictions.length) {
      reasons.push(...restrictions.map((r) => `Conflicting: ${r}`));
      return { tier, eligibility: "NEEDS_REVIEW", workplaceType, reasons, countryCodes: [...codes] };
    }
    return { tier, eligibility: "ELIGIBLE", workplaceType, reasons, countryCodes: [...codes] };
  }

  // --- Not India-located --------------------------------------------------
  if (restrictions.length) {
    return {
      tier: "FOREIGN",
      eligibility: "INELIGIBLE",
      workplaceType,
      reasons: restrictions,
      countryCodes: [...codes],
    };
  }

  if (workplaceType === "REMOTE") {
    // Untrusted text may only TIGHTEN gates. If the description contains
    // injection-like content, its "India is allowed" claims are ignored.
    const descSuspicious = screenUntrusted(desc).suspicious;
    const indiaExplicit = !descSuspicious && INDIA_ALLOWED.some((re) => re.test(desc));
    if (descSuspicious) reasons.push("Description contains instruction-like text; its eligibility claims were ignored");
    if (GLOBAL_REMOTE.test(locText) && !foreignInLocation) {
      reasons.push("Listed as worldwide/anywhere remote");
      if (indiaExplicit) {
        reasons.push("Description explicitly allows India-based candidates");
        return { tier: "GLOBAL_REMOTE_INDIA_OK", eligibility: "ELIGIBLE", workplaceType, reasons, countryCodes: [...codes] };
      }
      reasons.push("India not explicitly confirmed — verify before applying");
      return { tier: "GLOBAL_REMOTE_INDIA_OK", eligibility: "NEEDS_REVIEW", workplaceType, reasons, countryCodes: [...codes] };
    }
    if (APAC_INCLUDING_INDIA.test(locText) && !foreignInLocation) {
      reasons.push("Remote within APAC/Asia — India likely included, verify");
      return { tier: "REMOTE_UNSPECIFIED", eligibility: "NEEDS_REVIEW", workplaceType, reasons, countryCodes: [...codes] };
    }
    if (!foreignText && foreignCodes.length) {
      // Only a structured country code (often the posting/HQ address) — weaker than explicit text.
      reasons.push(`Remote; ATS lists country ${foreignCodes.join(", ")} for this posting — may be restricted to that country, verify`);
      return { tier: "REMOTE_UNSPECIFIED", eligibility: "NEEDS_REVIEW", workplaceType, reasons, countryCodes: [...codes] };
    }
    if (foreignInLocation) {
      if (indiaExplicit) {
        reasons.push(`Remote listed for ${locs[0]}, but description explicitly allows India`);
        return { tier: "GLOBAL_REMOTE_INDIA_OK", eligibility: "NEEDS_REVIEW", workplaceType, reasons, countryCodes: [...codes] };
      }
      reasons.push(`Remote restricted to ${locs[0]} — no evidence India-based hiring is permitted`);
      return { tier: "FOREIGN", eligibility: "INELIGIBLE", workplaceType, reasons, countryCodes: [...codes] };
    }
    if (indiaExplicit) {
      reasons.push("Remote; description explicitly allows India-based candidates");
      return { tier: "GLOBAL_REMOTE_INDIA_OK", eligibility: "ELIGIBLE", workplaceType, reasons, countryCodes: [...codes] };
    }
    reasons.push("Remote, but region not stated — India eligibility unconfirmed");
    return { tier: "REMOTE_UNSPECIFIED", eligibility: "NEEDS_REVIEW", workplaceType, reasons, countryCodes: [...codes] };
  }

  if (!locText) {
    reasons.push("No location provided");
    return { tier: "UNKNOWN", eligibility: "NEEDS_REVIEW", workplaceType, reasons, countryCodes: [...codes] };
  }

  if (foreignInLocation) {
    reasons.push(`${workplaceType === "HYBRID" ? "Hybrid" : "On-site"} role in ${locs[0]} (outside India)`);
    return { tier: "FOREIGN", eligibility: "INELIGIBLE", workplaceType, reasons, countryCodes: [...codes] };
  }
  // Unrecognized location text (e.g. just the company name): don't guess.
  reasons.push(`Location "${locs[0]}" not recognized — verify where this role is based`);
  return { tier: "UNKNOWN", eligibility: "NEEDS_REVIEW", workplaceType: input.workplaceHint ?? "UNKNOWN", reasons, countryCodes: [...codes] };
}
