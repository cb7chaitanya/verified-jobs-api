import type { EvidenceType } from "../domain/verification";
import type { PostedDateSource, Salary, SourceKind, WorkplaceType } from "../domain/types";
import type { HttpClient } from "./http";

/** Source-agnostic job shape produced by every adapter. */
export interface NormalizedJob {
  externalId: string;
  title: string;
  reportedCompanyName: string | null;
  department: string | null;
  team: string | null;
  employmentType: string | null;
  locationRaw: string | null;
  locations: string[];
  workplaceHint: WorkplaceType | null;
  countryCodes: string[];
  descriptionText: string;
  /** Employer-hosted posting page. */
  sourceUrl: string;
  applyUrl: string | null;
  postedAt: Date | null;
  postedAtSource: PostedDateSource;
  employerUpdatedAt: Date | null;
  validThrough: Date | null;
  salary: Salary | null;
  requisitionId: string | null;
  /** Feed-level evidence for this job (e.g. Ashby listed + applyUrl). */
  feedEvidence: EvidenceType;
  /** Description must be fetched via checkJob (SmartRecruiters list lacks it). */
  needsDetail?: boolean;
  raw: Record<string, unknown>;
}

export interface FeedResult {
  jobs: NormalizedJob[];
  /** True when the feed is the employer's complete public list (absence is meaningful). */
  complete: boolean;
  reportedCompanyName: string | null;
  httpStatus: number;
  ms: number;
  sourceUrl: string;
}

export interface DetailCheck {
  evidence: EvidenceType;
  httpStatus: number | null;
  checkedUrl: string;
  finalUrl: string | null;
  redirected: boolean;
  ms: number | null;
  detail: string;
  /** Enriched job data (e.g. full description) when the endpoint returns it. */
  job?: NormalizedJob;
  metadata?: Record<string, unknown>;
}

export class SourceError extends Error {
  constructor(
    message: string,
    public readonly kind: "BOARD_NOT_FOUND" | "SCHEMA" | "HTTP" | "UNSUPPORTED",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export interface SourceAdapter {
  kind: SourceKind;
  label: string;
  /** Official documentation consulted for this adapter. */
  docsUrl: string;
  /** Public job board URL for humans. */
  boardUrl(identifier: string): string;
  fetchFeed(identifier: string, http: HttpClient): Promise<FeedResult>;
  /** Per-job verification against the official endpoint, if the ATS offers one. */
  checkJob?(identifier: string, externalId: string, http: HttpClient): Promise<DetailCheck>;
}
