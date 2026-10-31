/**
 * Paper fetcher: work with scholarly papers by DOI from swamp.
 *
 * Methods: `resolve` (metadata and open-access status from OpenAlex and
 * Crossref), `fetch` (download the PDF with a provenance record),
 * `importDownloads` (file PDFs saved by hand from a browser), `zoteroLookup`
 * (read-only search of a local Zotero library) and `pdfToText` (text from a
 * local PDF). Every method records its result as versioned swamp data.
 *
 * @module
 */

// Author: Vincent de Boer (github.com/vcjdeboer), Wageningen University & Research.
// Port of the "paper-fetcher" MCP server for Claude Desktop to a swamp extension.

import { z } from "npm:zod@4";
import { fetchPdf } from "./paper_fetcher/fetch.ts";
import {
  IMPORT_STATUSES,
  importDownloads,
} from "./paper_fetcher/import_downloads.ts";
import { pdfToText } from "./paper_fetcher/pdftext.ts";
import { resolveDoi } from "./paper_fetcher/resolve.ts";
import {
  doiToFilename,
  type FetchFn,
  HttpClient,
  normalizeDoi,
  sha256Hex,
  TOOL_VERSION,
} from "./paper_fetcher/util.ts";
import { zoteroLookup } from "./paper_fetcher/zotero.ts";

// --------------------------------------------------------------------------- arguments

/** Settings shared by all methods of one paper-fetcher model instance. */
const GlobalArgsSchema = z.object({
  papersDir: z.string().default("~/Papers").describe(
    "Folder where PDFs and their <doi>.json provenance records are saved",
  ),
  downloadsDir: z.string().default("~/Downloads").describe(
    "Browser downloads folder that importDownloads reads from",
  ),
  zoteroDir: z.string().default("~/Zotero").describe(
    "Zotero data folder (the one that contains zotero.sqlite)",
  ),
  openalexApiKey: z.string().optional().meta({ sensitive: true }).describe(
    "Optional OpenAlex API key; store it in a vault and reference it",
  ),
});

/** Parsed global arguments. */
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments of `resolve`. */
const ResolveArgsSchema = z.object({
  doi: z.string().describe(
    "DOI as 10.x/y, doi:10.x/y or https://doi.org/10.x/y",
  ),
});

/** Arguments of `fetch`. */
const FetchArgsSchema = z.object({
  doi: z.string().describe(
    "DOI as 10.x/y, doi:10.x/y or https://doi.org/10.x/y",
  ),
  overwrite: z.boolean().default(false).describe(
    "Download again even if a valid PDF is already in papersDir",
  ),
});

/** Arguments of `importDownloads`. */
const ImportArgsSchema = z.object({
  sinceHours: z.number().positive().default(48).describe(
    "Only consider PDFs changed in this many hours",
  ),
  dryRun: z.boolean().default(false).describe(
    "Report what would be imported without copying anything",
  ),
});

/** Arguments of `zoteroLookup`; give at least one of doi, query, collection. */
const ZoteroArgsSchema = z.object({
  doi: z.string().optional().describe("Exact DOI match"),
  query: z.string().optional().describe(
    "Words that must all start a word in the title",
  ),
  collection: z.string().optional().describe(
    "Only items in this collection (case-insensitive)",
  ),
  limit: z.number().int().positive().default(20).describe(
    "Maximum number of items returned",
  ),
});

/** Arguments of `pdfToText`. */
const PdfTextArgsSchema = z.object({
  path: z.string().describe("Path to a local .pdf file"),
  maxChars: z.number().int().positive().default(50_000).describe(
    "Maximum characters returned in this chunk",
  ),
  offset: z.number().int().min(0).default(0).describe(
    "Start of the chunk; use next_offset from the previous call",
  ),
  saveTxt: z.boolean().default(true).describe(
    "Also write the full text as <name>.txt next to the PDF (replaces an existing one)",
  ),
});

// --------------------------------------------------------------------------- resource schemas

const AttemptSchema = z.object({
  route: z.string(),
  url: z.string(),
  result: z.string(),
});

/** Metadata for one DOI (`resolve`). */
const WorkSchema = z.object({
  doi: z.string(),
  title: z.string().nullable(),
  year: z.number().nullable(),
  journal: z.string().nullable(),
  publisher: z.string().nullable(),
  authors: z.array(z.string()),
  authors_total: z.number(),
  is_oa: z.boolean().nullable(),
  oa_status: z.string().nullable(),
  landing_url: z.string(),
  pmcid: z.string().nullable(),
  pdf_candidates: z.array(z.object({ url: z.string(), source: z.string() })),
  metadata_source: z.string().nullable(),
  errors: z.array(z.string()),
});

/** Outcome and provenance of one `fetch`. */
const DownloadSchema = z.object({
  status: z.enum(["downloaded", "already_present", "not_fetched", "conflict"]),
  doi: z.string(),
  title: z.string().nullable(),
  year: z.number().nullable(),
  journal: z.string().nullable(),
  authors: z.array(z.string()),
  authors_total: z.number(),
  is_oa: z.boolean().nullable(),
  oa_status: z.string().nullable(),
  route: z.string().nullable(),
  source_url: z.string().nullable(),
  final_url: z.string().nullable(),
  landing_url: z.string().nullable(),
  path: z.string().nullable(),
  provenance_path: z.string().nullable(),
  sha256: z.string().nullable(),
  bytes: z.number().nullable(),
  retrieved_at: z.string().nullable(),
  tool: z.string(),
  attempts: z.array(AttemptSchema),
  resolve_errors: z.array(z.string()),
  message: z.string().nullable(),
});

/** Result of one `importDownloads` run. */
const ImportRunSchema = z.object({
  downloads_dir: z.string(),
  papers_dir: z.string(),
  dry_run: z.boolean(),
  scanned: z.number(),
  summary: z.record(z.string(), z.number()),
  files: z.array(
    z.object({
      file: z.string(),
      status: z.enum(IMPORT_STATUSES),
      doi: z.string().nullable(),
      doi_source: z.enum(["pdf_text", "title_search"]).nullable(),
      title: z.string().nullable(),
      title_match: z.number().nullable(),
      path: z.string().nullable(),
      same_as: z.string().nullable(),
      reason: z.string().nullable(),
    }),
  ),
});

/** Result of one `zoteroLookup`. */
const ZoteroResultSchema = z.object({
  query: z.object({
    doi: z.string().optional(),
    query: z.string().optional(),
    collection: z.string().optional(),
  }),
  count: z.number(),
  returned: z.number(),
  truncated: z.boolean(),
  items: z.array(
    z.object({
      item_key: z.string(),
      type: z.string(),
      title: z.string().nullable(),
      doi: z.string().nullable(),
      date: z.string().nullable(),
      publication: z.string().nullable(),
      creators: z.array(z.string()),
      collections: z.array(z.string()),
      attachments: z.array(z.object({
        key: z.string(),
        content_type: z.string().nullable(),
        path: z.string().nullable(),
        exists: z.boolean(),
      })),
      has_pdf: z.boolean(),
    }),
  ),
});

/** One chunk of text from `pdfToText`. */
const PdfTextSchema = z.object({
  path: z.string(),
  engine: z.string(),
  total_chars: z.number(),
  offset: z.number(),
  returned_chars: z.number(),
  next_offset: z.number().nullable(),
  txt_path: z.string().nullable(),
  txt_error: z.string().nullable(),
  text: z.string(),
});

// --------------------------------------------------------------------------- helpers

/** Context fields the methods use. */
interface MethodContext {
  globalArgs: GlobalArgs;
  signal?: AbortSignal;
  logger: {
    info(msg: string, props?: Record<string, unknown>): void;
    warning(msg: string, props?: Record<string, unknown>): void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Method return value: handles of the data written. */
interface MethodResult {
  dataHandles: { name: string }[];
}

/** Test hook: tests pass `_fetch` to replace the network. Not part of the public CLI arguments. */
interface TestHooks {
  _fetch?: FetchFn;
}

function client(ctx: MethodContext, hooks: TestHooks): HttpClient {
  return new HttpClient({ fetchFn: hooks._fetch, signal: ctx.signal });
}

function key(ctx: MethodContext): string | undefined {
  return ctx.globalArgs.openalexApiKey || undefined;
}

/** Instance-name-safe form of any string (letters, digits, `.`, `_`, `-`). */
function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
}

// --------------------------------------------------------------------------- model

/** The `@vcjdeboer/paper-fetcher` model type. */
export const model = {
  type: "@vcjdeboer/paper-fetcher",
  version: TOOL_VERSION,
  globalArguments: GlobalArgsSchema,
  resources: {
    work: {
      description: "Metadata and open-access status for a DOI",
      schema: WorkSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    download: {
      description: "Outcome and provenance of a PDF download for a DOI",
      schema: DownloadSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    importRun: {
      description: "What importDownloads did with each file",
      schema: ImportRunSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    zoteroResult: {
      description: "Items found by zoteroLookup",
      schema: ZoteroResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    pdfText: {
      description: "A chunk of text extracted from a local PDF",
      schema: PdfTextSchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    resolve: {
      description:
        "Look up a DOI in OpenAlex and Crossref: title, year, journal, authors, " +
        "open-access status, landing page and candidate PDF URLs. Downloads nothing.",
      arguments: ResolveArgsSchema,
      execute: async (
        args: z.infer<typeof ResolveArgsSchema> & TestHooks,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        ctx.logger.info("Resolving {doi}", { doi: args.doi });
        const work = await resolveDoi(args.doi, client(ctx, args), key(ctx));
        if (!work.title && work.errors.length) {
          throw new Error(
            `Could not resolve ${work.doi}: ${work.errors.join("; ")}`,
          );
        }
        ctx.logger.info("Resolved {doi}: {title} (open access: {isOa})", {
          doi: work.doi,
          title: work.title,
          isOa: work.is_oa,
        });
        const h = await ctx.writeResource(
          "work",
          `work-${doiToFilename(work.doi)}`,
          { ...work },
        );
        return { dataHandles: [h] };
      },
    },
    fetch: {
      description:
        "Download the PDF for a DOI into papersDir as <doi>.pdf with a <doi>.json " +
        "provenance record. Tries open-access copies first, then publisher links. " +
        "Status: downloaded, already_present, conflict, or not_fetched (with every " +
        "attempt listed). Fails if the network is unreachable.",
      arguments: FetchArgsSchema,
      execute: async (
        args: z.infer<typeof FetchArgsSchema> & TestHooks,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        ctx.logger.info("Fetching PDF for {doi} into {dir}", {
          doi: args.doi,
          dir: ctx.globalArgs.papersDir,
        });
        const out = await fetchPdf(
          args.doi,
          ctx.globalArgs.papersDir,
          client(ctx, args),
          { openalexApiKey: key(ctx), overwrite: args.overwrite },
        );
        if (out.status === "not_fetched") {
          ctx.logger.warning(
            "No PDF for {doi}; open {url} in a browser, then run importDownloads",
            { doi: out.doi, url: out.landing_url },
          );
        } else if (out.status === "conflict") {
          ctx.logger.warning("{message}", { message: out.message });
        } else {
          ctx.logger.info("{status}: {path} via {route}", {
            status: out.status,
            path: out.path,
            route: out.route,
          });
        }
        const h = await ctx.writeResource(
          "download",
          `download-${doiToFilename(out.doi)}`,
          { ...out },
        );
        return { dataHandles: [h] };
      },
    },
    importDownloads: {
      description:
        "File recent PDFs from downloadsDir into papersDir as <doi>.pdf, using the DOI " +
        "printed in the PDF (or a near-exact title match in OpenAlex), checked against " +
        "the registered title. Originals are left in place.",
      arguments: ImportArgsSchema,
      execute: async (
        args: z.infer<typeof ImportArgsSchema> & TestHooks,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        ctx.logger.info(
          "Importing PDFs from the last {hours} h of {dir} (dry run: {dryRun})",
          {
            hours: args.sinceHours,
            dir: ctx.globalArgs.downloadsDir,
            dryRun: args.dryRun,
          },
        );
        const res = await importDownloads(
          ctx.globalArgs.downloadsDir,
          ctx.globalArgs.papersDir,
          client(ctx, args),
          {
            sinceHours: args.sinceHours,
            dryRun: args.dryRun,
            openalexApiKey: key(ctx),
          },
        );
        ctx.logger.info("Scanned {n} PDFs: {summary}", {
          n: res.scanned,
          summary: JSON.stringify(res.summary),
        });
        const h = await ctx.writeResource("importRun", "import-latest", {
          downloads_dir: ctx.globalArgs.downloadsDir,
          papers_dir: ctx.globalArgs.papersDir,
          dry_run: args.dryRun,
          ...res,
        });
        return { dataHandles: [h] };
      },
    },
    zoteroLookup: {
      description:
        "Search the local Zotero library read-only (on a temporary copy of zotero.sqlite) " +
        "by DOI, title words and/or collection. Returns items with authors, collections, " +
        "attachment paths and whether the PDF file exists.",
      arguments: ZoteroArgsSchema,
      execute: async (
        args: z.infer<typeof ZoteroArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const q = {
          doi: args.doi || undefined,
          query: args.query || undefined,
          collection: args.collection || undefined,
        };
        if (q.doi) q.doi = normalizeDoi(q.doi);
        ctx.logger.info("Searching Zotero in {dir}", {
          dir: ctx.globalArgs.zoteroDir,
        });
        const res = await zoteroLookup(ctx.globalArgs.zoteroDir, {
          ...q,
          limit: args.limit,
        });
        ctx.logger.info("Zotero: {count} matching items, {returned} returned", {
          count: res.count,
          returned: res.returned,
        });
        const h = await ctx.writeResource("zoteroResult", "zotero-latest", {
          query: q,
          ...res,
        });
        return { dataHandles: [h] };
      },
    },
    pdfToText: {
      description:
        "Extract plain text from a local PDF (pdftotext if installed, otherwise the " +
        "built-in pdf.js reader). Saves the full text as a .txt next to the PDF and " +
        "returns one chunk; use offset/next_offset for long papers.",
      arguments: PdfTextArgsSchema,
      execute: async (
        args: z.infer<typeof PdfTextArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        ctx.logger.info("Extracting text from {path}", { path: args.path });
        const res = await pdfToText(args.path, {
          maxChars: args.maxChars,
          offset: args.offset,
          saveTxt: args.saveTxt,
        });
        ctx.logger.info(
          "{engine}: {total} characters, returned {returned} from offset {offset}",
          {
            engine: res.engine,
            total: res.total_chars,
            returned: res.returned_chars,
            offset: res.offset,
          },
        );
        if (res.txt_error) {
          ctx.logger.warning("Could not save the .txt file: {error}", {
            error: res.txt_error,
          });
        }
        // file name for readability, plus a short hash of the full path so that
        // same-named PDFs in different folders do not overwrite each other
        const base = (res.path.split(/[\\/]/).pop() ?? "pdf").replace(
          /\.pdf$/i,
          "",
        );
        const tag = (await sha256Hex(new TextEncoder().encode(res.path)))
          .slice(0, 8);
        const h = await ctx.writeResource(
          "pdfText",
          `text-${safeName(base)}-${tag}`,
          { ...res },
        );
        return { dataHandles: [h] };
      },
    },
  },
};
