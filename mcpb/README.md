# Paper Fetcher

A local MCP server for Claude Desktop. It gives Claude seven fixed tools for literature work. The tools run on your own Mac, with your own network.

| Tool | Input | What it does | Output |
|---|---|---|---|
| `resolve_doi` | DOI | Looks up OpenAlex and Crossref | Title, year, journal, authors, open-access status, landing URL, candidate PDF URLs |
| `fetch_pdf` | DOI | Downloads the PDF (see order below) | `<doi>.pdf` plus a `<doi>.json` provenance record |
| `fetch_pdf_browser` | DOI | Opens a dedicated Chrome profile via the WUR library proxy; you log in by hand once | `<doi>.pdf` + `.json` with route `browser:wur_ezproxy` |
| `fetch_status` | DOI (optional) | Reports browser downloads still running in the background | status per job |
| `import_downloads` | hours, dry_run | Files PDFs from Downloads by the DOI in their text (or a confident title match) | copies in the papers folder + `.json` with route `browser:import_downloads` |
| `zotero_lookup` | DOI and/or title words and/or collection | Searches a temporary copy of `zotero.sqlite` | Items with authors, collections, attachment paths, `has_pdf` |
| `pdf_to_text` | Path to a PDF | Extracts text (`pdftotext` if installed, otherwise `pypdf`) | Text in chunks, plus a `.txt` file next to the PDF |

## How fetch_pdf works

1. Normalise the DOI (accepts `10.x/y`, `doi:10.x/y` or `https://doi.org/10.x/y`).
2. If `<doi>.pdf` already exists and is a real PDF, stop: status `already_present`. Re-runs are safe.
3. Try the open-access PDF URLs from OpenAlex (best location first), Crossref PDF links, and Europe PMC if there is a PMC ID.
4. Open the publisher landing page and follow its `citation_pdf_url` meta tag. On WUR VPN or campus this also covers subscription papers, because publishers recognise the WUR IP address.
5. If nothing works and the browser fallback is on: continue with `fetch_pdf_browser`. Otherwise status `needs_browser`, with the landing URL.

Every download is checked: the file must start with `%PDF-`. A login page saved as `.pdf` is thrown away.

The provenance record holds: DOI, title, year, journal, authors, open-access status, the route that worked, source URL, final URL after redirects, sha256, size, time, tool version and every attempt with its result.

File names: `10.1038/s41586-025-09694-5` becomes `10.1038_s41586-025-09694-5.pdf`.

## The browser route

`fetch_pdf_browser` starts your installed Google Chrome with its own profile (`~/.paper-fetcher/chrome-profile`), separate from your everyday Chrome. It opens `library.wur.nl/WebQuery/rduser/ezproxy-login?url=<article>`.

- **Saved login.** EZproxy uses a session cookie that Chrome drops when the window closes. The tool saves the profile's cookies to `paper-fetcher-cookies.json` in the profile folder (readable only by you) and restores them on the next run.
- **Live session:** the tool goes straight to the proxied publisher URL (`www-pnas-org.library.ezproxy.wur.nl/...`). No login page.
- **Expired session:** it opens the WUR library page and clicks "Log in" itself. If your WUR single sign-on is still valid, that completes without input. Only when single sign-on asks for your password do you log in by hand; the window waits up to 5 minutes. The tool never types or sees a password.
- **Background jobs.** The link between Claude and your Mac gives up after about 60 seconds. Browser downloads therefore run in the background: after ~45 s the tool answers `in_progress`, and `fetch_status` reports the result later.
- On the proxied publisher page it looks for the PDF link: the `citation_pdf_url` tag, then publisher patterns (Nature, Atypon sites such as PNAS/Science/Wiley, ScienceDirect, Springer).
- It downloads with the same session, first as a direct request, then by real navigation (catching a download or a PDF response).
- Statuses: `downloaded`, `already_present`, `needs_login`, `not_found`, `error`.
- The window must be visible; publishers block hidden browsers. Close the paper-fetcher Chrome window between runs if Chrome reports the profile is in use.

## Zotero safety

`zotero_lookup` copies `zotero.sqlite` to a temporary folder, opens the copy read-only, and deletes it afterwards. The live database is never opened. Each call takes a few seconds on a large library because of that copy.

Title search matches whole words from their start: `aging` matches "Aging" and "aging-related", but not "imaging". Deleted items (in the Zotero bin) are left out.

## Install in Claude Desktop

1. Settings → Desktop app → Extensions → Advanced settings → Extension Developer → **Install Extension…**
2. Choose `paper-fetcher-0.2.1.mcpb`.
3. Check the settings: download folder (default `~/Papers`), Zotero folder (default `~/Zotero`). The OpenAlex key is optional.
4. The seven tools appear under the "+" menu → Connectors.

The extension uses the `uv` runtime. Claude Desktop manages Python and the dependencies itself (`mcp` 1.x, `httpx`, `pypdf`, `playwright`, pinned in `uv.lock`).

## Develop and test

```bash
uv sync --group dev
uv run pytest -q          # 27 tests: network mocked, browser route against a local fake EZproxy with real Chromium
uv run src/server.py      # runs the server on stdio
npx @anthropic-ai/mcpb pack . paper-fetcher-0.2.1.mcpb
```

## Not included yet

- Writing to Zotero. Import the downloaded PDFs yourself by dragging them in, or "Add Item by Identifier" with the DOI.
- Swamp integration.
