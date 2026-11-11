import { z } from "zod";
import { safeDate } from "../domain/recency";
import { htmlToText } from "../domain/text";
import { SourceError, type FeedResult, type NormalizedJob, type SourceAdapter } from "./types";

/**
 * Workable public jobs widget — the endpoint employers embed on their own
 * careers pages (apply.workable.com/api/v1/widget/accounts/{account}).
 * Public, unauthenticated; apply.workable.com/robots.txt allows all agents.
 * The widget returns one row per location for multi-location jobs, so rows
 * are merged by shortcode. There is no per-job endpoint: like Ashby, the
 * complete feed is the authority and closure needs repeated absence.
 */
const BASE = "https://apply.workable.com/api/v1/widget/accounts";

const WorkableJob = z
  .object({
    title: z.string(),
    shortcode: z.string(),
    url: z.string(),
    application_url: z.string().nullish(),
    published_on: z.string().nullish(),
    created_at: z.string().nullish(),
    employment_type: z.string().nullish(),
    telecommuting: z.boolean().nullish(),
    department: z.string().nullish(),
    country: z.string().nullish(),
    city: z.string().nullish(),
    state: z.string().nullish(),
    description: z.string().nullish(),
    locations: z
      .array(z.object({ country: z.string().nullish(), countryCode: z.string().nullish(), city: z.string().nullish(), region: z.string().nullish(), hidden: z.boolean().nullish() }).passthrough())
      .nullish(),
  })
  .passthrough();

const Feed = z.object({ name: z.string().nullish(), jobs: z.array(WorkableJob) }).passthrough();
type Row = z.infer<typeof WorkableJob>;

function place(r: { city?: string | null; region?: string | null; state?: string | null; country?: string | null }): string | null {
  return [r.city, r.region ?? r.state, r.country].filter(Boolean).join(", ") || null;
}

export function normalizeWorkable(rows: Row[], account: string): NormalizedJob {
  const first = rows[0]!;
  const locs = new Set<string>();
  const codes = new Set<string>();
  for (const r of rows) {
    const visible = (r.locations ?? []).filter((l) => !l.hidden);
    if (visible.length) {
      for (const l of visible) {
        const p = place(l);
        if (p) locs.add(p);
        if (l.countryCode) codes.add(l.countryCode.toUpperCase());
      }
    } else {
      const p = place(r);
      if (p) locs.add(p);
    }
  }
  const published = safeDate(first.published_on);
  const { description, ...rest } = first;
  const locations = [...locs];
  return {
    externalId: first.shortcode,
    title: first.title.trim(),
    reportedCompanyName: null,
    department: first.department || null,
    team: null,
    employmentType: first.employment_type || null,
    locationRaw: first.telecommuting ? `Remote${locations[0] ? ` (${locations[0]})` : ""}` : (locations[0] ?? null),
    locations,
    workplaceHint: first.telecommuting ? "REMOTE" : locations.length ? "ONSITE" : null,
    countryCodes: [...codes],
    descriptionText: htmlToText(description),
    sourceUrl: first.url,
    applyUrl: first.application_url ?? first.url,
    postedAt: published,
    postedAtSource: published ? "ATS_PUBLISHED_AT" : "UNKNOWN",
    employerUpdatedAt: null,
    validThrough: null,
    salary: null,
    requisitionId: null,
    feedEvidence: first.application_url ? "ATS_FEED_LISTED_APPLY" : "ATS_FEED_LISTED",
    raw: { ...rest, account, rows: rows.length },
  };
}

export const workable: SourceAdapter = {
  kind: "WORKABLE",
  label: "Workable",
  docsUrl: "https://help.workable.com/hc/en-us/articles/115012771647",
  boardUrl: (a) => `https://apply.workable.com/${encodeURIComponent(a)}`,

  async fetchFeed(account, http): Promise<FeedResult> {
    const url = `${BASE}/${encodeURIComponent(account)}?details=true`;
    const { res, data } = await http.json(url);
    if (res.status === 404) throw new SourceError(`Workable account "${account}" not found`, "BOARD_NOT_FOUND", 404);
    if (!res.ok || !data) throw new SourceError(`Workable HTTP ${res.status}`, "HTTP", res.status);
    const parsed = Feed.safeParse(data);
    if (!parsed.success) throw new SourceError(`Unexpected Workable response: ${parsed.error.issues[0]?.message}`, "SCHEMA");
    const groups = new Map<string, Row[]>();
    for (const row of parsed.data.jobs) groups.set(row.shortcode, [...(groups.get(row.shortcode) ?? []), row]);
    return {
      jobs: [...groups.values()].map((rows) => normalizeWorkable(rows, account)),
      complete: true,
      reportedCompanyName: parsed.data.name ?? null,
      httpStatus: res.status,
      ms: res.ms,
      sourceUrl: url,
    };
  },
};
