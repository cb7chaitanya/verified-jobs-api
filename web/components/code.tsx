"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy } from "./icons";

export type Lang = "ts" | "bash" | "json" | "http" | "text";

/**
 * A code block with a copy button. Highlighting is a small tokenizer (comments, strings, numbers,
 * keywords) rather than a library: enough for the short samples on this site.
 */
export function Code({ code, lang = "ts", title, className = "" }: { code: string; lang?: Lang; title?: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <div className={`group relative min-w-0 overflow-hidden rounded-xl border border-line bg-code ${className}`}>
      {title && <div className="border-b border-line px-4 py-2 font-mono text-xs text-faint">{title}</div>}
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy code"}
        className={`absolute right-2 ${title ? "top-1" : "top-2"} inline-flex size-7 items-center justify-center rounded-md text-faint opacity-0 transition group-hover:opacity-100 hover:bg-raised hover:text-fg focus-visible:opacity-100`}
      >
        {copied ? <Check className="text-ok" /> : <Copy />}
      </button>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed">
        <code>{highlight(code, lang)}</code>
      </pre>
    </div>
  );
}

const TS_KW = new Set(["import", "from", "export", "const", "let", "await", "async", "new", "return", "function", "if", "else", "for", "of", "type", "interface"]);
const SH_CMD = new Set(["pnpm", "curl", "npm", "npx", "git", "cd", "export", "solana", "anchor", "cargo", "base64", "jq"]);
const LITERAL = new Set(["true", "false", "null", "undefined"]);

const PATTERNS: Record<Exclude<Lang, "text">, RegExp> = {
  ts: /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g,
  bash: /(#[^\n]*)|("[^"\n]*"|'[^'\n]*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w-]*)/g,
  json: /(\u0000)|("(?:[^"\\\n]|\\.)*")|(-?\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)/g,
  http: /(\u0000)|("(?:[^"\\\n]|\\.)*")|(\b\d{3}\b)|([A-Za-z_][\w-]*)/g,
};

function classify(lang: Lang, tok: string, kind: "comment" | "string" | "number" | "word", rest: string): string {
  if (kind === "comment") return "text-faint italic";
  if (kind === "string") return lang === "json" && /^\s*:/.test(rest) ? "text-code-key" : "text-ok";
  if (kind === "number") return "text-warn";
  if (LITERAL.has(tok)) return "text-warn";
  if (lang === "ts" && TS_KW.has(tok)) return "text-code-kw";
  if (lang === "bash" && SH_CMD.has(tok)) return "text-code-kw";
  if (lang === "http" && /^(GET|POST|HTTP)$/.test(tok)) return "text-code-kw";
  if (lang === "http" && /^[A-Z][A-Z-]+$/.test(tok) && /^:/.test(rest)) return "text-code-key";
  return "";
}

function highlight(code: string, lang: Lang): ReactNode[] {
  if (lang === "text") return [code];
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of code.matchAll(PATTERNS[lang])) {
    const at = m.index ?? 0;
    const tok = m[0];
    if (at > last) out.push(code.slice(last, at));
    const kind = m[1] ? "comment" : m[2] ? "string" : m[3] ? "number" : "word";
    const cls = classify(lang, tok, kind, code.slice(at + tok.length, at + tok.length + 4));
    out.push(
      cls ? (
        <span key={key++} className={cls}>
          {tok}
        </span>
      ) : (
        tok
      ),
    );
    last = at + tok.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}
