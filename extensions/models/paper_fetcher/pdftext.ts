/**
 * Local PDF -> plain text. Uses the `pdftotext` command (poppler) when it is
 * installed, otherwise the pure-JavaScript `unpdf` library (pdf.js).
 *
 * @module
 */

import { extractText, getDocumentProxy, getMeta } from "npm:unpdf@1.4.0";
import { expandHome, isPdfFile } from "./util.ts";

/** Which extractor to use: `auto` tries pdftotext first. */
export type PdfEngine = "auto" | "pdftotext" | "unpdf";

/** Result of `pdfToText`. */
export interface PdfText {
  path: string;
  engine: "pdftotext" | "unpdf";
  total_chars: number;
  offset: number;
  returned_chars: number;
  next_offset: number | null;
  txt_path: string | null;
  txt_error: string | null;
  text: string;
}

/** Drop blank lines and lines that hold only page or line numbers. */
export function cleanText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "" && !/^\s*[\d.]+\s*$/.test(l))
    .join("\n");
}

/** pdftotext gets this long per file before it is killed. */
const PDFTOTEXT_TIMEOUT_MS = 120_000;

async function viaPdftotext(
  path: string,
  lastPage?: number,
): Promise<string | null> {
  const args = lastPage ? ["-l", String(lastPage), path, "-"] : [path, "-"];
  try {
    // Fixed binary, no shell; `path` is a single argv entry that the caller has
    // already checked to be an existing file ending in .pdf and starting with %PDF-.
    // swamp-quality-ignore deno-command: optional poppler pdftotext, documented in README
    const out = await new Deno.Command("pdftotext", {
      args,
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(PDFTOTEXT_TIMEOUT_MS),
    }).output();
    const text = new TextDecoder().decode(out.stdout);
    return out.success && text.trim() ? text : null;
  } catch {
    return null; // not installed, or timed out
  }
}

async function viaUnpdf(
  bytes: Uint8Array,
  lastPage?: number,
): Promise<string> {
  const doc = await getDocumentProxy(bytes.slice());
  try {
    const { text } = await extractText(doc, { mergePages: false });
    const pages = text as string[];
    return (lastPage ? pages.slice(0, lastPage) : pages).join("\n");
  } finally {
    await doc.destroy();
  }
}

/**
 * Extracted text of a PDF and the engine that produced it. With `lastPage`,
 * only the first pages are kept (used to find a paper's DOI quickly).
 */
export async function extractPdfText(
  path: string,
  engine: PdfEngine = "auto",
  lastPage?: number,
): Promise<{ text: string; engine: "pdftotext" | "unpdf" }> {
  if (engine !== "unpdf") {
    const t = await viaPdftotext(path, lastPage);
    if (t !== null) return { text: cleanText(t), engine: "pdftotext" };
    if (engine === "pdftotext") {
      throw new Error("pdftotext is not installed or could not read the file");
    }
  }
  const t = await viaUnpdf(await Deno.readFile(path), lastPage);
  return { text: cleanText(t), engine: "unpdf" };
}

/** The `/Title` from the PDF's document information, if it looks like a real title (>15 chars). */
export async function pdfMetaTitle(path: string): Promise<string | null> {
  try {
    const doc = await getDocumentProxy((await Deno.readFile(path)).slice());
    try {
      // deno-lint-ignore no-explicit-any
      const info = (await getMeta(doc)).info as any;
      const t = typeof info?.Title === "string" ? info.Title.trim() : "";
      return t.length > 15 ? t : null;
    } finally {
      await doc.destroy();
    }
  } catch {
    return null;
  }
}

/**
 * Extract text from a local PDF and return one chunk of it. With `saveTxt`
 * (default) the full text is also written as `<name>.txt` next to the PDF,
 * replacing an existing file of that name; if that write fails, `txt_path` is
 * null and `txt_error` says why.
 */
export async function pdfToText(
  rawPath: string,
  opts: {
    maxChars?: number;
    offset?: number;
    saveTxt?: boolean;
    engine?: PdfEngine;
  } = {},
): Promise<PdfText> {
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
  const { text, engine } = await extractPdfText(path, opts.engine ?? "auto");
  const offset = Math.max(0, opts.offset ?? 0);
  const maxChars = Math.max(1, opts.maxChars ?? 50_000);
  let txtPath: string | null = null;
  let txtError: string | null = null;
  if (opts.saveTxt ?? true) {
    const target = path.replace(/\.pdf$/i, ".txt");
    try {
      await Deno.writeTextFile(target, text);
      txtPath = target;
    } catch (e) {
      txtError = e instanceof Error ? e.message : String(e);
    }
  }
  const chunk = text.slice(offset, offset + maxChars);
  const end = offset + chunk.length;
  return {
    path,
    engine,
    total_chars: text.length,
    offset,
    returned_chars: chunk.length,
    next_offset: end < text.length ? end : null,
    txt_path: txtPath,
    txt_error: txtError,
    text: chunk,
  };
}
