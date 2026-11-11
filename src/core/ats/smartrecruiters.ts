import { z } from "zod";
import { safeDate } from "../domain/recency";
import { htmlToText } from "../domain/text";
import { HttpError } from "./http";
import { SourceError, type DetailCheck, type FeedResult, type NormalizedJob, type SourceAdapter } from "./types";

/**
 * SmartRecruiters Posting API (public postings; OAuth only for internal ones).
 * Docs: https://developers.smartrecruiters.com/reference/v1listpostings
 *
 * NOTE: api.smartrecruiters.com/robots.txt disallows generic agents. Because
 * the Posting API is documented for programmatic use, the adapter exists, but
 * new SmartRecruiters sources are created DISABLED and require explicit opt-in.
 * Unknown company identifiers return 200 with zero results, so an empty feed
 * is never treated as evidence of closure.
 */
const BASE = "https://api.smartrecruiters.com/v1/companies";
const PAGE = 100;
const MAX_PAGES = 20;

const LocationSchema = z
  .object({
    city: z.string().nullish(),
    region: z.string().nullish(),
    country: z.string().nullish(),
    remote: z.boolean().nullish(),
    hybrid: z.boolean().nullish(),
    fullLocation: z.string().nullish(),
  })
  .passthrough()
  .nullish();

const ListItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    refNumber: z.string().nullish(),
    company: z.object({ identifier: z.string().nullish(), name: z.string().nullish() }).passthrough().nullish(),
    releasedDate: z.string().nullish(),
    location: LocationSchema,
    department: z.object({ label: z.string().nullish() }).passthrough().nullish(),
    typeOfEmployment: z.object({ label: z.string().nullish() }).passthrough().nullish(),
    experienceLevel: z.object({ id: z.string().nullish(), label: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

const DetailSchema = ListItemSchema.extend({
  active: z.boolean().nullish(),
  visibility: z.string().nullish(),
  postingUrl: z.string().nullish(),
  applyUrl: z.string().nullish(),
  jobAd: z
    .object({ sections: z.record(z.string(), z.object({ title: z.string().nullish(), text: z.string().nullish() }).passthrough()).nullish() })
    .passthrough()
    .nullish(),
});

type ListItem = z.infer<typeof ListItemSchema>;
type Detail = z.infer<typeof DetailSchema>;

function postingUrl(company: string, id: string): string {
  return `https://jobs.smartrecruiters.com/${encodeURIComponent(company)}/${encodeURIComponent(id)}`;
}

function normalize(item: ListItem | Detail, company: string): NormalizedJob {
  const loc = item.location;
  const released = safeDate(item.releasedDate);
  const detail = item as Detail;
  const sections = detail.jobAd?.sections ?? {};
  const description = Object.values(sections)
    .map((s) => [s.title, htmlToText(s.text)].filter(Boolean).join("\n"))
    .join("\n\n");
  const { jobAd: _j, ...rest } = detail;
  void _j;
  return {
    externalId: item.id,
    title: item.name.trim(),
    reportedCompanyName: item.company?.name ?? null,
    department: item.department?.label ?? null,
    team: null,
    employmentType: item.typeOfEmployment?.label ?? null,
    locationRaw: loc?.fullLocation ?? ([loc?.city, loc?.region, loc?.country].filter(Boolean).join(", ") || null),
    locations: [],
    workplaceHint: loc?.remote ? "REMOTE" : loc?.hybrid ? "HYBRID" : loc ? "ONSITE" : null,
    countryCodes: loc?.country ? [loc.country.toUpperCase()] : [],
    descriptionText: description,
    sourceUrl: detail.postingUrl ?? postingUrl(company, item.id),
    applyUrl: detail.applyUrl ?? null,
    postedAt: released,
    postedAtSource: released ? "ATS_RELEASED_DATE" : "UNKNOWN",
    employerUpdatedAt: null,
    validThrough: null,
    salary: null,
    requisitionId: item.refNumber ?? null,
    feedEvidence: "ATS_FEED_LISTED",
    needsDetail: !description,
    raw: rest,
  };
}

export const smartrecruiters: SourceAdapter = {
  kind: "SMARTRECRUITERS",
  label: "SmartRecruiters",
  docsUrl: "https://developers.smartrecruiters.com/reference/v1listpostings",
  boardUrl: (c) => `https://jobs.smartrecruiters.com/${encodeURIComponent(c)}`,

  async fetchFeed(company, http): Promise<FeedResult> {
    const jobs: NormalizedJob[] = [];
    let total = Infinity;
    let firstStatus = 0;
    let ms = 0;
    let reported: string | null = null;
    for (let page = 0; page < MAX_PAGES && jobs.length < total; page++) {
      const url = `${BASE}/${encodeURIComponent(company)}/postings?limit=${PAGE}&offset=${page * PAGE}`;
      const { res, data } = await http.json(url);
      if (!res.ok || !data) throw new SourceError(`SmartRecruiters HTTP ${res.status}`, "HTTP", res.status);
      firstStatus ||= res.status;
      ms += res.ms;
      const parsed = z.object({ totalFound: z.number(), content: z.array(ListItemSchema) }).passthrough().safeParse(data);
      if (!parsed.success) throw new SourceError("Unexpected SmartRecruiters response", "SCHEMA");
      total = parsed.data.totalFound;
      reported ??= parsed.data.content[0]?.company?.name ?? null;
      jobs.push(...parsed.data.content.map((i) => normalize(i, company)));
      if (!parsed.data.content.length) break;
    }
    return {
      jobs,
      // SmartRecruiters answers 0 for unknown company ids too, so an empty
      // feed proves nothing: mark it incomplete (no closures, no "failure").
      complete: total > 0 && jobs.length >= total,
      reportedCompanyName: reported,
      httpStatus: firstStatus,
      ms,
      sourceUrl: `${BASE}/${encodeURIComponent(company)}/postings`,
    };
  },

  async checkJob(company, id, http): Promise<DetailCheck> {
    const url = `${BASE}/${encodeURIComponent(company)}/postings/${encodeURIComponent(id)}`;
    const { res, data } = await http.json(url);
    if (res.status === 404) {
      return { evidence: "ATS_DETAIL_NOT_FOUND", httpStatus: 404, checkedUrl: url, finalUrl: res.url, redirected: res.redirected, ms: res.ms, detail: "SmartRecruiters posting endpoint returned RESOURCE_NOT_FOUND" };
    }
    if (!res.ok || !data) throw new HttpError(`SmartRecruiters HTTP ${res.status}`, "SERVER", res.status);
    const parsed = DetailSchema.safeParse(data);
    if (!parsed.success) throw new SourceError("Unexpected SmartRecruiters posting response", "SCHEMA");
    const job = normalize(parsed.data, company);
    const active = parsed.data.active;
    return {
      evidence: active === true ? "ATS_DETAIL_ACTIVE" : active === false ? "ATS_DETAIL_INACTIVE" : "ATS_FEED_LISTED",
      httpStatus: res.status,
      checkedUrl: url,
      finalUrl: res.url,
      redirected: res.redirected,
      ms: res.ms,
      detail: `SmartRecruiters reports active=${String(active)}, visibility=${parsed.data.visibility ?? "?"}`,
      job,
      metadata: { active, visibility: parsed.data.visibility },
    };
  },
};
