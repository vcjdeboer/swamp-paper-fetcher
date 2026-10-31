/**
 * DOI -> PDF on disk plus a JSON provenance record next to it.
 *
 * Order of attempts:
 *  1. Open-access PDF URLs reported by OpenAlex and Europe PMC.
 *  2. Publisher full-text PDF links registered in Crossref (often only
 *     available with a subscription).
 *  3. The publisher landing page: if it serves a PDF directly, take it;
 *     otherwise follow its `citation_pdf_url` meta tag. On an institutional
 *     network (campus or VPN) this also covers subscription papers, because
 *     publishers grant access by IP address.
 *
 * Every download is checked: the body must start with `%PDF-`. A login or
 * paywall page served under a `.pdf` URL is discarded.
 *
 * @module
 */

import { join } from "node:path";
import { type PdfCandidate, resolveDoi, type Work } from "./resolve.ts";
import {
  doiToFilename,
  errText,
  expandHome,
  findCitationPdfUrl,
  HttpClient,
  isPdfBytes,
  isPdfFile,
  normalizeDoi,
  nowIso,
  sha256Hex,
  TOOL_NAME,
} from "./util.ts";

/** One step the fetcher tried. */
export interface Attempt {
  route: string;
  url: string;
  result: string;
}

/** Outcome of `fetchPdf`. Provenance fields use the same names as the JSON sidecar file. */
export interface FetchOutcome {
  status: "downloaded" | "already_present" | "not_fetched" | "conflict";
  doi: string;
  title: string | null;
  year: number | null;
  journal: string | null;
  authors: string[];
  authors_total: number;
  is_oa: boolean | null;
  oa_status: string | null;
  route: string | null;
  source_url: string | null;
  final_url: string | null;
  landing_url: string | null;
  path: string | null;
  provenance_path: string | null;
  sha256: string | null;
  bytes: number | null;
  retrieved_at: string | null;
  tool: string;
  attempts: Attempt[];
  resolve_errors: string[];
  message: string | null;
}

function base(doi: string): FetchOutcome {
  return {
    status: "not_fetched",
    doi,
    title: null,
    year: null,
    journal: null,
    authors: [],
    authors_total: 0,
    is_oa: null,
    oa_status: null,
    route: null,
    source_url: null,
    final_url: null,
    landing_url: null,
    path: null,
    provenance_path: null,
    sha256: null,
    bytes: null,
    retrieved_at: null,
    tool: TOOL_NAME,
    attempts: [],
    resolve_errors: [],
    message: null,
  };
}

function withMeta(o: FetchOutcome, w: Work): FetchOutcome {
  return {
    ...o,
    title: w.title,
    year: w.year,
    journal: w.journal,
    authors: w.authors,
    authors_total: w.authors_total,
    is_oa: w.is_oa,
    oa_status: w.oa_status,
    resolve_errors: w.errors,
  };
}

/** Route label for a candidate: Crossref links are publisher links, not necessarily open access. */
function routeFor(c: PdfCandidate): string {
  return c.source.startsWith("crossref")
    ? "publisher:crossref_link"
    : `open_access:${c.source}`;
}

// deno-lint-ignore no-explicit-any
async function readSidecar(path: string): Promise<Record<string, any>> {
  try {
    const v = JSON.parse(await Deno.readTextFile(path));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Download the PDF for a DOI into `papersDir` as `<doi>.pdf` with a `<doi>.json` provenance record. */
export async function fetchPdf(
  rawDoi: string,
  papersDir: string,
  client: HttpClient,
  opts: { openalexApiKey?: string; overwrite?: boolean } = {},
): Promise<FetchOutcome> {
  const doi = normalizeDoi(rawDoi);
  const outDir = expandHome(papersDir);
  await Deno.mkdir(outDir, { recursive: true });
  const stem = doiToFilename(doi);
  const pdfPath = join(outDir, `${stem}.pdf`);
  const provPath = join(outDir, `${stem}.json`);
  const prov = await readSidecar(provPath);

  // Two DOIs can map to one file name (e.g. 10.1/a_b and 10.1/a/b): never mix them up.
  if (typeof prov.doi === "string" && prov.doi.toLowerCase() !== doi) {
    return {
      ...base(doi),
      status: "conflict",
      path: pdfPath,
      provenance_path: provPath,
      message:
        `${stem}.pdf already belongs to DOI ${prov.doi}; nothing was downloaded.`,
    };
  }

  if (!opts.overwrite && await isPdfFile(pdfPath)) {
    const bytes = await Deno.readFile(pdfPath);
    const authors: string[] = Array.isArray(prov.authors) ? prov.authors : [];
    return {
      ...base(doi),
      status: "already_present",
      title: prov.title ?? null,
      year: prov.year ?? null,
      journal: prov.journal ?? null,
      authors,
      authors_total: prov.authors_total ?? authors.length,
      is_oa: prov.is_oa ?? null,
      oa_status: prov.oa_status ?? null,
      route: prov.route ?? null,
      source_url: prov.source_url ?? null,
      final_url: prov.final_url ?? null,
      retrieved_at: prov.retrieved_at ?? null,
      path: pdfPath,
      provenance_path: prov.route ? provPath : null,
      sha256: await sha256Hex(bytes),
      bytes: bytes.length,
      message:
        "A valid PDF is already in the papers folder; nothing downloaded.",
    };
  }

  const work = await resolveDoi(doi, client, opts.openalexApiKey);
  const attempts: Attempt[] = [];

  const save = async (
    body: Uint8Array,
    url: string,
    finalUrl: string,
    route: string,
  ): Promise<FetchOutcome> => {
    const tmp = `${pdfPath}.part`;
    try {
      await Deno.writeFile(tmp, body);
      await Deno.rename(tmp, pdfPath);
    } catch (e) {
      await Deno.remove(tmp).catch(() => {});
      throw new Error(`Could not save ${pdfPath}: ${errText(e)}`);
    }
    attempts.push({ route, url, result: "ok" });
    const rec: FetchOutcome = {
      ...withMeta(base(doi), work),
      status: "downloaded",
      route,
      source_url: url,
      final_url: finalUrl,
      landing_url: work.landing_url,
      path: pdfPath,
      provenance_path: provPath,
      sha256: await sha256Hex(body),
      bytes: body.length,
      retrieved_at: nowIso(),
      attempts,
    };
    await Deno.writeTextFile(provPath, JSON.stringify(rec, null, 2));
    return rec;
  };

  const tryUrl = async (
    url: string,
    route: string,
  ): Promise<FetchOutcome | null> => {
    let note: string;
    try {
      const r = await client.get(url, { accept: "application/pdf,*/*" });
      if (r.status !== 200) note = `HTTP ${r.status}`;
      else if (!isPdfBytes(r.body)) {
        note = "response was not a PDF (probably a login or landing page)";
      } else return await save(r.body, url, r.url, route);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Could not save")) throw e;
      note = errText(e);
    }
    attempts.push({ route, url, result: note });
    return null;
  };

  // 1 + 2. open-access candidates first, publisher links registered in Crossref after them
  const cands = [
    ...work.pdf_candidates.filter((c) => !c.source.startsWith("crossref")),
    ...work.pdf_candidates.filter((c) => c.source.startsWith("crossref")),
  ];
  for (const c of cands) {
    const out = await tryUrl(c.url, routeFor(c));
    if (out) return out;
  }

  // 3. publisher landing page
  let landing = work.landing_url;
  try {
    const r = await client.get(landing, {
      accept: "text/html,application/xhtml+xml",
    });
    const ctype = (r.headers.get("content-type") ?? "").toLowerCase();
    if (r.status === 200 && isPdfBytes(r.body)) {
      return await save(r.body, landing, r.url, "publisher:direct");
    } else if (r.status === 200 && !ctype.includes("pdf")) {
      const html = new TextDecoder().decode(r.body);
      const pdfUrl = findCitationPdfUrl(html, r.url);
      if (pdfUrl) {
        const out = await tryUrl(pdfUrl, "publisher:citation_pdf_url");
        if (out) return out;
      } else {
        attempts.push({
          route: "publisher:landing",
          url: r.url,
          result: "no citation_pdf_url meta tag",
        });
      }
    } else {
      attempts.push({
        route: "publisher:landing",
        url: r.url,
        result: r.status === 200 ? "not a PDF" : `HTTP ${r.status}`,
      });
    }
    landing = r.url;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Could not save")) throw e;
    attempts.push({
      route: "publisher:landing",
      url: landing,
      result: errText(e),
    });
  }

  if (client.responses === 0) {
    throw new Error(
      `Network unreachable: no server answered for ${doi} ` +
        `(${[...work.errors, ...attempts.map((a) => a.result)].join("; ")})`,
    );
  }

  return {
    ...withMeta(base(doi), work),
    status: "not_fetched",
    landing_url: landing,
    attempts,
    message:
      "No PDF could be fetched automatically. Open landing_url in a browser " +
      "(use the publisher's institutional login if you have one), save the PDF, " +
      "then run importDownloads.",
  };
}
