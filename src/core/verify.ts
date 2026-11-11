import { ADAPTERS, parseAtsUrl, type AtsRef } from "./ats";
import { HttpError, type HttpClient } from "./ats/http";
import { SourceError, type NormalizedJob } from "./ats/types";
import { classifyLocation } from "./domain/location";
import { classifyRole } from "./domain/roles";
import type { Eligibility, LocationTier, SourceKind, WorkplaceType } from "./domain/types";
import { statusFor, type EvidenceType, type JobStatus } from "./domain/verification";

/** Boards this service checks. SmartRecruiters is excluded: its API host's robots.txt disallows generic agents. */
export const SUPPORTED: SourceKind[] = ["GREENHOUSE", "LEVER", "ASHBY", "WORKABLE"];

export interface Verification {
  url: string;
  status: JobStatus;
  checkedAt: string;
  evidence: { type: EvidenceType; board: SourceKind; boardId: string; jobId: string; endpoint: string; httpStatus: number | null; ms: number | null; detail: string };
  job: null | {
    title: string;
    company: string | null;
    location: string | null;
    workplace: WorkplaceType;
    postedAt: string | null;
    applyUrl: string | null;
    isSoftwareRole: boolean;
  };
  /** Can someone based in India apply? Deterministic rules over the posting's own location data and text. */
  india: null | { eligibility: Eligibility; tier: LocationTier; reasons: string[] };
}

/** Input problems the caller can fix; reported before any payment is requested. */
export class InputError extends Error {
  constructor(message: string, public readonly code: "INVALID_URL" | "UNSUPPORTED_BOARD" | "NO_JOB_ID") {
    super(message);
    this.name = "InputError";
  }
}

/** The posting's board couldn't be reached or answered unexpectedly; nothing was verified (and nothing is charged). */
export class UpstreamError extends Error {
  constructor(message: string, public readonly status: 404 | 502) {
    super(message);
    this.name = "UpstreamError";
  }
}

export function parsePosting(url: string): AtsRef & { externalId: string } {
  const ref = parseAtsUrl(url);
  if (!ref) throw new InputError("Not a recognised job-board posting URL (Greenhouse, Lever, Ashby or Workable, https only)", "INVALID_URL");
  if (!SUPPORTED.includes(ref.kind)) throw new InputError(`${ref.kind} postings aren't checked by this service`, "UNSUPPORTED_BOARD");
  if (!ref.externalId) throw new InputError("The URL points at a board, not a single posting", "NO_JOB_ID");
  return { ...ref, externalId: ref.externalId };
}

export async function verifyPosting(url: string, http: HttpClient, now = new Date()): Promise<Verification> {
  const ref = parsePosting(url);
  const adapter = ADAPTERS[ref.kind];
  let evidence: EvidenceType;
  let job: NormalizedJob | undefined;
  let endpoint: string;
  let httpStatus: number | null;
  let ms: number | null;
  let detail: string;
  try {
    if (adapter.checkJob) {
      const d = await adapter.checkJob(ref.identifier, ref.externalId, http);
      ({ evidence, job, detail, ms } = d);
      endpoint = d.checkedUrl;
      httpStatus = d.httpStatus;
    } else {
      // Boards with no per-job endpoint (Ashby, Workable): the complete official feed is the authority.
      const feed = await adapter.fetchFeed(ref.identifier, http);
      job = feed.jobs.find((j) => j.externalId === ref.externalId);
      evidence = job ? job.feedEvidence : feed.complete ? "FEED_MISSING" : "CHECK_FAILED";
      endpoint = feed.sourceUrl;
      httpStatus = feed.httpStatus;
      ms = feed.ms;
      detail = job ? "Listed in the employer's official job feed" : feed.complete ? "Not in the employer's complete official job feed" : "Feed is incomplete; absence proves nothing";
    }
  } catch (e) {
    if (e instanceof SourceError && e.kind === "BOARD_NOT_FOUND") throw new UpstreamError(e.message, 404);
    if (e instanceof SourceError || e instanceof HttpError) throw new UpstreamError(`Couldn't check the board: ${e.message}`, 502);
    throw e;
  }
  if (evidence === "CHECK_FAILED") throw new UpstreamError(`Couldn't check the board: ${detail}`, 502);

  const loc = job
    ? classifyLocation({ locationRaw: job.locationRaw, locations: job.locations, workplaceHint: job.workplaceHint, countryCodes: job.countryCodes, description: job.descriptionText })
    : null;
  return {
    url,
    status: statusFor(evidence),
    checkedAt: now.toISOString(),
    evidence: { type: evidence, board: ref.kind, boardId: ref.identifier, jobId: ref.externalId, endpoint, httpStatus, ms, detail },
    job: job
      ? {
          title: job.title,
          company: job.reportedCompanyName,
          location: job.locationRaw,
          workplace: loc!.workplaceType,
          postedAt: job.postedAt?.toISOString() ?? null,
          applyUrl: job.applyUrl,
          isSoftwareRole: classifyRole(job.title).isSoftwareRole,
        }
      : null,
    india: loc ? { eligibility: loc.eligibility, tier: loc.tier, reasons: loc.reasons } : null,
  };
}
