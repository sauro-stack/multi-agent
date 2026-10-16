"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Deliberately tiny markdown renderer.
 *
 * Everything is HTML-escaped *before* any markup is applied, so model output
 * can never inject markup into the dashboard. Only the subset the agents
 * actually emit is supported: headings, lists, bold, inline code, links,
 * blockquotes and fenced code.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
    );
}

function blockToHtml(block: string): string {
  const lines = block.split("\n");
  const out: string[] = [];
  let list: string[] | null = null;
  let listType: "ul" | "ol" = "ul";

  const flush = () => {
    if (list) {
      out.push(`<${listType}>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</${listType}>`);
      list = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!list || listType !== "ul") {
        flush();
        list = [];
        listType = "ul";
      }
      list.push(bullet[1]);
      continue;
    }

    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      if (!list || listType !== "ol") {
        flush();
        list = [];
        listType = "ol";
      }
      list.push(numbered[1]);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flush();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    flush();
    out.push(`<p>${inline(line)}</p>`);
  }

  flush();
  return out.join("");
}

export function markdownToHtml(markdown: string): string {
  if (!markdown) return "";
  const escaped = escapeHtml(markdown);
  const segments = escaped.split(/```([a-zA-Z0-9+-]*)\n?([\s\S]*?)```/g);

  let html = "";
  for (let index = 0; index < segments.length; index += 3) {
    html += blockToHtml(segments[index] ?? "");
    const language = segments[index + 1];
    const code = segments[index + 2];
    if (code !== undefined) {
      html += `<pre data-code="${escapeHtml(language || "text")}"><code>${code.replace(
        /\n$/,
        "",
      )}</code></pre>`;
    }
  }
  return html;
}

export function Markdown({ content, className }: { content: string; className?: string }) {
  const html = React.useMemo(() => markdownToHtml(content), [content]);
  return <div className={cn("md-body", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function CodeBlock({
  code,
  language,
  className,
}: {
  code: string;
  language?: string | null;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className={cn("group relative overflow-hidden rounded-md border border-lab-border bg-lab-void/80", className)}>
      <div className="flex items-center justify-between border-b border-lab-border/70 bg-white/[0.02] px-3 py-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-lab-muted">
          {language || "code"}
        </span>
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-1 font-mono text-[10px] text-lab-muted transition-colors hover:text-lab-accent"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="max-h-[420px] overflow-auto px-3 py-2.5 font-mono text-[11.5px] leading-[1.6] text-[#c8d8ea]">
        <code>{code}</code>
      </pre>
    </div>
  );
}
