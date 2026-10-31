# @vcjdeboer/paper-fetcher

A [swamp](https://swamp-club.com) extension for working with scholarly papers by
DOI. Give it a DOI and it looks up the paper's metadata, tells you whether it is
open access, and downloads the PDF into a folder of your choice, with a JSON
provenance record next to every file that says where the PDF came from. It can
also file PDFs you saved by hand from a browser, search your local Zotero
library without touching it, and turn a PDF into plain text.

It is one model type, `@vcjdeboer/paper-fetcher`, with five methods. `resolve`
and `fetch` work on one DOI per run, `pdfToText` on one file, `importDownloads`
on every recent PDF in your downloads folder. Each method stores its result as
versioned swamp data, so you can query it later or chain it in a workflow.

| Method            | Input                                  | What it does                                                                                       | Writes                                                    |
| ----------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `resolve`         | `doi`                                  | Looks the DOI up in OpenAlex and Crossref. Downloads nothing.                                      | `work` resource                                           |
| `fetch`           | `doi`, `overwrite`                     | Downloads the PDF: open-access copies first, then the publisher's page.                            | `<doi>.pdf` + `<doi>.json` on disk, `download` resource   |
| `importDownloads` | `sinceHours`, `dryRun`                 | Files PDFs from your downloads folder under their DOI.                                             | copies + `<doi>.json` on disk, `importRun` resource       |
| `zoteroLookup`    | `doi`, `query`, `collection`, `limit`  | Searches a temporary copy of your Zotero database.                                                 | `zoteroResult` resource                                   |
| `pdfToText`       | `path`, `maxChars`, `offset`, `saveTxt` | Extracts text from a local PDF, in chunks.                                                        | `<name>.txt` next to the PDF (replaced if present; `saveTxt=false` to skip), `pdfText` resource |

## Install and set up

```sh
swamp extension pull @vcjdeboer/paper-fetcher

# one model instance; all settings are optional (defaults shown)
swamp model create @vcjdeboer/paper-fetcher papers \
  --global-arg papersDir=~/Papers \
  --global-arg downloadsDir=~/Downloads \
  --global-arg zoteroDir=~/Zotero
```

| Global argument  | Default       | Used by                       |
| ---------------- | ------------- | ----------------------------- |
| `papersDir`      | `~/Papers`    | `fetch`, `importDownloads`    |
| `downloadsDir`   | `~/Downloads` | `importDownloads`             |
| `zoteroDir`      | `~/Zotero`    | `zoteroLookup`                |
| `openalexApiKey` | none          | every OpenAlex request        |

OpenAlex works without a key. If you have one, keep it in a vault rather than
in the model definition:

```sh
swamp vault create local_encryption secrets
swamp vault put secrets OPENALEX_API_KEY
swamp model create @vcjdeboer/paper-fetcher papers \
  --global-arg 'openalexApiKey=${{ vault.get(secrets, OPENALEX_API_KEY) }}'
```

## Usage

```sh
# metadata and open-access status
swamp model method run papers resolve --input doi=10.1371/journal.pcbi.1003285

# download the PDF (DOI may also be written doi:10.x/y or https://doi.org/10.x/y)
swamp model method run papers fetch --input doi=10.1038/s41586-020-2649-2

# a paper that could not be downloaded: open its landing page in your browser,
# save the PDF, then file it
swamp model method run papers importDownloads --input sinceHours=24 --input dryRun=true
swamp model method run papers importDownloads --input sinceHours=24

# Zotero: by DOI, by title words, or by collection
swamp model method run papers zoteroLookup --input query="mole rat epigenome"
swamp model method run papers zoteroLookup --input collection=reading-list --input limit=50

# text from a PDF, 50,000 characters at a time
swamp model method run papers pdfToText --input path=~/Papers/10.1038_s41586-020-2649-2.pdf
swamp model method run papers pdfToText --input path=~/Papers/10.1038_s41586-020-2649-2.pdf --input offset=50000
```

Reading results back:

```sh
# every download outcome, one row per DOI
swamp data query 'modelName == "papers" && specName == "download"' \
  --select '{"doi": attributes.doi, "status": attributes.status, "route": attributes.route}'

# what still needs a manual download
swamp data query 'modelName == "papers" && specName == "download" && attributes.status == "not_fetched"' \
  --select '{"doi": attributes.doi, "open": attributes.landing_url}'
```

## Where the data comes from

The extension talks only to public, documented services and to the publisher
of the paper. It never sends anything except the DOI (or a title, see below),
your optional OpenAlex key, and an HTTP User-Agent that names this tool.

| Source                                                    | When                                                    | Request                                                                                       | What it returns / is used for                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [OpenAlex](https://docs.openalex.org)                     | `resolve`, `fetch`, `importDownloads`                   | `GET api.openalex.org/works/doi:<doi>`                                                        | Title, year, journal, authors, open-access status, locations of open-access PDFs, PubMed Central ID.              |
| OpenAlex search                                           | `importDownloads`, only for a PDF with no DOI in its text | `GET api.openalex.org/works?search=<embedded PDF title>`                                     | A DOI, accepted only if the titles match ≥ 90 % word-for-word in both directions.                                  |
| [Crossref](https://api.crossref.org)                      | `resolve`, `fetch`, `importDownloads`                   | `GET api.crossref.org/works/<doi>`                                                            | Fills metadata gaps; publisher-declared full-text links of type `application/pdf` (often subscription-only).       |
| [Europe PMC](https://europepmc.org)                       | `fetch`, when OpenAlex reports a PubMed Central ID      | `GET europepmc.org/backend/ptpmcrender.fcgi?accid=<PMCID>&blobtype=pdf`                       | The PMC copy of the PDF.                                                                                          |
| Open-access hosts (repositories, publisher OA copies)     | `fetch`                                                 | `GET` on each PDF URL reported by OpenAlex / Crossref                                         | The PDF.                                                                                                          |
| The publisher's landing page (via `https://doi.org/<doi>`) | `fetch`, when no open-access copy worked                | `GET` the landing page, then its `citation_pdf_url` meta tag                                  | The PDF, if the publisher gives it to your network. On a campus network or institutional VPN this usually includes subscription papers, because publishers recognise the institution's IP range. |
| Your Zotero library                                       | `zoteroLookup`                                          | none (local file)                                                                             | `zotero.sqlite` is copied to a temporary folder, opened read-only, and the copy is deleted. The live database is never opened, so Zotero can stay running. |

How `fetch` decides, in order:

1. If `<doi>.pdf` is already in `papersDir` and is a real PDF, stop with
   `already_present` (use `overwrite=true` to download again; the old file is
   only replaced once a new PDF has arrived). If that file name belongs to a
   *different* DOI (two DOIs can map to the same name), stop with `conflict`.
2. Try each open-access PDF URL (route `open_access:<source>`): OpenAlex's best
   location, other OpenAlex open-access locations, OpenAlex's `oa_url` when it
   ends in `.pdf`, Europe PMC.
3. Try the PDF links the publisher registered with Crossref (route
   `publisher:crossref_link`).
4. Fetch the publisher landing page. If it serves a PDF, keep it
   (`publisher:direct`); otherwise follow the page's `citation_pdf_url` meta tag,
   the tag Google Scholar uses (`publisher:citation_pdf_url`).
5. Otherwise stop with `not_fetched`, the landing URL, and the result of every
   attempt. If no server answered at all, the method fails with
   "Network unreachable" instead, so being offline is never mistaken for a
   paywall.

Every download must start with the PDF signature `%PDF-`; a login or paywall
page served under a `.pdf` URL is thrown away. Redirects are followed with a
cookie jar, because many publisher sites set a cookie on the first redirect.
Only `http`/`https` URLs on public hosts are followed: redirects or meta tags
that point at local files, `localhost` or private network addresses are
refused. The extension does not log in anywhere and does not try to get around
paywalls or bot protection: if your network has no access, you get
`not_fetched`.

## Files on disk

PDFs are named after their DOI with unsafe characters replaced:
`10.1038/s41586-020-2649-2` becomes `10.1038_s41586-020-2649-2.pdf`. Next to it,
`10.1038_s41586-020-2649-2.json` holds the provenance record:

```json
{
  "status": "downloaded",
  "doi": "10.1038/s41586-020-2649-2",
  "title": "Array programming with NumPy",
  "route": "open_access:openalex:best_oa_location",
  "source_url": "https://www.nature.com/articles/s41586-020-2649-2.pdf",
  "final_url": "https://www.nature.com/articles/s41586-020-2649-2.pdf",
  "sha256": "…",
  "bytes": 1218474,
  "retrieved_at": "2026-10-31T12:06:12Z",
  "tool": "swamp @vcjdeboer/paper-fetcher 2026.10.31.1",
  "attempts": [{ "route": "open_access:openalex:best_oa_location", "url": "…", "result": "ok" }]
}
```

(Shortened: the record also holds year, journal, `authors` — at most 30 names,
with `authors_total` giving the real count — open-access status, landing URL
and any lookup errors.) The same record is the `download` resource in swamp.
Imported files get `route: "import_downloads"`, the original file name and
time, where the DOI came from (`pdf_text` or `title_search`) and how well the
registered title matched the PDF text.

`importDownloads` reads the DOI from the first three pages of each PDF.
Statuses: `imported`, `would_import` (dry run), `already_present` (identical
file already filed), `conflict` (a *different* file with that DOI is already
filed, or claimed earlier in the same run — nothing is overwritten),
`duplicate` (same bytes as another download in this run), `doi_mismatch` (the
DOI's registered title does not match the PDF — check by hand), `unverified`
(OpenAlex and Crossref could not be reached, so the DOI could not be checked —
nothing copied; run again later), `no_doi`, `skipped` (not a real PDF, or
unreadable), `error` (a file-system error on that one file; the others are
still processed). Copies are written to a `.part` file first and renamed, so an
interruption never leaves a half-written PDF. Originals in the downloads folder
are never moved or deleted.

`zoteroLookup` returns `count` (all matches), `returned` and `truncated`
(`true` when `limit` cut the list). Attachments stored as "linked files"
relative to Zotero's *base directory* are reported with their raw path and
`exists: false`, because the base directory is a Zotero preference that this
extension does not read.

## Requirements

- swamp; no other runtime. Dependencies are bundled (`unpdf` for PDF text).
- Optional: `pdftotext` from [poppler](https://poppler.freedesktop.org)
  (`brew install poppler`, `apt install poppler-utils`). When present it is used
  for text extraction; otherwise the built-in pdf.js reader is used.
- Zotero 5 or later for `zoteroLookup`.

Tested on macOS (Apple Silicon) with swamp 20261006 and Deno 2.9.

## Not included (yet)

- **Browser route for subscription papers.** The original MCP version of this
  tool can open a dedicated Chrome window through an institutional
  library proxy (EZproxy) and download from there. That is not in this
  extension; for now, download those papers by hand and run `importDownloads`.
- **Batch runs over many DOIs** in one call. Run `fetch` per DOI, or loop
  over DOIs in a swamp workflow.
- **Writing to Zotero.** Add the downloaded PDFs to Zotero yourself (drag them
  in, or "Add Item by Identifier" with the DOI).
- **Unpaywall** as an extra open-access source (OpenAlex already includes
  Unpaywall's data).
- **Retry and back-off** when an API answers 429 (rate limited). The request
  is recorded as failed (`openalex HTTP 429`); run the method again later, or
  set `openalexApiKey`.
- **Swamp pre-flight checks** (e.g. "papersDir is writable"). Problems surface
  as a clear error when the method runs.

## Development

```sh
~/.swamp/deno/deno check extensions/models/paper_fetcher.ts
~/.swamp/deno/deno test -A extensions/models/   # network mocked, Zotero and PDFs generated
```

The `mcpb/` folder holds the original Python MCP server for Claude Desktop that
this extension was ported from; it is not part of the published extension.

## License

MIT — see [LICENSE](LICENSE).
