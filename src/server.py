#!/usr/bin/env python3
"""paper-fetcher MCP server: thin wrapper around paper_fetcher.core and paper_fetcher.browser.

Configuration comes from environment variables, set by Claude Desktop from the extension settings:
  PAPER_FETCHER_DOWNLOAD_DIR     where PDFs and provenance JSON go (default ~/Papers)
  PAPER_FETCHER_ZOTERO_DIR       Zotero data directory (default ~/Zotero)
  PAPER_FETCHER_DOWNLOADS_DIR    browser downloads folder for import_downloads (default ~/Downloads)
  PAPER_FETCHER_BROWSER_FALLBACK "true"/"false": fetch_pdf falls back to the browser route
  PAPER_FETCHER_CHROME_PROFILE   dedicated Chrome profile (default ~/.paper-fetcher/chrome-profile)
  PAPER_FETCHER_PROXY_LOGIN      EZproxy login prefix (default WUR)
  PAPER_FETCHER_PROXY_HOST       proxied host suffix (default .library.ezproxy.wur.nl)
  PAPER_FETCHER_CHROME_PATH      optional Chrome/Chromium executable (default: installed Google Chrome)
  PAPER_FETCHER_HEADLESS         "true" only for tests; publishers block hidden browsers
  OPENALEX_API_KEY               optional
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mcp.server.fastmcp import FastMCP  # noqa: E402

from paper_fetcher import browser, core  # noqa: E402


def _env(name: str, default: str) -> str:
    v = os.environ.get(name, "").strip()
    # unset optional fields can arrive as the literal placeholder
    if not v or v.startswith("${"):
        return default
    return v


def _flag(name: str, default: bool) -> bool:
    return _env(name, "true" if default else "false").lower() in ("1", "true", "yes", "on")


DOWNLOAD_DIR = _env("PAPER_FETCHER_DOWNLOAD_DIR", "~/Papers")
ZOTERO_DIR = _env("PAPER_FETCHER_ZOTERO_DIR", "~/Zotero")
DOWNLOADS_DIR = _env("PAPER_FETCHER_DOWNLOADS_DIR", "~/Downloads")
BROWSER_FALLBACK = _flag("PAPER_FETCHER_BROWSER_FALLBACK", True)
CHROME_PROFILE = _env("PAPER_FETCHER_CHROME_PROFILE", browser.DEFAULT_PROFILE)
PROXY_LOGIN = _env("PAPER_FETCHER_PROXY_LOGIN", browser.DEFAULT_PROXY_LOGIN)
PROXY_HOST = _env("PAPER_FETCHER_PROXY_HOST", browser.DEFAULT_PROXY_HOST_SUFFIX)
DIRECT_FORMAT = _env("PAPER_FETCHER_DIRECT_FORMAT", browser.DEFAULT_DIRECT_FORMAT)
CHROME_PATH = _env("PAPER_FETCHER_CHROME_PATH", "") or None
HEADLESS = _flag("PAPER_FETCHER_HEADLESS", False)
OPENALEX_KEY = _env("OPENALEX_API_KEY", "") or None
# The link between Claude and this computer gives up after ~60 s; answer well before that.
WAIT_BUDGET = float(_env("PAPER_FETCHER_WAIT_BUDGET", "45"))

mcp = FastMCP("paper-fetcher")


def _j(obj) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False, default=str)


# --------------------------------------------------------------------------- background browser jobs
# A browser download that waits for a login can take minutes. It runs as a background job in this
# server process: the tools wait up to WAIT_BUDGET seconds and otherwise answer "in_progress";
# fetch_status reports the outcome later. One Chrome window on the profile at a time.

_JOBS: dict[str, dict] = {}
_BROWSER_LOCK = asyncio.Lock()


async def _browser_job(doi: str, landing_url: str | None, overwrite: bool, login_timeout: int,
                       prior_attempts: list | None, meta: dict | None) -> dict:
    async with _BROWSER_LOCK:
        return await browser.fetch_pdf_browser(
            doi,
            DOWNLOAD_DIR,
            profile_dir=CHROME_PROFILE,
            proxy_login=PROXY_LOGIN,
            proxy_host_suffix=PROXY_HOST,
            direct_format=DIRECT_FORMAT,
            landing_url=landing_url,
            login_timeout=login_timeout,
            headless=HEADLESS,
            executable_path=CHROME_PATH,
            openalex_api_key=OPENALEX_KEY,
            overwrite=overwrite,
            prior_attempts=prior_attempts,
            meta=meta,
        )


def _start_job(doi: str, landing_url: str | None, overwrite: bool, login_timeout: int,
               prior_attempts: list | None = None, meta: dict | None = None) -> dict:
    key = core.normalize_doi(doi)
    job = _JOBS.get(key)
    if job and not job["task"].done():
        return job
    task = asyncio.create_task(_browser_job(key, landing_url, overwrite, login_timeout, prior_attempts, meta))
    job = {"doi": key, "task": task, "started": time.time()}
    _JOBS[key] = job
    return job


async def _wait_job(job: dict, budget: float) -> dict:
    try:
        return await asyncio.wait_for(asyncio.shield(job["task"]), timeout=max(1.0, budget))
    except asyncio.TimeoutError:
        return {
            "status": "in_progress",
            "doi": job["doi"],
            "running_for_s": int(time.time() - job["started"]),
            "message": "A Chrome window is open via the WUR library proxy. If it shows a login, log in "
                       "there; the download then finishes by itself. Check with fetch_status.",
        }
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "doi": job["doi"], "message": f"{type(e).__name__}: {e}"}


# --------------------------------------------------------------------------- tools


@mcp.tool()
def resolve_doi(doi: str) -> str:
    """Look up a DOI in OpenAlex and Crossref. Returns title, year, journal, authors,
    open-access status, the publisher landing URL and candidate PDF URLs. Does not download."""
    return _j(core.resolve_doi(doi, openalex_api_key=OPENALEX_KEY).as_dict())


@mcp.tool()
async def fetch_pdf(doi: str, overwrite: bool = False, browser_fallback: bool = True) -> str:
    """Download the PDF for a DOI into the configured folder as <doi>.pdf, with a <doi>.json
    provenance record (route, source URL, sha256, time, every attempt). Tries open-access copies
    first, then the publisher page. If that fails and browser_fallback is on, it continues with the
    browser route (Chrome via the WUR library proxy, saved login). If the browser step takes longer
    than ~45 s (for example a login), the answer is 'in_progress'; check later with fetch_status.
    Skips the download if a valid PDF is already there, unless overwrite is true."""
    t0 = time.monotonic()
    res = await asyncio.to_thread(core.resolve_doi, doi, None, OPENALEX_KEY)
    result = await asyncio.to_thread(core.fetch_pdf, doi, DOWNLOAD_DIR, None, OPENALEX_KEY, overwrite)
    if result.get("status") == "needs_browser" and browser_fallback and BROWSER_FALLBACK:
        job = _start_job(doi, result.get("landing_url"), overwrite, 300,
                         prior_attempts=result.get("attempts"), meta=res.as_dict())
        return _j(await _wait_job(job, WAIT_BUDGET - (time.monotonic() - t0)))
    return _j(result)


@mcp.tool()
async def fetch_pdf_browser(doi: str, overwrite: bool = False, login_timeout: int = 300) -> str:
    """Download a PDF through the WUR library proxy in a visible Chrome window (dedicated profile,
    separate from your normal Chrome). The login is saved: with a live proxy session it goes straight
    to the publisher; otherwise it clicks 'Log in' on the library page and, if single sign-on still
    needs you, waits up to login_timeout seconds. Saves <doi>.pdf and <doi>.json (route
    browser:wur_ezproxy). Answers 'in_progress' after ~45 s; check later with fetch_status.
    Other statuses: downloaded, already_present, needs_login, not_found, error."""
    job = _start_job(doi, None, overwrite, login_timeout)
    return _j(await _wait_job(job, WAIT_BUDGET))


@mcp.tool()
async def fetch_status(doi: str = "", wait_seconds: int = 30) -> str:
    """Status of browser downloads started by fetch_pdf or fetch_pdf_browser in this session.
    With a DOI: waits up to wait_seconds (max 45) for that job and returns its result.
    Without a DOI: lists all jobs. Also reports a PDF that is already in the papers folder."""
    if doi:
        key = core.normalize_doi(doi)
        job = _JOBS.get(key)
        if job:
            return _j(await _wait_job(job, min(float(wait_seconds), WAIT_BUDGET)))
        pdf = Path(os.path.expanduser(DOWNLOAD_DIR)) / f"{core.doi_to_filename(key)}.pdf"
        if pdf.exists():
            return _j({"status": "already_present", "doi": key, "path": str(pdf)})
        return _j({"status": "unknown", "doi": key, "message": "No job for this DOI in this session."})
    out = []
    for key, job in _JOBS.items():
        t = job["task"]
        row = {"doi": key, "running_for_s": int(time.time() - job["started"])}
        if t.done():
            r = t.result() if not t.exception() else {"status": "error", "message": str(t.exception())}
            row.update({"status": r.get("status"), "path": r.get("path")})
        else:
            row["status"] = "in_progress"
        out.append(row)
    return _j({"jobs": out})


@mcp.tool()
def import_downloads(since_hours: float = 48, dry_run: bool = False) -> str:
    """Pick up PDFs from the Downloads folder (changed in the last since_hours), read each PDF's DOI
    from its first pages (or match its embedded title), check it against the title from OpenAlex/
    Crossref, and copy it into the papers folder as <doi>.pdf with a provenance record (route
    browser:import_downloads). Originals stay in Downloads. Use dry_run to see what would happen."""
    return _j(core.import_downloads(DOWNLOADS_DIR, DOWNLOAD_DIR, since_hours=since_hours,
                                    dry_run=dry_run, openalex_api_key=OPENALEX_KEY))


@mcp.tool()
def zotero_lookup(doi: str = "", query: str = "", collection: str = "", limit: int = 20) -> str:
    """Search the Zotero library (read-only, on a temporary copy of zotero.sqlite).
    doi: exact DOI match. query: words that must all appear in the title.
    collection: only items in this collection. Returns items with authors, collections and
    attachment file paths (and whether the PDF file exists)."""
    return _j(core.zotero_lookup(ZOTERO_DIR, doi=doi or None, query=query or None,
                                 collection=collection or None, limit=limit))


@mcp.tool()
def pdf_to_text(path: str, max_chars: int = 50000, offset: int = 0) -> str:
    """Extract plain text from a local PDF (pdftotext if installed, otherwise pypdf).
    Blank lines and lines with only numbers are removed. The full text is also saved as a
    .txt file next to the PDF. Use offset/next_offset to read long papers in parts."""
    return _j(core.pdf_to_text(path, max_chars=max_chars, offset=offset))


if __name__ == "__main__":
    mcp.run()
