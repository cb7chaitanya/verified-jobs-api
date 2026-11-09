/** Shared domain types for job verification. */

export const LOCATION_TIERS = ["INDIA_CITY", "INDIA_REMOTE", "GLOBAL_REMOTE_INDIA_OK", "REMOTE_UNSPECIFIED", "FOREIGN", "UNKNOWN"] as const;
export type LocationTier = (typeof LOCATION_TIERS)[number];

export type Eligibility = "ELIGIBLE" | "NEEDS_REVIEW" | "INELIGIBLE";
export type WorkplaceType = "ONSITE" | "HYBRID" | "REMOTE" | "UNKNOWN";
export type SourceKind = "GREENHOUSE" | "LEVER" | "ASHBY" | "SMARTRECRUITERS" | "WORKABLE";
export type PostedDateSource = "ATS_FIRST_PUBLISHED" | "ATS_CREATED_AT" | "ATS_PUBLISHED_AT" | "ATS_RELEASED_DATE" | "JSONLD_DATE_POSTED" | "USER_PROVIDED" | "UNKNOWN";

export interface Salary {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: "YEAR" | "MONTH" | "HOUR" | "UNKNOWN";
  source: string;
  summary?: string;
}
