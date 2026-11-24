"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { SITE } from "@/lib/site";
import { Github, Logo, Menu, X } from "./icons";
import { ThemeToggle } from "./theme-toggle";

const LINKS = [
  { href: "/playground", label: "Playground" },
  { href: "/docs", label: "Docs" },
  { href: "/benchmarks", label: "Benchmarks" },
  { href: "/security", label: "Security" },
];

export function Nav() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-md supports-[backdrop-filter]:bg-bg/70">
      <nav className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6" aria-label="Main">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <Logo />
          <span>{SITE.name}</span>
          <span className="rounded-full border border-line px-1.5 py-px font-mono text-[10px] font-medium tracking-wide text-muted uppercase">testnet</span>
        </Link>
        <ul className="hidden items-center gap-1 md:flex">
          {LINKS.map((l) => {
            const active = path === l.href || path.startsWith(l.href + "/");
            return (
              <li key={l.href}>
                <Link href={l.href} aria-current={active ? "page" : undefined} className={`rounded-md px-3 py-1.5 text-sm transition-colors ${active ? "text-fg" : "text-muted hover:text-fg"}`}>
                  {l.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="ml-auto flex items-center gap-1">
          <a href={SITE.repo} target="_blank" rel="noreferrer" aria-label="Source on GitHub" className="inline-flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg">
            <Github />
          </a>
          <ThemeToggle />
          <Link href="/playground" className="ml-2 hidden rounded-md bg-fg px-3 py-1.5 text-sm font-medium text-bg transition-opacity hover:opacity-85 sm:inline-flex">
            Try it
          </Link>
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="mobile-menu" aria-label="Menu" className="inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg md:hidden">
            {open ? <X /> : <Menu />}
          </button>
        </div>
      </nav>
      {open && (
        <ul id="mobile-menu" className="border-t border-line px-4 py-2 md:hidden">
          {LINKS.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="block rounded-md px-2 py-2.5 text-sm text-muted hover:bg-raised hover:text-fg">
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}
