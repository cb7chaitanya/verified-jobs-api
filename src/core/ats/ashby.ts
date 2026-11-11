import { z } from "zod";
import { safeDate } from "../domain/recency";
import { htmlToText } from "../domain/text";
import type { Salary, WorkplaceType } from "../domain/types";
import { SourceError, type FeedResult, type NormalizedJob, type SourceAdapter } from "./types";

/**
 * Ashby public job posting API (intended for career pages).
 * Docs: https://developers.ashbyhq.com/docs/public-job-posting-api
 * There is no per-job endpoint; the board feed is the authority, so closure
 * requires repeated absence from a healthy, complete feed.
 */
const BASE = "https://api.ashbyhq.com/posting-api/job-board";

const AddressSchema = z
  .object({
    postalAddress: z
      .object({ addressCountry: z.string().nullish(), addressLocality: z.string().nullish(), addressRegion: z.string().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough()
  .nullish();

const AshbyJobSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    department: z.string().nullish(),
    team: z.string().nullish(),
    employmentType: z.string().nullish(),
    location: z.string().nullish(),
    secondaryLocations: z.array(z.object({ location: z.string().nullish(), address: AddressSchema }).passthrough()).nullish(),
    publishedAt: z.string().nullish(),
    isListed: z.boolean().nullish(),
    isRemote: z.boolean().nullish(),
    workplaceType: z.string().nullish(),
    address: AddressSchema,
    jobUrl: z.string(),
    applyUrl: z.string().nullish(),
    descriptionHtml: z.string().nullish(),
    descriptionPlain: z.string().nullish(),
    compensation: z
      .object({
        compensationTierSummary: z.string().nullish(),
        summaryComponents: z
          .array(
            z
              .object({
                compensationType: z.string().nullish(),
                interval: z.string().nullish(),
                currencyCode: z.string().nullish(),
                minValue: z.number().nullish(),
                maxValue: z.number().nullish(),
              })
              .passthrough(),
          )
          .nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

type AshbyJob = z.infer<typeof AshbyJobSchema>;

function workplace(j: AshbyJob): WorkplaceType | null {
  const w = (j.workplaceType ?? "").toLowerCase();
  if (w === "remote") return "REMOTE";
  if (w === "hybrid") return "HYBRID";
  if (w === "onsite" || w === "on-site") return "ONSITE";
  return null; // isRemote alone is ambiguous (true for remote OR hybrid)
}

const COUNTRY_CODES: Record<string, string> = { india: "IN", "united states": "US", usa: "US", "united kingdom": "GB", canada: "CA", germany: "DE", singapore: "SG" };

function salary(j: AshbyJob): Salary | null {
  const c = j.compensation?.summaryComponents?.find((x) => (x.compensationType ?? "").toLowerCase() === "salary");
  if (!c || (c.minValue == null && c.maxValue == null)) return null;
  const iv = (c.interval ?? "").toLowerCase();
  return {
    min: c.minValue ?? null,
    max: c.maxValue ?? null,
    currency: c.currencyCode ?? null,
    period: /year/.test(iv) ? "YEAR" : /month/.test(iv) ? "MONTH" : /hour/.test(iv) ? "HOUR" : "UNKNOWN",
    source: "ashby:compensation",
    summary: j.compensation?.compensationTierSummary ?? undefined,
  };
}

export function normalizeAshby(j: AshbyJob, boardName: string): NormalizedJob {
  const secondary = (j.secondaryLocations ?? []).map((s) => s.location).filter((x): x is string => !!x);
  const countries = [j.address, ...(j.secondaryLocations ?? []).map((s) => s.address)]
    .map((a) => a?.postalAddress?.addressCountry?.toLowerCase())
    .filter((x): x is string => !!x)
    .map((c) => COUNTRY_CODES[c] ?? (c.length === 2 ? c.toUpperCase() : null))
    .filter((x): x is string => !!x);
  const published = safeDate(j.publishedAt);
  const listedWithApply = j.isListed !== false && !!j.applyUrl;
  const { descriptionHtml, descriptionPlain, ...rest } = j;
  return {
    externalId: j.id,
    title: j.title.trim(),
    reportedCompanyName: null,
    department: j.department ?? null,
    team: j.team ?? null,
    employmentType: j.employmentType ?? null,
    locationRaw: j.location ?? null,
    locations: secondary,
    workplaceHint: workplace(j),
    countryCodes: [...new Set(countries)],
    descriptionText: descriptionPlain?.trim() || htmlToText(descriptionHtml),
    sourceUrl: j.jobUrl,
    applyUrl: j.applyUrl ?? null,
    postedAt: published,
    postedAtSource: published ? "ATS_PUBLISHED_AT" : "UNKNOWN",
    employerUpdatedAt: null,
    validThrough: null,
    salary: salary(j),
    requisitionId: null,
    feedEvidence: listedWithApply ? "ATS_FEED_LISTED_APPLY" : "ATS_FEED_LISTED",
    raw: { ...rest, board: boardName },
  };
}

export const ashby: SourceAdapter = {
  kind: "ASHBY",
  label: "Ashby",
  docsUrl: "https://developers.ashbyhq.com/docs/public-job-posting-api",
  boardUrl: (n) => `https://jobs.ashbyhq.com/${encodeURIComponent(n)}`,

  async fetchFeed(name, http): Promise<FeedResult> {
    const url = `${BASE}/${encodeURIComponent(name)}?includeCompensation=true`;
    const { res, data } = await http.json(url);
    if (res.status === 404) throw new SourceError(`Ashby board "${name}" not found`, "BOARD_NOT_FOUND", 404);
    if (!res.ok || !data) throw new SourceError(`Ashby HTTP ${res.status}`, "HTTP", res.status);
    const parsed = z.object({ jobs: z.array(AshbyJobSchema) }).passthrough().safeParse(data);
    if (!parsed.success) throw new SourceError(`Unexpected Ashby response: ${parsed.error.issues[0]?.message}`, "SCHEMA");
    // Unlisted postings are not public openings; skip them.
    const jobs = parsed.data.jobs.filter((j) => j.isListed !== false).map((j) => normalizeAshby(j, name));
    return { jobs, complete: true, reportedCompanyName: null, httpStatus: res.status, ms: res.ms, sourceUrl: url };
  },
};
