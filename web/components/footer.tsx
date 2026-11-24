import Link from "next/link";
import { SITE, explorerAddress } from "@/lib/site";
import { Logo } from "./icons";

export function Footer() {
  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="space-y-3">
          <div className="flex items-center gap-2 font-semibold">
            <Logo /> {SITE.name}
          </div>
          <p className="max-w-xs text-sm text-muted">Job postings checked against the employer&apos;s own board. Paid per call in USDC, over x402.</p>
          <p className="text-xs text-faint">Testnet only. Not professionally audited. Never send mainnet funds.</p>
        </div>
        <FooterCol
          title="Product"
          links={[
            ["Playground", "/playground"],
            ["Docs", "/docs"],
            ["Benchmarks", "/benchmarks"],
            ["Security", "/security"],
          ]}
        />
        <FooterCol
          title="Protocol"
          links={[
            ["x402", "https://x402.org"],
            ["Circle Gateway", "https://developers.circle.com/gateway/nanopayments"],
            ["pay_session program", explorerAddress(SITE.programId)],
          ]}
        />
        <FooterCol
          title="Source"
          links={[
            ["GitHub", SITE.repo],
            ["README", `${SITE.repo}#readme`],
          ]}
        />
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <h3 className="mb-3 text-xs font-medium tracking-wide text-faint uppercase">{title}</h3>
      <ul className="space-y-2">
        {links.map(([label, href]) => (
          <li key={label}>
            {href.startsWith("/") ? (
              <Link href={href} className="text-sm text-muted hover:text-fg">
                {label}
              </Link>
            ) : (
              <a href={href} target="_blank" rel="noreferrer" className="text-sm text-muted hover:text-fg">
                {label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
