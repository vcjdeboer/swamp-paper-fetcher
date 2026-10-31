/**
 * Paper fetcher: work with scholarly papers by DOI from swamp.
 *
 * Methods: `resolve` (DOI -> metadata and open-access status from OpenAlex
 * and Crossref), `identify` (local PDF -> DOI, checked against the registered
 * title), `fetch` (DOI -> PDF on disk with a provenance record) and
 * `pdfToText` (local PDF -> text). Every method records its result as
 * versioned swamp data.
 *
 * @module
 */

// Author: Vincent de Boer (github.com/vcjdeboer), Wageningen University & Research.
// Port of the "paper-fetcher" MCP server for Claude Desktop to a swamp extension.

import { z } from "npm:zod@4";
import { fetchPdf } from "./paper_fetcher/fetch.ts";
import { IDENTIFY_STATUSES, identifyPdf } from "./paper_fetcher/identify.ts";
import { pdfToText } from "./paper_fetcher/pdftext.ts";
import { resolveDoi } from "./paper_fetcher/resolve.ts";
import {
  doiToFilename,
  type FetchFn,
  HttpClient,
  sha256Hex,
} from "./paper_fetcher/util.ts";

// --------------------------------------------------------------------------- arguments

/** Settings shared by all methods of one paper-fetcher model instance. */
const GlobalArgsSchema = z.object({
  papersDir: z.string().default("~/Papers").describe(
    "Folder where fetch saves PDFs and their <doi>.json provenance records",
  ),
  openalexApiKey: z.string().optional().meta({ sensitive: true }).describe(
    "Optional OpenAlex API key; store it in a vault and reference it",
  ),
});

/** Parsed global arguments. */
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// Every field is written out as `name: z.type(...)` and every schema as
// `const X = z.object({...})`: the swamp registry reads method arguments from
// the source text, and does not follow shared variables.

/** Arguments of `resolve`. */
const ResolveArgsSchema = z.object({
  doi: z.string().describe(
    "DOI as 10.x/y, doi:10.x/y or https://doi.org/10.x/y",
  ),
});

/** Arguments of `identify`. */
const IdentifyArgsSchema = z.object({
  path: z.string().describe("Path to a local .pdf file"),
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

/** Which paper a local PDF is (`identify`). */
const IdentificationSchema = z.object({
  status: z.enum(IDENTIFY_STATUSES),
  path: z.string(),
  sha256: z.string(),
  bytes: z.number(),
  doi: z.string().nullable(),
  doi_source: z.enum(["pdf_text", "title_search"]).nullable(),
  doi_found_in_text: z.boolean(),
  pdf_title: z.string().nullable(),
  title: z.string().nullable(),
  year: z.number().nullable(),
  journal: z.string().nullable(),
  authors: z.array(z.string()),
  authors_total: z.number(),
  title_match: z.number().nullable(),
  resolve_errors: z.array(z.string()),
  message: z.string(),
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

/**
 * Instance name for data about a local file: its name for readability, plus a
 * short hash of the full path so same-named files in different folders do not
 * overwrite each other.
 */
async function fileInstance(prefix: string, path: string): Promise<string> {
  const base = (path.split(/[\\/]/).pop() ?? "pdf").replace(/\.pdf$/i, "");
  const tag = (await sha256Hex(new TextEncoder().encode(path))).slice(0, 8);
  return `${prefix}-${safeName(base)}-${tag}`;
}

// --------------------------------------------------------------------------- model

/** The `@vcjdeboer/paper-fetcher` model type. */
export const model = {
  type: "@vcjdeboer/paper-fetcher",
  // A string literal, not TOOL_VERSION: the registry reads it from the source
  // text. A unit test keeps the two equal.
  version: "2026.10.31.2",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.31.2",
      description: "No settings changed (registry metadata fix)",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
  ],
  resources: {
    work: {
      description: "Metadata and open-access status for a DOI",
      schema: WorkSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    identification: {
      description: "Which paper (DOI) a local PDF is, and how sure that is",
      schema: IdentificationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    download: {
      description: "Outcome and provenance of a PDF download for a DOI",
      schema: DownloadSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
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
    identify: {
      description:
        "Work out which paper a local PDF is: the DOI printed on its first pages " +
        "(or a near-exact OpenAlex match of its embedded title), checked against the " +
        "title registered for that DOI. Read-only: the file is not moved or changed.",
      arguments: IdentifyArgsSchema,
      execute: async (
        args: z.infer<typeof IdentifyArgsSchema> & TestHooks,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        ctx.logger.info("Identifying {path}", { path: args.path });
        const res = await identifyPdf(args.path, client(ctx, args), {
          openalexApiKey: key(ctx),
        });
        const props = { status: res.status, message: res.message };
        if (res.status === "identified") {
          ctx.logger.info("{status}: {message}", props);
        } else {
          ctx.logger.warning("{status}: {message}", props);
        }
        const h = await ctx.writeResource(
          "identification",
          await fileInstance("identify", res.path),
          { ...res },
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
          ctx.logger.warning("No PDF for {doi}; open {url} in a browser", {
            doi: out.doi,
            url: out.landing_url,
          });
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
    pdfToText: {
      description:
        "Extract plain text from a local PDF (pdftotext if installed, otherwise the " +
        "built-in pdf.js reader). Optionally saves the full text as a .txt next to " +
        "the PDF and returns one chunk; use offset/next_offset for long papers.",
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
        const h = await ctx.writeResource(
          "pdfText",
          await fileInstance("text", res.path),
          { ...res },
        );
        return { dataHandles: [h] };
      },
    },
  },
};
