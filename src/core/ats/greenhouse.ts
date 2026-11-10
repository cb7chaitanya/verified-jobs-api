import { z } from "zod";
import { safeDate } from "../domain/recency";
import { htmlToText } from "../domain/text";
import type { Salary, WorkplaceType } from "../domain/types";
import { HttpError } from "./http";
import { SourceError, type DetailCheck, type FeedResult, type NormalizedJob, type SourceAdapter } from "./types";

/**
 * Greenhouse Job Board API — public, unauthenticated GET endpoints.
 * Docs: https://developers.greenhouse.io/job-board.html
 * robots.txt on boards-api.greenhouse.io only disallows /embed/.
 */
const BASE = "https://boards-api.greenhouse.io/v1/boards";

const MetadataSchema = z
  .object({ name: z.string().nullish(), value: z.unknown() })
  .passthrough();

const GhJobSchema = z
  .object({
    id: z.number(),
    title: z.string(),
    absolute_url: z.string(),
    updated_at: z.string().nullish(),
    first_published: z.string().nullish(),
    requisition_id: z.string().nullish(),
    company_name: z.string().nullish(),
    application_deadline: z.string().nullish(),
    location: z.object({ name: z.string().nullish() }).nullish(),
    content: z.string().nullish(),
    departments: z.array(z.object({ name: z.string() }).passthrough()).nullish(),
    offices: z.array(z.object({ name: z.string().nullish(), location: z.string().nullish() }).passthrough()).nullish(),
    metadata: z.array(MetadataSchema).nullish(),
    questions: z.array(z.unknown()).nullish(),
    pay_input_ranges: z
      .array(z.object({ min_cents: z.number().nullish(), max_cents: z.number().nullish(), currency_type: z.string().nullish(), title: z.string().nullish() }).passthrough())
      .nullish(),
  })
  .passthrough();

const GhFeedSchema = z.object({ jobs: z.array(GhJobSchema), meta: z.object({ total: z.number() }).passthrough().nullish() });

type GhJob = z.infer<typeof GhJobSchema>;

function workplaceFromMetadata(md: GhJob["metadata"]): WorkplaceType | null {
  for (const m of md ?? []) {
    if (!m.name || !/workplace|work arrangement|remote|location type/i.test(m.name)) continue;
    const v = JSON.stringify(m.value ?? "").toLowerCase();
    if (/hybrid/.test(v)) return "HYBRID";
    if (/remote/.test(v)) return "REMOTE";
    if (/office|onsite|on-site/.test(v)) return "ONSITE";
  }
  return null;
}

function salaryFromPayRanges(ranges: GhJob["pay_input_ranges"]): Salary | null {
  const r = ranges?.[0];
  if (!r || (r.min_cents == null && r.max_cents == null)) return null;
  return {
    min: r.min_cents != null ? r.min_cents / 100 : null,
    max: r.max_cents != null ? r.max_cents / 100 : null,
    currency: r.currency_type ?? null,
    period: "YEAR",
    source: "greenhouse:pay_input_ranges",
    summary: r.title ?? undefined,
  };
}

export function normalizeGreenhouse(j: GhJob): NormalizedJob {
  const offices = (j.offices ?? []).map((o) => o.location || o.name).filter((x): x is string => !!x);
  const first = safeDate(j.first_published);
  const updated = safeDate(j.updated_at);
  const { content, questions, ...rest } = j;
  void questions;
  return {
    externalId: String(j.id),
    title: j.title.trim(),
    reportedCompanyName: j.company_name ?? null,
    department: j.departments?.[0]?.name ?? null,
    team: null,
    employmentType: null,
    locationRaw: j.location?.name ?? null,
    locations: [...new Set(offices)],
    workplaceHint: workplaceFromMetadata(j.metadata),
    countryCodes: [],
    descriptionText: htmlToText(content),
    sourceUrl: j.absolute_url,
    applyUrl: j.absolute_url,
    postedAt: first,
    postedAtSource: first ? "ATS_FIRST_PUBLISHED" : "UNKNOWN",
    employerUpdatedAt: updated,
    validThrough: safeDate(j.application_deadline),
    salary: salaryFromPayRanges(j.pay_input_ranges),
    requisitionId: j.requisition_id ?? null,
    feedEvidence: "ATS_FEED_LISTED",
    raw: { ...rest, content_length: content?.length ?? 0 },
  };
}

export const greenhouse: SourceAdapter = {
  kind: "GREENHOUSE",
  label: "Greenhouse",
  docsUrl: "https://developers.greenhouse.io/job-board.html",
  boardUrl: (t) => `https://job-boards.greenhouse.io/${encodeURIComponent(t)}`,

  async fetchFeed(token, http): Promise<FeedResult> {
    const url = `${BASE}/${encodeURIComponent(token)}/jobs?content=true`;
    const { res, data } = await http.json(url);
    if (res.status === 404) throw new SourceError(`Greenhouse board "${token}" not found`, "BOARD_NOT_FOUND", 404);
    if (!res.ok || !data) throw new SourceError(`Greenhouse HTTP ${res.status}`, "HTTP", res.status);
    const parsed = GhFeedSchema.safeParse(data);
    if (!parsed.success) throw new SourceError(`Unexpected Greenhouse response: ${parsed.error.issues[0]?.message}`, "SCHEMA");
    const jobs = parsed.data.jobs.map(normalizeGreenhouse);
    return {
      jobs,
      complete: parsed.data.meta?.total === undefined || parsed.data.meta.total === jobs.length,
      reportedCompanyName: jobs[0]?.reportedCompanyName ?? null,
      httpStatus: res.status,
      ms: res.ms,
      sourceUrl: url,
    };
  },

  async checkJob(token, id, http): Promise<DetailCheck> {
    const url = `${BASE}/${encodeURIComponent(token)}/jobs/${encodeURIComponent(id)}?questions=true&pay_transparency=true`;
    const { res, data } = await http.json(url);
    if (res.status === 404) {
      // Only conclude closure if the board itself is healthy.
      const board = await http.request(`${BASE}/${encodeURIComponent(token)}`, { purpose: "api" });
      if (!board.ok) throw new HttpError(`Board check returned ${board.status}`, "SERVER", board.status);
      return { evidence: "ATS_DETAIL_NOT_FOUND", httpStatus: 404, checkedUrl: url, finalUrl: res.url, redirected: res.redirected, ms: res.ms, detail: "Greenhouse job endpoint returned 404; board is healthy" };
    }
    if (!res.ok || !data) throw new HttpError(`Greenhouse HTTP ${res.status}`, "SERVER", res.status);
    const parsed = GhJobSchema.safeParse(data);
    if (!parsed.success) throw new SourceError("Unexpected Greenhouse job response", "SCHEMA");
    const job = normalizeGreenhouse(parsed.data);
    const deadline = job.validThrough;
    if (deadline && deadline.getTime() < Date.now()) {
      return { evidence: "PAGE_EXPIRED", httpStatus: res.status, checkedUrl: url, finalUrl: res.url, redirected: res.redirected, ms: res.ms, detail: "Application deadline has passed", job };
    }
    const acceptsApplications = (parsed.data.questions?.length ?? 0) > 0;
    return {
      evidence: acceptsApplications ? "ATS_DETAIL_ACTIVE" : "ATS_FEED_LISTED",
      httpStatus: res.status,
      checkedUrl: url,
      finalUrl: res.url,
      redirected: res.redirected,
      ms: res.ms,
      detail: acceptsApplications
        ? `Job is live with an application form (${parsed.data.questions!.length} questions)`
        : "Job is live but no application form was returned",
      job,
      metadata: { questionCount: parsed.data.questions?.length ?? 0 },
    };
  },
};
