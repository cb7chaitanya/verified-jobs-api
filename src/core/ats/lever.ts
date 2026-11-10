import { z } from "zod";
import { safeDate } from "../domain/recency";
import { htmlToText } from "../domain/text";
import type { Salary, WorkplaceType } from "../domain/types";
import { HttpError } from "./http";
import { SourceError, type DetailCheck, type FeedResult, type NormalizedJob, type SourceAdapter } from "./types";

/**
 * Lever Postings API — public endpoints for published postings.
 * Docs: https://github.com/lever/postings-api
 * robots.txt on api.lever.co: Allow /, Crawl-delay 1 (client spaces requests ≥1s).
 * Identifier "eu:<site>" targets the EU instance (api.eu.lever.co).
 */

function base(identifier: string): { host: string; site: string } {
  if (identifier.startsWith("eu:")) return { host: "https://api.eu.lever.co", site: identifier.slice(3) };
  return { host: "https://api.lever.co", site: identifier };
}

const LeverSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    hostedUrl: z.string(),
    applyUrl: z.string().nullish(),
    createdAt: z.number().nullish(),
    updatedAt: z.number().nullish(),
    country: z.string().nullish(),
    workplaceType: z.string().nullish(),
    categories: z
      .object({
        location: z.string().nullish(),
        commitment: z.string().nullish(),
        team: z.string().nullish(),
        department: z.string().nullish(),
        allLocations: z.array(z.string()).nullish(),
      })
      .passthrough()
      .nullish(),
    description: z.string().nullish(),
    descriptionPlain: z.string().nullish(),
    lists: z.array(z.object({ text: z.string(), content: z.string() })).nullish(),
    additional: z.string().nullish(),
    salaryRange: z
      .object({ min: z.number().nullish(), max: z.number().nullish(), currency: z.string().nullish(), interval: z.string().nullish() })
      .nullish(),
  })
  .passthrough();

type LeverPosting = z.infer<typeof LeverSchema>;

function workplace(w: string | null | undefined): WorkplaceType | null {
  switch ((w ?? "").toLowerCase()) {
    case "remote":
      return "REMOTE";
    case "hybrid":
      return "HYBRID";
    case "onsite":
    case "on-site":
      return "ONSITE";
    default:
      return null;
  }
}

function salary(s: LeverPosting["salaryRange"]): Salary | null {
  if (!s || (s.min == null && s.max == null)) return null;
  const interval = (s.interval ?? "").toLowerCase();
  return {
    min: s.min ?? null,
    max: s.max ?? null,
    currency: s.currency ?? null,
    period: /year|annual/.test(interval) ? "YEAR" : /month/.test(interval) ? "MONTH" : /hour/.test(interval) ? "HOUR" : "UNKNOWN",
    source: "lever:salaryRange",
  };
}

export function normalizeLever(p: LeverPosting): NormalizedJob {
  const description = [
    htmlToText(p.description),
    ...(p.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`),
    htmlToText(p.additional),
  ]
    .filter(Boolean)
    .join("\n\n");
  const created = safeDate(p.createdAt);
  const { description: _d, descriptionPlain: _dp, lists: _l, additional: _a, ...rest } = p;
  void _d; void _dp; void _l; void _a;
  return {
    externalId: p.id,
    title: p.text.trim(),
    reportedCompanyName: null,
    department: p.categories?.department ?? null,
    team: p.categories?.team ?? null,
    employmentType: p.categories?.commitment ?? null,
    locationRaw: p.categories?.location ?? null,
    locations: p.categories?.allLocations ?? [],
    workplaceHint: workplace(p.workplaceType),
    countryCodes: p.country ? [p.country.toUpperCase()] : [],
    descriptionText: description,
    sourceUrl: p.hostedUrl,
    applyUrl: p.applyUrl ?? null,
    postedAt: created,
    postedAtSource: created ? "ATS_CREATED_AT" : "UNKNOWN",
    employerUpdatedAt: safeDate(p.updatedAt),
    validThrough: null,
    salary: salary(p.salaryRange),
    requisitionId: null,
    feedEvidence: "ATS_FEED_LISTED",
    raw: rest,
  };
}

export const lever: SourceAdapter = {
  kind: "LEVER",
  label: "Lever",
  docsUrl: "https://github.com/lever/postings-api",
  boardUrl: (id) => {
    const { site } = base(id);
    return `https://jobs.${id.startsWith("eu:") ? "eu." : ""}lever.co/${encodeURIComponent(site)}`;
  },

  async fetchFeed(identifier, http): Promise<FeedResult> {
    const { host, site } = base(identifier);
    const url = `${host}/v0/postings/${encodeURIComponent(site)}?mode=json`;
    const { res, data } = await http.json(url);
    if (res.status === 404) throw new SourceError(`Lever site "${site}" not found`, "BOARD_NOT_FOUND", 404);
    if (!res.ok || data === null) throw new SourceError(`Lever HTTP ${res.status}`, "HTTP", res.status);
    const parsed = z.array(LeverSchema).safeParse(data);
    if (!parsed.success) throw new SourceError(`Unexpected Lever response: ${parsed.error.issues[0]?.message}`, "SCHEMA");
    return { jobs: parsed.data.map(normalizeLever), complete: true, reportedCompanyName: null, httpStatus: res.status, ms: res.ms, sourceUrl: url };
  },

  async checkJob(identifier, id, http): Promise<DetailCheck> {
    const { host, site } = base(identifier);
    const url = `${host}/v0/postings/${encodeURIComponent(site)}/${encodeURIComponent(id)}`;
    const { res, data } = await http.json(url).catch((e) => {
      if (e instanceof HttpError && e.status === 404) return { res: null, data: null };
      throw e;
    });
    if (res && res.status === 404) {
      // Lever returns {"ok":false,"error":"Document not found"} for removed postings.
      const body = safeParse(res.text);
      if (body && (body as { ok?: boolean }).ok === false) {
        return { evidence: "ATS_DETAIL_NOT_FOUND", httpStatus: 404, checkedUrl: url, finalUrl: res.url, redirected: res.redirected, ms: res.ms, detail: "Lever posting endpoint reports 'Document not found'" };
      }
      throw new HttpError("Lever returned an unexpected 404 body", "SERVER", 404);
    }
    if (!res || !res.ok || !data) throw new HttpError(`Lever HTTP ${res?.status ?? "?"}`, "SERVER", res?.status);
    const parsed = LeverSchema.safeParse(data);
    if (!parsed.success) throw new SourceError("Unexpected Lever posting response", "SCHEMA");
    const job = normalizeLever(parsed.data);
    return {
      evidence: job.applyUrl ? "ATS_DETAIL_ACTIVE" : "ATS_FEED_LISTED",
      httpStatus: res.status,
      checkedUrl: url,
      finalUrl: res.url,
      redirected: res.redirected,
      ms: res.ms,
      detail: job.applyUrl ? "Published posting with an application URL" : "Published posting without an application URL",
      job,
    };
  },
};

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
