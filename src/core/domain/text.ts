import { createHash } from "node:crypto";
import { convert } from "html-to-text";

/** Decode Greenhouse-style escaped HTML (&lt;p&gt;) then convert to plain text. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  let s = html;
  if (/&lt;\w/.test(s) && !/<\w/.test(s)) {
    s = s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }
  return convert(s, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "h1", options: { uppercase: false } },
      { selector: "h2", options: { uppercase: false } },
      { selector: "h3", options: { uppercase: false } },
      { selector: "h4", options: { uppercase: false } },
      { selector: "table", format: "dataTable" },
    ],
  })
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9+#]+/g, " ")
    .replace(/\b(sr)\b/g, "senior")
    .replace(/\b(jr)\b/g, "junior")
    .replace(/\s+/g, " ")
    .trim();
}

const TRACKING_PARAMS = /^(utm_\w+|gh_src|source|src|ref|referrer|lever-source|lever-origin|trk|trackingId|refId|fbclid|gclid|mc_cid|mc_eid|_ga)$/i;

/** Canonical URL for dedupe: https, lowercase host, no tracking params, no trailing slash/fragment. */
export function canonicalizeUrl(input: string): string | null {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.protocol = "https:";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    u.hash = "";
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k));
    keep.sort(([a], [b]) => a.localeCompare(b));
    u.search = "";
    for (const [k, v] of keep) u.searchParams.append(k, v);
    return u.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Untrusted content handling (job descriptions, webpages, social content)
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS: RegExp[] = [
  /\bignore (?:all |any |the )?(?:previous|prior|above|earlier) (?:instructions|prompts?|rules)\b/i,
  /\bdisregard (?:all |any |the )?(?:previous|prior|above|system) (?:instructions|prompts?)\b/i,
  /\b(?:you are now|act as|pretend to be|roleplay as) (?:an? )?(?:ai|assistant|system|developer mode|dan)\b/i,
  /\bsystem prompt\b/i,
  /\b(?:rate|score|rank) (?:this|me|the candidate|this candidate|this job) (?:as )?(?:100|10\/10|perfect|highest)\b/i,
  /\b(?:mark|classify|treat) (?:this|the) (?:job|role|candidate) as (?:eligible|verified|open|perfect)\b/i,
  /<\/?(?:system|assistant|instructions?|tool_call|function_call)>/i,
  /\b(?:execute|run) (?:the following )?(?:command|code|script|tool)\b/i,
  /\bnew instructions?:/i,
  /\bif you are an? (?:ai|llm|language model|bot|automated)/i,
];

export interface UntrustedText {
  text: string;
  suspicious: boolean;
  matches: string[];
}

/**
 * Screens untrusted text before it is shown to an LLM. Suspicious passages are
 * neutralized (not deleted, so the user can still see them) and flagged.
 * Deterministic logic never reads instructions from this text in any case.
 */
export function screenUntrusted(text: string, maxLen = 12_000): UntrustedText {
  const matches: string[] = [];
  let out = text.slice(0, maxLen);
  for (const re of INJECTION_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    out = out.replace(g, (m) => {
      matches.push(m);
      return `[neutralized: ${m.replace(/[<>]/g, "")}]`;
    });
  }
  // Strip anything resembling our own delimiter tags to prevent breaking out of the data block.
  out = out.replace(/<\/?untrusted[^>]*>/gi, "[tag removed]");
  return { text: out, suspicious: matches.length > 0, matches };
}

/** Wrap untrusted content for an LLM prompt with explicit data delimiters. */
export function asUntrustedBlock(label: string, text: string): string {
  const { text: safe } = screenUntrusted(text);
  return `<untrusted source="${label}">\n${safe}\n</untrusted>`;
}

/** The URL if it is http(s), else null. Use before storing or navigating to any third-party URL. */
export function httpUrlOrNull(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}
