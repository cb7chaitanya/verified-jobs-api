import { HttpClient } from "../src/core/ats/http";

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Canned job-board responses, matched by URL fragment (longest wins). Unmatched URLs return 404. */
export class FakeNet {
  routes = new Map<string, Route>();
  calls: string[] = [];
  on(fragment: string, route: Route | object | string, status = 200) {
    this.routes.set(fragment, typeof route === "function" ? (route as Route) : () => new Response(typeof route === "string" ? route : JSON.stringify(route), { status }));
    return this;
  }
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    this.calls.push(url);
    const match = [...this.routes.keys()].filter((k) => url.includes(k)).sort((a, b) => b.length - a.length)[0];
    if (!match) return new Response(JSON.stringify({ status: 404, error: "Not found" }), { status: 404 });
    return this.routes.get(match)!(url, init);
  };
  client() {
    return new HttpClient({ userAgent: "test", minIntervalMs: 0, fetchImpl: this.fetch as typeof fetch, sleep: async () => {}, assertHost: async () => {} });
  }
}

/** A made-up Greenhouse job (fictional company). */
export function ghJob(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    title: "Backend Engineer, Payments",
    absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    updated_at: "2026-11-10T10:00:00-05:00",
    first_published: "2026-11-09T10:00:00-05:00",
    requisition_id: `R-${id}`,
    company_name: "Acme Payments",
    location: { name: "Bengaluru, India" },
    content: "&lt;p&gt;Build the ledger.&lt;/p&gt;",
    departments: [{ name: "Engineering" }],
    offices: [],
    metadata: [],
    questions: [{ label: "Resume", required: true, fields: [{ name: "resume", type: "input_file" }] }],
    ...over,
  };
}

/** A made-up Ashby job. */
export function ashbyJob(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title: "Senior Software Engineer",
    location: "Remote - US",
    isListed: true,
    isRemote: true,
    workplaceType: "Remote",
    publishedAt: "2026-11-12T00:00:00Z",
    jobUrl: `https://jobs.ashbyhq.com/acme/${id}`,
    applyUrl: `https://jobs.ashbyhq.com/acme/${id}/application`,
    descriptionPlain: "Join us.",
    address: { postalAddress: { addressCountry: "United States" } },
    ...over,
  };
}
