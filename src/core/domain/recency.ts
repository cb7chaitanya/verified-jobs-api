import type { PostedDateSource } from "./types";

export type RecencyBucket = "0-7" | "8-14" | "15-30" | "31-60" | "61-90" | "90+" | "UNKNOWN";

export const RECENCY_LABELS: Record<RecencyBucket, string> = {
  "0-7": "Very fresh",
  "8-14": "Fresh",
  "15-30": "Recent",
  "31-60": "Older",
  "61-90": "Old",
  "90+": "Stale",
  UNKNOWN: "Unknown",
};

const DAY = 86_400_000;

/**
 * Age is computed ONLY from the employer-provided posting date. The date
 * this service first saw a job is never substituted.
 */
export function jobAgeDays(postedAt: Date | null, now: Date = new Date()): number | null {
  if (!postedAt) return null;
  const diff = now.getTime() - postedAt.getTime();
  // Future dates (timezone skew) clamp to 0; wildly future → treat as unknown.
  if (diff < -2 * DAY) return null;
  return Math.max(0, Math.floor(diff / DAY));
}

export function recencyBucket(ageDays: number | null): RecencyBucket {
  if (ageDays === null) return "UNKNOWN";
  if (ageDays <= 7) return "0-7";
  if (ageDays <= 14) return "8-14";
  if (ageDays <= 30) return "15-30";
  if (ageDays <= 60) return "31-60";
  if (ageDays <= 90) return "61-90";
  return "90+";
}

const BUCKET_SCORE: Record<RecencyBucket, number> = {
  "0-7": 1,
  "8-14": 0.9,
  "15-30": 0.8,
  "31-60": 0.55,
  "61-90": 0.35,
  "90+": 0.15,
  UNKNOWN: 0.2,
};

/**
 * Recency score 0..1. A 90+ day posting recently reconfirmed open by the
 * employer ATS is lifted slightly ("evergreen but live"), never to "new".
 */
export function recencyScore(
  postedAt: Date | null,
  opts: { lastVerifiedOpenAt?: Date | null; now?: Date } = {},
): { score: number; bucket: RecencyBucket; ageDays: number | null; note: string } {
  const now = opts.now ?? new Date();
  const age = jobAgeDays(postedAt, now);
  const bucket = recencyBucket(age);
  let score = BUCKET_SCORE[bucket];
  let note = age === null ? "Posting date unknown — not assumed recent" : `Posted ${age} day${age === 1 ? "" : "s"} ago`;
  if (bucket === "90+" && opts.lastVerifiedOpenAt && now.getTime() - opts.lastVerifiedOpenAt.getTime() < 3 * DAY) {
    score = 0.3;
    note += " (old posting, but reconfirmed open recently)";
  }
  return { score, bucket, ageDays: age, note };
}

export const DATE_SOURCE_CONFIDENCE: Record<PostedDateSource, number> = {
  ATS_FIRST_PUBLISHED: 0.95,
  ATS_PUBLISHED_AT: 0.9,
  ATS_RELEASED_DATE: 0.85,
  ATS_CREATED_AT: 0.8, // Lever createdAt = posting created; may predate publishing
  JSONLD_DATE_POSTED: 0.7,
  USER_PROVIDED: 0.6,
  UNKNOWN: 0,
};

/** Parse a date defensively; returns null for invalid/implausible values. */
export function safeDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = typeof v === "number" ? new Date(v) : new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 2000 || y > 2100) return null;
  return d;
}

/**
 * Ranking penalty for posting age, used by the default "Best" sort:
 * rank = match score − penalty. Scores measure fit; this makes a 2-year-old
 * evergreen posting sink below a comparable role posted last week, without
 * hiding it. Unknown dates get a moderate penalty (never treated as fresh).
 * Single source of truth for the SQL ordering in features/jobs/queries.ts.
 */
export const AGE_PENALTY_STEPS: readonly (readonly [maxDays: number, penalty: number])[] = [
  [7, 0],
  [14, 1],
  [30, 3],
  [60, 6],
  [90, 10],
  [180, 18],
  [365, 28],
];
export const AGE_PENALTY_OLDER = 40;
export const AGE_PENALTY_UNKNOWN = 8;

export function agePenalty(ageDays: number | null): number {
  if (ageDays === null) return AGE_PENALTY_UNKNOWN;
  for (const [max, pen] of AGE_PENALTY_STEPS) if (ageDays <= max) return pen;
  return AGE_PENALTY_OLDER;
}
