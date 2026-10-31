# @vcjdeboer/paper-fetcher

A [swamp](https://swamp-club.com) extension for working with scholarly papers by
DOI. Give it a DOI and it looks up the paper's metadata, tells you whether it is
open access, and downloads the PDF into a folder of your choice, with a JSON
provenance record next to the file that says where it came from. Give it a PDF
and it tells you which paper it is. It can also turn a PDF into plain text.

It is one model type, `@vcjdeboer/paper-fetcher`, with four methods. Each works
on one DOI or one file per run and stores its result as versioned swamp data,
so you can query it later or chain it in a workflow.

| Method      | Input                                   | What it does                                                                     | Writes                                                                   |
| ----------- | --------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `resolve`   | `doi`                                   | DOI → metadata and open-access status (OpenAlex, Crossref). Downloads nothing.   | `work` resource                                                          |
| `identify`  | `path`                                  | PDF → DOI: which paper is this file? Checked against the registered title.       | `identification` resource (the file is not touched)                      |
| `fetch`     | `doi`, `overwrite`                      | DOI → PDF: open-access copies first, then publisher links.                       | `<doi>.pdf` + `<doi>.json` on disk, `download` resource                  |
| `pdfToText` | `path`, `maxChars`, `offset`, `saveTxt` | PDF → plain text, in chunks.                                                     | `<name>.txt` next to the PDF (optional, replaces), `pdfText` resource    |

## Install and set up

```sh
swamp extension pull @vcjdeboer/paper-fetcher

# one model instance; papersDir is where fetch saves PDFs (default ~/Papers)
swamp model create @vcjdeboer/paper-fetcher papers --global-arg papersDir=~/Papers
```

| Global argument  | Default    | Used by                                     |
| ---------------- | ---------- | ------------------------------------------- |
| `papersDir`      | `~/Papers` | `fetch`                                     |
| `openalexApiKey` | none       | every OpenAlex request (optional, vault only) |

### OpenAlex API key: always in a vault

OpenAlex works without a key; a free key gives you a higher rate limit. The
extension marks `openalexApiKey` as **sensitive**, so swamp only accepts it as a
reference to a vault: a key typed in as plain text is refused and nothing is
written. Store it once and reference it:

```sh
swamp vault create local_encryption secrets
swamp vault put secrets OPENALEX_API_KEY          # prompts for the key; it is not echoed
swamp model create @vcjdeboer/paper-fetcher papers \
  --global-arg 'openalexApiKey=${{ vault.get(secrets, OPENALEX_API_KEY) }}'
```

What happens with the key:

- **Plain text is refused.** `--global-arg openalexApiKey=<key>` fails with
  "marked sensitive and cannot be set to a literal value"; nothing is saved.
- **Only the reference is stored.** The model definition holds
  `${{ vault.get(secrets, OPENALEX_API_KEY) }}`; swamp reads the key from the
  vault at run time and redacts it in stored output. A `local_encryption`
  vault keeps the encrypted key under `.swamp/`, which `swamp init` puts in
  `.gitignore`, so it is never committed.
- **Hand-edited definitions are caught.** If someone pastes a key straight into
  the model's YAML file, swamp does not block the run, but
  `swamp doctor secrets` reports it. Run it to check a repository:

```sh
swamp doctor secrets
```

The key is sent only to OpenAlex (as the `api_key` query parameter) and is
never logged. The extension package itself contains no keys: each user stores
their own. No other credentials are used — the extension never logs in
anywhere.

## Usage

```sh
# metadata and open-access status
swamp model method run papers resolve --input doi=10.1371/journal.pcbi.1003285

# download the PDF (DOI may also be written doi:10.x/y or https://doi.org/10.x/y)
swamp model method run papers fetch --input doi=10.1038/s41586-020-2649-2

# which paper is this file?
swamp model method run papers identify --input "path=~/Downloads/download (3).pdf"

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

# which files were identified, and how sure
swamp data query 'modelName == "papers" && specName == "identification"' \
  --select '{"file": attributes.path, "doi": attributes.doi, "status": attributes.status}'
```

## Where the data comes from

The extension talks only to public, documented services and to the publisher
of the paper. It sends nothing except the DOI (or, for `identify`, a title read
from the PDF), your optional OpenAlex key, and an HTTP User-Agent that names
this tool. PDF contents never leave your computer.

| Source                                                     | When                                                     | Request                                                                 | What it returns / is used for                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [OpenAlex](https://docs.openalex.org)                      | `resolve`, `fetch`, `identify`                           | `GET api.openalex.org/works/doi:<doi>`                                  | Title, year, journal, authors, open-access status, locations of open-access PDFs, PubMed Central ID.              |
| OpenAlex search                                            | `identify`, only for a PDF with no DOI in its text       | `GET api.openalex.org/works?search=<title embedded in the PDF>`         | A DOI, accepted only if the titles match ≥ 90 % word-for-word in both directions.                                  |
| [Crossref](https://api.crossref.org)                       | `resolve`, `fetch`, `identify`                           | `GET api.crossref.org/works/<doi>`                                      | Fills metadata gaps; publisher-declared full-text links of type `application/pdf` (often subscription-only).       |
| [Europe PMC](https://europepmc.org)                        | `fetch`, when OpenAlex reports a PubMed Central ID       | `GET europepmc.org/backend/ptpmcrender.fcgi?accid=<PMCID>&blobtype=pdf` | The PMC copy of the PDF.                                                                                          |
| Open-access hosts (repositories, publisher OA copies)      | `fetch`                                                  | `GET` on each PDF URL reported by OpenAlex                              | The PDF.                                                                                                          |
| The publisher's landing page (via `https://doi.org/<doi>`) | `fetch`, when no other source worked                     | `GET` the landing page, then its `citation_pdf_url` meta tag            | The PDF, if the publisher gives it to your network. On a campus network or institutional VPN this usually includes subscription papers, because publishers recognise the institution's IP range. |

### How `fetch` decides

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
   (`publisher:direct`); otherwise follow the page's `citation_pdf_url` meta
   tag, the tag Google Scholar uses (`publisher:citation_pdf_url`).
5. Otherwise stop with `not_fetched`, the landing URL, and the result of every
   attempt. Download that paper in your browser yourself; `identify` can confirm
   which paper the saved file is. If no server answered at all, the method fails
   with "Network unreachable" instead, so being offline is never mistaken for a
   paywall.

Every download must start with the PDF signature `%PDF-`; a login or paywall
page served under a `.pdf` URL is thrown away. PDFs are written to a `.part`
file and renamed, so an interrupted download never leaves a half-written PDF.
Redirects are followed with a cookie jar, because many publisher sites set a
cookie on the first redirect. Only `http`/`https` URLs on public hosts are
followed: redirects or meta tags that point at local files, `localhost` or
private network addresses are refused. The extension does not log in anywhere
and does not try to get around paywalls or bot protection.

### How `identify` decides

1. Read the text of the first three pages and take the paper's own DOI: the
   DOI that appears most often there (earliest on a tie). DOIs in a reference
   list appear once each and later, so they rarely win.
2. If the text holds no DOI, look up the title embedded in the PDF's document
   information in OpenAlex and accept only a near-exact match.
3. Look the DOI up and check how many words of its registered title appear in
   the PDF text (`title_match`, 0–1).

Statuses: `identified`; `doi_mismatch` (the registered title is not in the PDF —
often the DOI of a cited paper; check by hand); `unverified` (a DOI was found
but OpenAlex and Crossref could not be reached to check it); `no_doi`. The file
is only read, never moved, renamed or changed.

## Files on disk

`fetch` names PDFs after their DOI with unsafe characters replaced:
`10.1038/s41586-020-2649-2` becomes `10.1038_s41586-020-2649-2.pdf`. Next to it,
`10.1038_s41586-020-2649-2.json` holds the provenance record (shortened):

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
  "tool": "swamp @vcjdeboer/paper-fetcher 2026.10.31.3",
  "attempts": [{ "route": "open_access:openalex:best_oa_location", "url": "…", "result": "ok" }]
}
```

The full record also holds year, journal, `authors` (at most 30 names;
`authors_total` gives the real count), open-access status, landing URL and any
lookup errors. The same record is the `download` resource in swamp.

## Requirements

- swamp; no other runtime. Dependencies are bundled (`unpdf` for PDF text).
- Optional: `pdftotext` from [poppler](https://poppler.freedesktop.org)
  (`brew install poppler`, `apt install poppler-utils`). When present it is used
  for text extraction (with a 120 s limit per file); otherwise the built-in
  pdf.js reader is used.

Tested on macOS (Apple Silicon) with swamp 20261006 and Deno 2.9.

## Not included (yet)

- **Browser route for subscription papers** through an institutional library
  proxy (EZproxy). For now, download those papers by hand.
- **Filing downloaded PDFs** into the papers folder. `identify` tells you which
  paper a file is, but does not move or rename it.
- **Batch runs over many DOIs** in one call. Run `fetch` per DOI, or loop over
  DOIs in a swamp workflow.
- **Reference managers.** Zotero support is planned as a separate extension.
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
~/.swamp/deno/deno test -A extensions/models/   # network mocked, PDFs generated
```

The `mcpb/` folder holds the original Python MCP server for Claude Desktop that
this extension was ported from; it is not part of the published extension.

## License

MIT — see [LICENSE](LICENSE).
