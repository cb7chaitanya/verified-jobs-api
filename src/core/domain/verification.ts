/**
 * What a check against the employer's own job board observed, strongest first.
 *  - ATS_DETAIL_ACTIVE      the per-job endpoint returned the job and it accepts applications
 *  - ATS_FEED_LISTED_APPLY  listed in the complete official feed with an application URL (Ashby has no per-job endpoint)
 *  - ATS_FEED_LISTED        listed in the feed; application availability not separately established
 *  - ATS_DETAIL_NOT_FOUND   per-job endpoint returned 404/410 while the board itself is healthy
 *  - ATS_DETAIL_INACTIVE    the ATS reports the requisition inactive
 *  - FEED_MISSING           absent from a healthy, complete feed
 *  - CHECK_FAILED           network error, 5xx, 429 or an unexpected response shape
 *  - PAGE_EXPIRED           Greenhouse: the posting's application deadline has passed
 * (Other PAGE_* values come from page readers, which this service doesn't include.)
 */
export type EvidenceType =
  | "ATS_DETAIL_ACTIVE"
  | "ATS_FEED_LISTED_APPLY"
  | "ATS_FEED_LISTED"
  | "PAGE_JSONLD_VALID"
  | "PAGE_FETCHED"
  | "ATS_DETAIL_NOT_FOUND"
  | "ATS_DETAIL_INACTIVE"
  | "FEED_MISSING"
  | "PAGE_EXPIRED"
  | "REDIRECT_TO_CAREERS"
  | "CHECK_FAILED";

export type JobStatus = "OPEN" | "CLOSED" | "UNKNOWN";

/** One check is a point-in-time observation, so it maps to OPEN/CLOSED only on direct evidence. */
export function statusFor(evidence: EvidenceType): JobStatus {
  switch (evidence) {
    case "ATS_DETAIL_ACTIVE":
    case "ATS_FEED_LISTED_APPLY":
    case "ATS_FEED_LISTED":
      return "OPEN";
    case "ATS_DETAIL_NOT_FOUND":
    case "ATS_DETAIL_INACTIVE":
    case "FEED_MISSING":
    case "PAGE_EXPIRED": // Greenhouse: the application deadline has passed
      return "CLOSED";
    default:
      return "UNKNOWN";
  }
}
