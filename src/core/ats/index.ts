import type { SourceKind } from "../domain/types";
import { ashby } from "./ashby";
import { greenhouse } from "./greenhouse";
import { HttpClient } from "./http";
import { lever } from "./lever";
import { smartrecruiters } from "./smartrecruiters";
import { workable } from "./workable";
import type { SourceAdapter } from "./types";

/** Only official, documented job-board APIs. No page scraping. */
export const ADAPTERS: Record<SourceKind, SourceAdapter> = {
  GREENHOUSE: greenhouse,
  LEVER: lever,
  ASHBY: ashby,
  SMARTRECRUITERS: smartrecruiters,
  WORKABLE: workable,
};

export const USER_AGENT = process.env.HTTP_USER_AGENT ?? "verified-jobs-api/0.1";

let shared: HttpClient | undefined;
export function httpClient(): HttpClient {
  shared ??= new HttpClient({ userAgent: USER_AGENT, minIntervalMs: 1000 });
  return shared;
}

export interface AtsRef {
  kind: SourceKind;
  identifier: string;
  externalId: string | null;
}

/** Recognise an official ATS posting URL so the check uses the documented API, not the HTML page. */
export function parseAtsUrl(input: string): AtsRef | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host) && parts[0]) {
    if (parts[0] === "embed") {
      const t = u.searchParams.get("for");
      const id = u.searchParams.get("token") ?? u.searchParams.get("gh_jid");
      return t ? { kind: "GREENHOUSE", identifier: t, externalId: id } : null;
    }
    const jobIdx = parts.indexOf("jobs");
    return { kind: "GREENHOUSE", identifier: parts[0], externalId: jobIdx >= 0 ? (parts[jobIdx + 1] ?? null) : null };
  }
  if (/^jobs(\.eu)?\.lever\.co$/.test(host) && parts[0]) {
    const eu = host.includes(".eu.");
    return { kind: "LEVER", identifier: `${eu ? "eu:" : ""}${parts[0]}`, externalId: parts[1] && parts[1] !== "apply" ? parts[1] : null };
  }
  if (host === "jobs.ashbyhq.com" && parts[0]) {
    return { kind: "ASHBY", identifier: decodeURIComponent(parts[0]), externalId: parts[1] && parts[1] !== "application" ? parts[1] : null };
  }
  if (host === "apply.workable.com" && parts[0]) {
    if (parts[0] === "j") return null; // the short form carries no account
    return { kind: "WORKABLE", identifier: parts[0], externalId: parts[1] === "j" ? (parts[2] ?? null) : null };
  }
  if ((host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") && parts[0]) {
    const m = parts[1] ? /^(\d+)/.exec(parts[1]) : null;
    return { kind: "SMARTRECRUITERS", identifier: parts[0], externalId: m?.[1] ?? null };
  }
  return null;
}
