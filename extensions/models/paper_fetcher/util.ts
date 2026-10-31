/**
 * Shared helpers for the paper-fetcher model: DOI handling, file helpers and a
 * small HTTP client that follows redirects and keeps cookies between requests
 * (many publisher sites set a cookie on the first redirect and expect it back).
 *
 * @module
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Version string written into every provenance record. */
export const TOOL_VERSION = "2026.10.31.2";

/** Tool identifier written into provenance records. */
export const TOOL_NAME = `swamp @vcjdeboer/paper-fetcher ${TOOL_VERSION}`;

/**
 * Browser-like User-Agent. Several publishers refuse requests without one.
 * The tool name is appended so that site operators can identify the client.
 */
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0 Safari/537.36 swamp-paper-fetcher/" +
  TOOL_VERSION;

const DOI_RE = /10\.\d{4,9}\/\S+/i;
const DOI_RE_GLOBAL = /10\.\d{4,9}\/\S+/gi;

/** Accept `10.x/y`, `doi:10.x/y` or `https://doi.org/10.x/y`; return the lower-case bare DOI. */
export function normalizeDoi(raw: string): string {
  if (!raw || !raw.trim()) throw new Error("Empty DOI");
  let s = raw.trim();
  // A URL: take its (decoded) path only, so ?utm_source=… and #fragments are dropped.
  if (/^https?:\/\//i.test(s)) {
    try {
      s = decodeURIComponent(new URL(s).pathname);
    } catch {
      // keep the raw string
    }
  }
  const m = s.match(DOI_RE);
  if (!m) throw new Error(`Not a DOI: ${JSON.stringify(raw)}`);
  return m[0].replace(/[.,;)]+$/, "").toLowerCase();
}

/** A DOI made safe for a URL path: every segment percent-encoded, slashes kept. */
export function doiForPath(doi: string): string {
  return doi.split("/").map(encodeURIComponent).join("/");
}

/** `10.1038/s41586-025-09694-5` becomes `10.1038_s41586-025-09694-5` (safe on every OS). */
export function doiToFilename(doi: string): string {
  return doi.replace(/[^A-Za-z0-9._-]+/g, "_");
}

/**
 * Pick the paper's own DOI from the text of its first pages: the most frequent
 * DOI, the earliest one on a tie. Reference-list DOIs appear once each and
 * later in the text, so they rarely win.
 */
export function guessDoi(text: string): string | null {
  const found: string[] = [];
  for (const m of text.matchAll(DOI_RE_GLOBAL)) {
    try {
      found.push(normalizeDoi(m[0]).replace(/[).,;:\]]+$/, ""));
    } catch {
      // not a usable DOI
    }
  }
  if (found.length === 0) return null;
  const counts = new Map<string, number>();
  for (const d of found) counts.set(d, (counts.get(d) ?? 0) + 1);
  const best = Math.max(...counts.values());
  return found.find((d) => counts.get(d) === best) ?? null;
}

/** Share (0..1) of the title's words of 4+ characters that occur in `text`; null without usable words. */
export function titleOverlap(
  title: string | null | undefined,
  text: string,
): number | null {
  if (!title) return null;
  const words = new Set(title.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  if (words.size === 0) return null;
  const low = text.toLowerCase();
  let hit = 0;
  for (const w of words) if (low.includes(w)) hit++;
  return hit / words.size;
}

const META_PDF_RE = [
  /<meta[^>]+name=["']citation_pdf_url["'][^>]*content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']citation_pdf_url["']/i,
];

function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x2F;/gi, "/");
}

/** Read the `citation_pdf_url` meta tag (Google Scholar convention) from a landing page. */
export function findCitationPdfUrl(
  html: string,
  baseUrl: string,
): string | null {
  for (const re of META_PDF_RE) {
    const m = html.match(re);
    if (m) {
      try {
        const u = new URL(unescapeHtml(m[1]), baseUrl);
        return u.protocol === "https:" || u.protocol === "http:"
          ? u.href
          : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Expand a leading `~` to the home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Hex sha256 of a byte array. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** True when the bytes start with the PDF magic number `%PDF-`. */
export function isPdfBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 &&
    bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

/** True when the file exists and starts with `%PDF-`. */
export async function isPdfFile(path: string): Promise<boolean> {
  let f: Deno.FsFile | undefined;
  try {
    f = await Deno.open(path, { read: true });
    const buf = new Uint8Array(5);
    const n = await f.read(buf);
    return n === 5 && isPdfBytes(buf);
  } catch {
    return false;
  } finally {
    f?.close();
  }
}

/** True when the path exists. */
export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Current time as an ISO-8601 UTC string with seconds precision. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Short description of any thrown value. */
export function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

// --------------------------------------------------------------------------- HTTP

/** The subset of `fetch` the client needs; tests inject a fake. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** A finished response with the body read into memory. */
export interface HttpResult {
  status: number;
  url: string;
  headers: Headers;
  body: Uint8Array;
}

interface Cookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
}

/**
 * Throw unless `url` is an http(s) URL on a public host. Blocks `file:` and
 * other schemes, and loopback / link-local / private addresses, so that a
 * hostile redirect or meta tag cannot make the tool read local files or
 * internal services.
 */
export function assertPublicHttpUrl(url: string): URL {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`Refusing non-HTTP URL: ${u.protocol}`);
  }
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateHost = h === "localhost" || h.endsWith(".localhost") ||
    h === "::1" || h === "0.0.0.0" || /^(fe80|fc|fd)[0-9a-f]*:/.test(h) ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if (privateHost) throw new Error(`Refusing local/private host: ${h}`);
  return u;
}

/**
 * Minimal HTTP client: follows redirects by hand (max 10) so it can keep a
 * cookie jar across them, sends a browser-like User-Agent, and applies a
 * per-request timeout.
 */
export class HttpClient {
  private cookies: Cookie[] = [];
  /** Number of HTTP responses received (any status); 0 means the network was unreachable. */
  responses = 0;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;

  /** Create a client; `fetchFn` defaults to the global `fetch`. */
  constructor(
    opts: { fetchFn?: FetchFn; timeoutMs?: number; signal?: AbortSignal } = {},
  ) {
    this.fetchFn = opts.fetchFn ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.signal = opts.signal;
  }

  private cookieHeader(host: string): string {
    return this.cookies
      .filter((c) =>
        c.hostOnly
          ? c.domain === host
          : host === c.domain || host.endsWith("." + c.domain)
      )
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  private storeCookies(host: string, headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let domain = host;
      let hostOnly = true;
      let expired = false;
      for (const a of attrs) {
        const i = a.indexOf("=");
        const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
        const v = i < 0 ? "" : a.slice(i + 1).trim();
        if (k === "domain" && v) {
          const d = v.replace(/^\./, "").toLowerCase();
          // must cover the host and not be a bare top-level label like "com"
          if ((host === d || host.endsWith("." + d)) && d.includes(".")) {
            domain = d;
            hostOnly = false;
          }
        } else if (k === "max-age" && Number(v) <= 0) {
          expired = true;
        } else if (k === "expires" && Date.parse(v) <= Date.now()) {
          expired = true;
        }
      }
      this.cookies = this.cookies.filter((c) =>
        !(c.name === name && c.domain === domain)
      );
      if (!expired) this.cookies.push({ name, value, domain, hostOnly });
    }
  }

  /** GET `url`, following redirects; resolves with the final response and its full body. */
  async get(
    url: string,
    opts: { accept?: string; timeoutMs?: number } = {},
  ): Promise<HttpResult> {
    const signals = [AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs)];
    if (this.signal) signals.push(this.signal);
    const signal = AbortSignal.any(signals);
    let current = url;
    for (let hop = 0; hop <= 10; hop++) {
      const host = assertPublicHttpUrl(current).hostname.toLowerCase();
      const headers: Record<string, string> = {
        "User-Agent": USER_AGENT,
        "Accept": opts.accept ?? "*/*",
      };
      const cookie = this.cookieHeader(host);
      if (cookie) headers["Cookie"] = cookie;
      const r = await this.fetchFn(current, {
        headers,
        redirect: "manual",
        signal,
      });
      this.responses++;
      this.storeCookies(host, r.headers);
      const loc = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && loc) {
        await r.body?.cancel();
        current = new URL(loc, current).href;
        continue;
      }
      const body = new Uint8Array(await r.arrayBuffer());
      return { status: r.status, url: current, headers: r.headers, body };
    }
    throw new Error(`Too many redirects starting at ${url}`);
  }

  /** GET `url` and parse the body as JSON (status is checked by the caller). */
  async getJson(
    url: string,
  ): Promise<{ status: number; json: unknown }> {
    const r = await this.get(url, { accept: "application/json" });
    if (r.status !== 200) return { status: r.status, json: null };
    return {
      status: r.status,
      json: JSON.parse(new TextDecoder().decode(r.body)),
    };
  }
}
