/**
 * Local PDF -> DOI: which paper is this file?
 *
 * 1. Read the text of the first three pages and take the paper's own DOI
 *    (the most frequent DOI there, earliest on a tie).
 * 2. If the text has no DOI, look up the title embedded in the PDF's
 *    document information in OpenAlex; accept only a near-exact match.
 * 3. Look the DOI up (OpenAlex, Crossref) and check that the registered title
 *    appears in the PDF text.
 *
 * Read-only: the PDF is never moved, renamed or changed.
 *
 * @module
 */

import { extractPdfText, type PdfEngine, pdfMetaTitle } from "./pdftext.ts";
import { doiFromTitle, resolveDoi } from "./resolve.ts";
import {
  expandHome,
  guessDoi,
  HttpClient,
  isPdfFile,
  sha256Hex,
  titleOverlap,
} from "./util.ts";

/** Pages read to find a DOI; a paper's own DOI is printed on the first page or two. */
const DOI_PAGES = 3;

/** Below this share of title words found in the PDF text, the DOI is reported as a mismatch. */
const MIN_TITLE_MATCH = 0.6;

/** Every outcome of `identifyPdf`. */
export const IDENTIFY_STATUSES = [
  "identified",
  "doi_mismatch",
  "unverified",
  "no_doi",
] as const;

/** Result of `identifyPdf`. */
export interface Identification {
  status: typeof IDENTIFY_STATUSES[number];
  path: string;
  sha256: string;
  bytes: number;
  doi: string | null;
  doi_source: "pdf_text" | "title_search" | null;
  doi_found_in_text: boolean;
  pdf_title: string | null;
  title: string | null;
  year: number | null;
  journal: string | null;
  authors: string[];
  authors_total: number;
  title_match: number | null;
  resolve_errors: string[];
  message: string;
}

/** Work out which paper a local PDF is. Never modifies the file. */
export async function identifyPdf(
  rawPath: string,
  client: HttpClient,
  opts: { openalexApiKey?: string; engine?: PdfEngine } = {},
): Promise<Identification> {
  const path = expandHome(rawPath);
  if (!path.toLowerCase().endsWith(".pdf")) {
    throw new Error(`Not a .pdf file: ${path}`);
  }
  try {
    await Deno.stat(path);
  } catch {
    throw new Error(`File not found: ${path}`);
  }
  if (!await isPdfFile(path)) {
    throw new Error(`File does not start with %PDF-: ${path}`);
  }
  const bytes = await Deno.readFile(path);
  const first = (await extractPdfText(path, opts.engine, DOI_PAGES)).text
    .slice(0, 15_000);
  const pdfTitle = await pdfMetaTitle(path);

  const out: Identification = {
    status: "no_doi",
    path,
    sha256: await sha256Hex(bytes),
    bytes: bytes.length,
    doi: null,
    doi_source: null,
    doi_found_in_text: false,
    pdf_title: pdfTitle,
    title: null,
    year: null,
    journal: null,
    authors: [],
    authors_total: 0,
    title_match: null,
    resolve_errors: [],
    message: "",
  };

  let doi = guessDoi(first);
  if (doi) out.doi_source = "pdf_text";
  else if (pdfTitle) {
    doi = await doiFromTitle(pdfTitle, client, opts.openalexApiKey);
    if (doi) out.doi_source = "title_search";
  }
  if (!doi) {
    out.message = pdfTitle
      ? "No DOI on the first pages, and no near-exact title match in OpenAlex."
      : "No DOI on the first pages, and the PDF has no embedded title.";
    return out;
  }
  out.doi = doi;
  out.doi_found_in_text = first.toLowerCase().includes(doi);

  const work = await resolveDoi(doi, client, opts.openalexApiKey);
  out.resolve_errors = work.errors;
  if (!work.title) {
    out.status = "unverified";
    out.message =
      "Found a DOI but could not look up its registered title, so it is not checked " +
      `against the PDF (${work.errors.join("; ") || "no title registered"}).`;
    return out;
  }
  out.title = work.title;
  out.year = work.year;
  out.journal = work.journal;
  out.authors = work.authors;
  out.authors_total = work.authors_total;
  const overlap = titleOverlap(work.title, first);
  out.title_match = overlap === null ? null : Math.round(overlap * 100) / 100;
  if (overlap !== null && overlap < MIN_TITLE_MATCH) {
    out.status = "doi_mismatch";
    out.message =
      "The registered title of this DOI does not appear in the PDF; it may be a " +
      "DOI of a cited paper. Check by hand.";
    return out;
  }
  out.status = "identified";
  out.message = `This PDF is ${doi}.`;
  return out;
}
