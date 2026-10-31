/**
 * DOI -> metadata, open-access status and candidate PDF URLs.
 *
 * Sources, in this order:
 *  1. OpenAlex `GET https://api.openalex.org/works/doi:<doi>` — title, year,
 *     journal, authors, open-access status and the URLs of open-access copies.
 *  2. Crossref `GET https://api.crossref.org/works/<doi>` — fills gaps and adds
 *     publisher-declared full-text links of type `application/pdf`.
 *  3. Europe PMC — when OpenAlex reports a PubMed Central ID, the Europe PMC
 *     PDF rendering endpoint is added as a candidate.
 *
 * @module
 */

import {
  doiForPath,
  errText,
  HttpClient,
  normalizeDoi,
  titleOverlap,
} from "./util.ts";

/** A URL that may serve the PDF, with where it came from. */
export interface PdfCandidate {
  url: string;
  source: string;
}

/** Metadata for one DOI. Field names follow the provenance-record format. */
export interface Work {
  doi: string;
  title: string | null;
  year: number | null;
  journal: string | null;
  publisher: string | null;
  authors: string[];
  authors_total: number;
  is_oa: boolean | null;
  oa_status: string | null;
  landing_url: string;
  pmcid: string | null;
  pdf_candidates: PdfCandidate[];
  metadata_source: string | null;
  errors: string[];
}

// deno-lint-ignore no-explicit-any
type Json = any;

function addCandidate(
  w: Work,
  url: string | null | undefined,
  source: string,
): void {
  if (url && !w.pdf_candidates.some((c) => c.url === url)) {
    w.pdf_candidates.push({ url, source });
  }
}

/** At most this many author names are kept; `authors_total` holds the real count. */
export const MAX_AUTHORS = 30;

function setAuthors(w: Work, names: unknown[]): void {
  const all = names.filter((n): n is string => typeof n === "string" && !!n);
  w.authors = all.slice(0, MAX_AUTHORS);
  w.authors_total = all.length;
}

function fromOpenAlex(w: Work, o: Json): void {
  w.metadata_source = "openalex";
  w.title = o.title ?? o.display_name ?? null;
  w.year = o.publication_year ?? null;
  const prim = o.primary_location ?? {};
  const src = prim.source ?? {};
  w.journal = src.display_name ?? null;
  w.publisher = src.host_organization_name ?? null;
  w.landing_url = prim.landing_page_url ?? w.landing_url;
  setAuthors(
    w,
    (o.authorships ?? []).map((a: Json) => a?.author?.display_name),
  );
  const oa = o.open_access ?? {};
  w.is_oa = oa.is_oa ?? null;
  w.oa_status = oa.oa_status ?? null;
  const pmcid: string | undefined = o.ids?.pmcid;
  if (pmcid) {
    const last = pmcid.replace(/\/+$/, "").split("/").pop() ?? "";
    w.pmcid = last.toUpperCase().startsWith("PMC") ? last : `PMC${last}`;
  }
  addCandidate(w, o.best_oa_location?.pdf_url, "openalex:best_oa_location");
  for (const loc of o.locations ?? []) {
    if (loc?.is_oa) addCandidate(w, loc.pdf_url, "openalex:oa_location");
  }
  const oaUrl: string = oa.oa_url ?? "";
  if (oaUrl.toLowerCase().endsWith(".pdf")) {
    addCandidate(w, oaUrl, "openalex:oa_url");
  }
}

function fromCrossref(w: Work, m: Json): void {
  w.metadata_source = w.metadata_source ?? "crossref";
  if (!w.title) w.title = m.title?.[0] ?? null;
  if (!w.journal) w.journal = m["container-title"]?.[0] ?? null;
  w.publisher = w.publisher ?? m.publisher ?? null;
  if (!w.year) w.year = m.issued?.["date-parts"]?.[0]?.[0] ?? null;
  if (w.authors.length === 0) {
    setAuthors(
      w,
      (m.author ?? []).map((a: Json) =>
        [a.given, a.family].filter(Boolean).join(" ")
      ),
    );
  }
  for (const link of m.link ?? []) {
    if ((link["content-type"] ?? "").toLowerCase() === "application/pdf") {
      addCandidate(w, link.URL, "crossref:link");
    }
  }
}

/** Look up a DOI in OpenAlex and Crossref. Network errors are collected in `errors`, never thrown. */
export async function resolveDoi(
  rawDoi: string,
  client: HttpClient,
  openalexApiKey?: string,
): Promise<Work> {
  const doi = normalizeDoi(rawDoi);
  const w: Work = {
    doi,
    title: null,
    year: null,
    journal: null,
    publisher: null,
    authors: [],
    authors_total: 0,
    is_oa: null,
    oa_status: null,
    landing_url: `https://doi.org/${doiForPath(doi)}`,
    pmcid: null,
    pdf_candidates: [],
    metadata_source: null,
    errors: [],
  };
  const oaUrl = new URL(
    `https://api.openalex.org/works/doi:${doiForPath(doi)}`,
  );
  if (openalexApiKey) oaUrl.searchParams.set("api_key", openalexApiKey);
  try {
    const r = await client.getJson(oaUrl.href);
    if (r.status === 200) fromOpenAlex(w, r.json);
    else w.errors.push(`openalex HTTP ${r.status}`);
  } catch (e) {
    w.errors.push(`openalex: ${errText(e)}`);
  }
  try {
    const r = await client.getJson(
      `https://api.crossref.org/works/${doiForPath(doi)}`,
    );
    if (r.status === 200) fromCrossref(w, (r.json as Json)?.message ?? {});
    else w.errors.push(`crossref HTTP ${r.status}`);
  } catch (e) {
    w.errors.push(`crossref: ${errText(e)}`);
  }
  if (w.pmcid) {
    addCandidate(
      w,
      `https://europepmc.org/backend/ptpmcrender.fcgi?accid=${w.pmcid}&blobtype=pdf`,
      "europepmc",
    );
  }
  return w;
}

/**
 * Search OpenAlex by title and accept only a near-exact match (≥90% word
 * overlap in both directions). Used when a downloaded PDF has no DOI in its text.
 */
export async function doiFromTitle(
  title: string,
  client: HttpClient,
  openalexApiKey?: string,
): Promise<string | null> {
  const params = new URLSearchParams({ search: title, "per-page": "3" });
  if (openalexApiKey) params.set("api_key", openalexApiKey);
  try {
    const r = await client.getJson(`https://api.openalex.org/works?${params}`);
    if (r.status !== 200) return null;
    for (const w of (r.json as Json)?.results ?? []) {
      const cand: string = w.title ?? "";
      const a = titleOverlap(title, cand) ?? 0;
      const b = titleOverlap(cand, title) ?? 0;
      if (Math.min(a, b) >= 0.9 && w.doi) return normalizeDoi(w.doi);
    }
  } catch {
    return null;
  }
  return null;
}
