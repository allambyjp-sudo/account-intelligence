import { parse, type HTMLElement } from "node-html-parser";

export interface PageText {
  title: string | null;
  description: string | null;
  /** Readable text with scripts, styles, navigation and footers removed. */
  text: string;
  links: Array<{ href: string; text: string }>;
  /** Raw markers for the tech footprint detector: script/link/iframe sources and meta generator. */
  assetUrls: string[];
  generator: string | null;
}

const NOISE = "script, style, noscript, svg, nav, footer, header, form, iframe, template";

export function extractPage(html: string, baseUrl: string): PageText {
  const root = parse(html, { comment: false });
  const assetUrls = [
    ...root.querySelectorAll("script[src]").map((e) => e.getAttribute("src")),
    ...root.querySelectorAll("link[href]").map((e) => e.getAttribute("href")),
    ...root.querySelectorAll("iframe[src]").map((e) => e.getAttribute("src")),
    ...root.querySelectorAll("img[src]").map((e) => e.getAttribute("src")),
  ]
    .filter((u): u is string => Boolean(u))
    .map((u) => absolute(u, baseUrl))
    .filter((u): u is string => Boolean(u));
  const inlineScripts = root.querySelectorAll("script:not([src])").map((e) => e.text.slice(0, 2000));

  const links = root
    .querySelectorAll("a[href]")
    .map((a) => ({ href: absolute(a.getAttribute("href") ?? "", baseUrl), text: a.text.replace(/\s+/g, " ").trim() }))
    .filter((l): l is { href: string; text: string } => Boolean(l.href));

  const meta = (name: string) =>
    root.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ??
    root.querySelector(`meta[property="og:${name}"]`)?.getAttribute("content") ??
    null;
  const title = root.querySelector("title")?.text.trim() || null;
  const generator = meta("generator");

  for (const el of root.querySelectorAll(NOISE)) el.remove();
  const main = (root.querySelector("main") ?? root.querySelector("article") ?? root.querySelector("body") ?? root) as HTMLElement;
  const text = blockText(main);

  return { title, description: meta("description"), text, links, assetUrls: [...assetUrls, ...inlineScripts], generator };
}

/** Text with paragraph breaks kept, so the model sees structure. */
function blockText(el: HTMLElement): string {
  const html = el.innerHTML
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ");
  return parse(html)
    .text.replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function absolute(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}
