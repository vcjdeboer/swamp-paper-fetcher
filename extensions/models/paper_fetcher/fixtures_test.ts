// Test fixtures shared by the paper-fetcher tests (the _test.ts suffix keeps
// swamp from loading this file as a model).

import type { FetchFn } from "./util.ts";

/** Smallest byte string that passes the %PDF- check. */
export const FAKE_PDF = new TextEncoder().encode(
  "%PDF-1.7\n% fake test pdf\n%%EOF\n",
);

/** Build a real one-page PDF with the given text lines and optional /Title. */
export function makePdf(lines: string[], title?: string): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => "\\" + c);
  const content = "BT /F1 12 Tf 72 720 Td 14 TL " +
    lines.map((l) => `(${esc(l)}) '`).join(" ") + " ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  if (title) objs.push(`<< /Title (${esc(title)}) >>`);
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${
    title ? ` /Info ${objs.length} 0 R` : ""
  } >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** A route of the fake network: a Response, a function producing one, or an error to throw. */
export type Route =
  | Response
  | ((req: { url: string; headers: Headers }) => Response)
  | Error;

/**
 * Fake fetch: exact-URL routes; anything else is a 404. Records each request.
 * Responses are cloned so a route can be hit more than once.
 */
export function fakeFetch(
  routes: Record<string, Route>,
): FetchFn & { calls: { url: string; headers: Headers }[] } {
  const calls: { url: string; headers: Headers }[] = [];
  const fn = (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    calls.push({ url, headers });
    const r = routes[url];
    if (r === undefined) return Promise.resolve(new Response("nf", { status: 404 }));
    if (r instanceof Error) return Promise.reject(r);
    if (typeof r === "function") return Promise.resolve(r({ url, headers }));
    return Promise.resolve(r.clone());
  };
  return Object.assign(fn, { calls });
}

/** JSON response helper. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Bytes response helper. */
export function bytes(
  body: Uint8Array,
  contentType = "application/pdf",
): Response {
  return new Response(body as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

/** HTML response helper. */
export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
  });
}
