/**
 * File PDFs from a downloads folder into the papers folder by DOI.
 *
 * For every PDF changed in the last `sinceHours`: read the DOI from the text
 * of its first three pages (or, failing that, look up its embedded title in
 * OpenAlex), check the title registered for that DOI against the PDF text,
 * and copy it to the papers folder as `<doi>.pdf` with a provenance record.
 * Originals stay where they are.
 *
 * @module
 */

import { basename, join } from "node:path";
import { extractPdfText, type PdfEngine, pdfMetaTitle } from "./pdftext.ts";
import { doiFromTitle, resolveDoi, type Work } from "./resolve.ts";
import {
  doiToFilename,
  errText,
  exists,
  expandHome,
  guessDoi,
  HttpClient,
  isPdfFile,
  nowIso,
  sha256Hex,
  titleOverlap,
  TOOL_NAME,
} from "./util.ts";

/** Every status a file can end up with. */
export const IMPORT_STATUSES = [
  "imported",
  "would_import",
  "already_present",
  "conflict",
  "duplicate",
  "doi_mismatch",
  "unverified",
  "no_doi",
  "skipped",
  "error",
] as const;

/** What happened to one file. */
export interface ImportRow {
  file: string;
  status: typeof IMPORT_STATUSES[number];
  doi: string | null;
  doi_source: "pdf_text" | "title_search" | null;
  title: string | null;
  title_match: number | null;
  path: string | null;
  same_as: string | null;
  reason: string | null;
}

/** Summary of one import run. */
export interface ImportResult {
  scanned: number;
  summary: Record<string, number>;
  files: ImportRow[];
}

/** Provenance record written next to each imported PDF. */
export interface ImportProvenance {
  doi: string;
  title: string | null;
  year: number | null;
  journal: string | null;
  authors: string[] | null;
  authors_total: number | null;
  is_oa: boolean | null;
  route: "import_downloads";
  original_filename: string;
  original_mtime: string | null;
  path: string;
  sha256: string;
  bytes: number;
  doi_source: string;
  doi_found_in_text: boolean;
  title_match: number | null;
  recorded_at: string;
  tool: string;
}

/** Pages read to find a DOI; a paper's own DOI is printed on the first page or two. */
const DOI_PAGES = 3;

function row(file: string, status: ImportRow["status"]): ImportRow {
  return {
    file,
    status,
    doi: null,
    doi_source: null,
    title: null,
    title_match: null,
    path: null,
    same_as: null,
    reason: null,
  };
}

/** Import recent PDFs from `downloadsDir` into `papersDir`. With `verifyOnline` false, no network is used. */
export async function importDownloads(
  downloadsDir: string,
  papersDir: string,
  client: HttpClient,
  opts: {
    sinceHours?: number;
    dryRun?: boolean;
    verifyOnline?: boolean;
    openalexApiKey?: string;
    engine?: PdfEngine;
  } = {},
): Promise<ImportResult> {
  const src = expandHome(downloadsDir);
  const dst = expandHome(papersDir);
  const verify = opts.verifyOnline ?? true;
  if (!(await exists(src))) {
    throw new Error(`Downloads folder does not exist: ${src}`);
  }
  if (!opts.dryRun) await Deno.mkdir(dst, { recursive: true });
  const cutoff = Date.now() - (opts.sinceHours ?? 48) * 3600_000;

  const pdfs: { path: string; mtime: number }[] = [];
  for await (const e of Deno.readDir(src)) {
    if (!e.isFile || !e.name.toLowerCase().endsWith(".pdf")) continue;
    const p = join(src, e.name);
    try {
      const mtime = (await Deno.stat(p)).mtime?.getTime() ?? 0;
      if (mtime >= cutoff) pdfs.push({ path: p, mtime });
    } catch {
      // vanished while scanning
    }
  }
  pdfs.sort((a, b) => a.mtime - b.mtime);

  const files: ImportRow[] = [];
  const seen = new Map<string, string>(); // sha256 -> first file name with it
  const claimed = new Map<string, string>(); // target path -> sha256 filed (or to be filed) in this run

  const one = async (p: string, mtime: number): Promise<ImportRow> => {
    const file = basename(p);
    if (!await isPdfFile(p)) {
      return { ...row(file, "skipped"), reason: "not a real PDF" };
    }
    const bytes = await Deno.readFile(p);
    const h = await sha256Hex(bytes);
    if (seen.has(h)) {
      return { ...row(file, "duplicate"), same_as: seen.get(h)! };
    }
    seen.set(h, file);

    let first: string;
    try {
      first = (await extractPdfText(p, opts.engine, DOI_PAGES)).text.slice(
        0,
        15_000,
      );
    } catch (e) {
      return {
        ...row(file, "skipped"),
        reason: `text extraction failed: ${errText(e)}`,
      };
    }
    const r = row(file, "skipped");
    r.doi_source = "pdf_text";
    let doi = guessDoi(first);
    if (!doi && verify) {
      const mt = await pdfMetaTitle(p);
      if (mt) {
        doi = await doiFromTitle(mt, client, opts.openalexApiKey);
        r.doi_source = "title_search";
      }
    }
    if (!doi) {
      return {
        ...r,
        status: "no_doi",
        doi_source: null,
        reason: "no DOI on the first pages and no confident title match",
      };
    }
    r.doi = doi;

    let work: Work | null = null;
    if (verify) {
      work = await resolveDoi(doi, client, opts.openalexApiKey);
      r.title = work.title;
      if (!work.title) {
        return {
          ...r,
          status: "unverified",
          reason: "could not look up the title registered for this DOI (" +
            (work.errors.join("; ") || "no title") + "); nothing copied",
        };
      }
      const overlap = titleOverlap(work.title, first);
      r.title_match = overlap === null ? null : Math.round(overlap * 100) / 100;
      if (overlap !== null && overlap < 0.6) {
        return {
          ...r,
          status: "doi_mismatch",
          reason:
            "the DOI found does not match this PDF's title; check by hand",
        };
      }
    }

    const stem = doiToFilename(doi);
    const target = join(dst, `${stem}.pdf`);
    r.path = target;
    const prior = claimed.get(target) ??
      (await exists(target)
        ? await sha256Hex(await Deno.readFile(target))
        : null);
    if (prior !== null) {
      return prior === h ? { ...r, status: "already_present" } : {
        ...r,
        status: "conflict",
        reason: "a different file with this DOI is already in papers",
      };
    }
    claimed.set(target, h);
    if (opts.dryRun) return { ...r, status: "would_import" };

    const tmp = `${target}.part`;
    try {
      await Deno.writeFile(tmp, bytes);
      await Deno.rename(tmp, target);
    } catch (e) {
      await Deno.remove(tmp).catch(() => {});
      throw e;
    }
    const rec: ImportProvenance = {
      doi,
      title: work?.title ?? null,
      year: work?.year ?? null,
      journal: work?.journal ?? null,
      authors: work?.authors ?? null,
      authors_total: work?.authors_total ?? null,
      is_oa: work?.is_oa ?? null,
      route: "import_downloads",
      original_filename: file,
      original_mtime: mtime ? new Date(mtime).toISOString() : null,
      path: target,
      sha256: h,
      bytes: bytes.length,
      doi_source: r.doi_source ?? "pdf_text",
      doi_found_in_text: first.toLowerCase().includes(doi),
      title_match: r.title_match,
      recorded_at: nowIso(),
      tool: TOOL_NAME,
    };
    await Deno.writeTextFile(
      join(dst, `${stem}.json`),
      JSON.stringify(rec, null, 2),
    );
    return { ...r, status: "imported" };
  };

  for (const { path, mtime } of pdfs) {
    try {
      files.push(await one(path, mtime));
    } catch (e) {
      files.push({ ...row(basename(path), "error"), reason: errText(e) });
    }
  }

  const summary: Record<string, number> = {};
  for (const r of files) summary[r.status] = (summary[r.status] ?? 0) + 1;
  return { scanned: pdfs.length, summary, files };
}
