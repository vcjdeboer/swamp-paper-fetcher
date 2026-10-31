"""Browser route for paper-fetcher: fetch a PDF through the WUR EZproxy with a real Chrome window.

Design:
- A dedicated Chrome profile (default ~/.paper-fetcher/chrome-profile) is used, separate from the
  everyday Chrome profile: Chrome blocks automation of the default profile, and Lean Library is
  not installed here, so there are no redirect loops.
- Keeping the login: EZproxy uses a session cookie, which Chrome drops when the window closes.
  The tool saves all cookies of the profile to <profile>/paper-fetcher-cookies.json (mode 600)
  after each run and restores them at the next start. With a live proxy session the tool goes
  straight to the proxied publisher URL and no login page is shown at all.
- If a login is needed, the tool clicks the "Log in" button on the WUR library page (that only
  starts single sign-on; the tool never types or sees a password). If single sign-on still
  needs the person, the window waits for them to finish.
- The PDF is fetched with the same browser session, checked (%PDF- header and DOI in the text),
  and saved with a provenance record (route browser:wur_ezproxy).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse, urlunparse

from . import core

DEFAULT_PROXY_LOGIN = "https://library.wur.nl/WebQuery/rduser/ezproxy-login?url="
DEFAULT_PROXY_HOST_SUFFIX = ".library.ezproxy.wur.nl"
DEFAULT_PROFILE = "~/.paper-fetcher/chrome-profile"
DEFAULT_DIRECT_FORMAT = "https://{host}{suffix}{path}"
COOKIE_FILE = "paper-fetcher-cookies.json"
LOGIN_BUTTON_TEXTS = ("Log in", "Login", "Inloggen", "Log on")


# --------------------------------------------------------------------------- URL helpers


def proxied_host(host: str) -> str:
    """EZproxy proxy-by-hostname with HTTPS hyphens: '-' -> '--', '.' -> '-'."""
    return host.lower().replace("-", "--").replace(".", "-")


def to_proxied_url(url: str, suffix: str, fmt: str = DEFAULT_DIRECT_FORMAT) -> str | None:
    p = urlparse(url)
    if not p.netloc or p.netloc.lower() in ("doi.org", "dx.doi.org"):
        return None
    path = p.path + (f"?{p.query}" if p.query else "")
    return fmt.format(host=proxied_host(p.netloc.split(":")[0]), suffix=suffix, path=path)


def is_proxied(url: str, host_suffix: str) -> bool:
    """True only for proxied publisher hosts (a subdomain of the proxy host), not for the proxy's
    own login pages on the bare proxy host."""
    p = urlparse(url)
    host = p.netloc.lower().split(":")[0]
    suffix = host_suffix.lower().lstrip(".")
    return host.endswith("." + suffix) and not p.path.lower().startswith("/login")


def pdf_candidates_for(page_url: str, meta_pdf_url: str | None, doi: str) -> list[str]:
    """Ordered, de-duplicated list of URLs that may serve the PDF, given the (proxied) article URL.
    Works on proxied host names too, because only the path is changed."""
    out: list[str] = []

    def add(u: str | None) -> None:
        if u and u not in out:
            out.append(u)

    add(meta_pdf_url)
    p = urlparse(page_url)
    host, path = p.netloc.lower(), p.path

    def with_path(new_path: str, query: str = "") -> str:
        return urlunparse((p.scheme, p.netloc, new_path, "", query, ""))

    # Nature / Springer Nature journals: /articles/<id> -> /articles/<id>.pdf
    if "nature" in host and re.match(r"^/articles/[^/.]+$", path):
        add(with_path(path + ".pdf"))
    # Atypon platforms (PNAS, Science, ACS, Wiley, T&F, ...): /doi/<doi> or /doi/full|abs|epdf/<doi>
    m = re.match(r"^/doi/(?:(?:full|abs|epdf|pdf|reader)/)?(10\..+)$", path)
    if m:
        d = m.group(1)
        add(with_path(f"/doi/pdf/{d}", "download=true"))
        add(with_path(f"/doi/pdfdirect/{d}", "download=true"))
        add(with_path(f"/doi/pdf/{d}"))
    # ScienceDirect / Cell Press
    m = re.match(r"^/science/article/(?:abs/)?pii/([A-Z0-9]+)", path, re.IGNORECASE)
    if m:
        add(with_path(f"/science/article/pii/{m.group(1)}/pdfft", "isDTMRedir=true&download=true"))
    # Springer Link
    if "springer" in host and "/article/" in path:
        add(with_path(f"/content/pdf/{doi}.pdf"))
    return out


# --------------------------------------------------------------------------- cookie persistence


def _cookie_path(profile: Path) -> Path:
    return profile / COOKIE_FILE


async def restore_cookies(ctx, profile: Path) -> int:  # noqa: ANN001
    f = _cookie_path(profile)
    if not f.exists():
        return 0
    try:
        saved = json.loads(f.read_text())
    except (OSError, ValueError):
        return 0
    now = time.time()
    keep = [c for c in saved if c.get("expires", -1) in (-1, None) or c["expires"] > now]
    if keep:
        try:
            await ctx.add_cookies(keep)
        except Exception:  # noqa: BLE001  (a malformed cookie should never block a run)
            return 0
    return len(keep)


async def save_cookies(ctx, profile: Path) -> int:  # noqa: ANN001
    cookies = await ctx.cookies()
    f = _cookie_path(profile)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(cookies))
    os.chmod(tmp, 0o600)
    tmp.replace(f)
    return len(cookies)


# --------------------------------------------------------------------------- main routine


async def fetch_pdf_browser(
    raw_doi: str,
    download_dir: str | Path,
    profile_dir: str | Path = DEFAULT_PROFILE,
    proxy_login: str = DEFAULT_PROXY_LOGIN,
    proxy_host_suffix: str = DEFAULT_PROXY_HOST_SUFFIX,
    direct_format: str = DEFAULT_DIRECT_FORMAT,
    landing_url: str | None = None,
    login_timeout: float = 300.0,
    headless: bool = False,
    chrome_channel: str | None = "chrome",
    executable_path: str | None = None,
    openalex_api_key: str | None = None,
    overwrite: bool = False,
    prior_attempts: list[dict[str, str]] | None = None,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from playwright.async_api import Error as PWError
    from playwright.async_api import async_playwright

    doi = core.normalize_doi(raw_doi)
    out_dir = Path(os.path.expanduser(str(download_dir)))
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = core.doi_to_filename(doi)
    pdf_path = out_dir / f"{stem}.pdf"
    prov_path = out_dir / f"{stem}.json"
    if pdf_path.exists() and core.is_pdf_file(pdf_path) and not overwrite:
        return {"status": "already_present", "doi": doi, "path": str(pdf_path), "sha256": core._sha256(pdf_path)}

    # Metadata for the provenance record (always, also when the caller already knows the landing URL)
    if meta is None:
        try:
            res = await asyncio.to_thread(core.resolve_doi, doi, None, openalex_api_key)
            meta = res.as_dict()
        except Exception:  # noqa: BLE001
            meta = {}
    landing_url = landing_url or meta.get("landing_url") or f"https://doi.org/{doi}"

    profile = Path(os.path.expanduser(str(profile_dir)))
    profile.mkdir(parents=True, exist_ok=True)
    attempts: list[dict[str, str]] = list(prior_attempts or [])
    login_steps: list[str] = []

    async with async_playwright() as pw:
        launch_kwargs: dict[str, Any] = {"headless": headless, "accept_downloads": True}
        if executable_path:
            launch_kwargs["executable_path"] = executable_path
        elif chrome_channel:
            launch_kwargs["channel"] = chrome_channel
        try:
            ctx = await pw.chromium.launch_persistent_context(str(profile), **launch_kwargs)
        except PWError as e:
            msg = str(e).splitlines()[0]
            if "ProcessSingleton" in str(e) or ("profile" in msg.lower() and "in use" in msg.lower()):
                msg = "The paper-fetcher Chrome profile is already open in another window. Close it and retry."
            return {"status": "error", "doi": doi, "message": f"Could not start Chrome: {msg}"}
        try:
            restored = await restore_cookies(ctx, profile)
            if restored:
                login_steps.append(f"restored {restored} saved cookies")
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()

            # 1. Saved session: go straight to the proxied publisher page
            on_site = False
            direct = to_proxied_url(landing_url, proxy_host_suffix, direct_format) if restored else None
            if direct:
                try:
                    await page.goto(direct, wait_until="domcontentloaded", timeout=45_000)
                    on_site = is_proxied(page.url, proxy_host_suffix)
                except PWError as e:
                    attempts.append({"route": "proxy:direct", "url": direct, "result": str(e).splitlines()[0]})
                login_steps.append("direct proxied URL: " + ("session valid" if on_site else "session expired"))

            # 2. Otherwise: the library login page, auto-click "Log in", wait for single sign-on / the person
            waited_for_person = False
            if not on_site:
                start_url = proxy_login + quote(landing_url, safe="")
                try:
                    await page.goto(start_url, wait_until="domcontentloaded", timeout=60_000)
                except PWError as e:
                    attempts.append({"route": "proxy:start", "url": start_url, "result": str(e).splitlines()[0]})
                deadline = time.monotonic() + login_timeout
                clicked = False
                t0 = time.monotonic()
                while not is_proxied(page.url, proxy_host_suffix):
                    if not clicked:
                        for txt in LOGIN_BUTTON_TEXTS:
                            loc = page.get_by_role("link", name=txt, exact=True).or_(
                                page.get_by_role("button", name=txt, exact=True))
                            try:
                                if await loc.count() and await loc.first.is_visible():
                                    await loc.first.click(timeout=5_000)
                                    clicked = True
                                    login_steps.append(f"clicked '{txt}' on the library page")
                                    break
                            except PWError:
                                pass
                    if time.monotonic() > deadline:
                        await save_cookies(ctx, profile)
                        return {
                            "status": "needs_login",
                            "doi": doi,
                            "message": f"Not on the proxied site after {int(login_timeout)} s. Log in to WUR in "
                                       "the paper-fetcher Chrome window next time it opens.",
                            "current_url": page.url,
                            "login_steps": login_steps,
                            "attempts": attempts,
                        }
                    await asyncio.sleep(1.0)
                    if page.is_closed():
                        if not ctx.pages:
                            return {"status": "error", "doi": doi, "message": "The Chrome window was closed."}
                        page = ctx.pages[-1]
                # more than ~10 s means a person had to do something
                waited_for_person = time.monotonic() - t0 > 10
                login_steps.append("logged in by hand" if waited_for_person else "single sign-on without input")

            await save_cookies(ctx, profile)
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=30_000)
            except PWError:
                pass
            article_url = page.url
            meta_pdf = await page.evaluate(
                "() => { const m = document.querySelector('meta[name=\"citation_pdf_url\"]');"
                " return m ? new URL(m.content, location.href).href : null; }"
            )
            candidates = pdf_candidates_for(article_url, meta_pdf, doi)
            if not candidates:
                attempts.append({"route": "browser:find_pdf", "url": article_url, "result": "no PDF link found"})

            async def save(body: bytes, url: str, how: str) -> dict[str, Any]:
                pdf_path.write_bytes(body)
                txt = ""
                try:
                    txt = core.pdf_to_text(pdf_path, max_chars=20000, save_txt=False)["text"]
                except Exception:  # noqa: BLE001
                    pass
                await save_cookies(ctx, profile)
                record = {
                    "doi": doi,
                    "title": meta.get("title"),
                    "year": meta.get("year"),
                    "journal": meta.get("journal"),
                    "publisher": meta.get("publisher"),
                    "authors": meta.get("authors"),
                    "is_oa": meta.get("is_oa"),
                    "oa_status": meta.get("oa_status"),
                    "route": "browser:wur_ezproxy",
                    "method": how,
                    "source_url": url,
                    "article_url": article_url,
                    "login_wait": waited_for_person,
                    "login_steps": login_steps,
                    "path": str(pdf_path),
                    "sha256": core._sha256(pdf_path),
                    "bytes": pdf_path.stat().st_size,
                    "doi_found_in_text": doi in txt.lower(),
                    "retrieved_at": core._now(),
                    "tool": f"paper-fetcher {core.VERSION} (playwright)",
                    "attempts": attempts + [{"route": f"browser:{how}", "url": url, "result": "ok"}],
                }
                prov_path.write_text(json.dumps(record, indent=2))
                return {"status": "downloaded", **{k: record[k] for k in (
                    "doi", "title", "route", "method", "source_url", "path", "sha256", "bytes",
                    "doi_found_in_text", "login_wait", "login_steps")}}

            for url in candidates:
                # a) request with the browser session (cookies shared)
                try:
                    r = await ctx.request.get(url, timeout=60_000, headers={"Accept": "application/pdf,*/*"})
                    body = await r.body()
                    if r.ok and body[:5] == b"%PDF-":
                        return await save(body, url, "session_request")
                    attempts.append({"route": "browser:session_request", "url": url,
                                     "result": f"HTTP {r.status}, not a PDF" if r.ok else f"HTTP {r.status}"})
                except PWError as e:
                    attempts.append({"route": "browser:session_request", "url": url, "result": str(e).splitlines()[0]})

                # b) real navigation: catch either a download or a PDF response
                pdf_bodies: list[bytes] = []

                async def on_response(resp):  # noqa: ANN001
                    try:
                        if "pdf" in (resp.headers.get("content-type") or "").lower():
                            b = await resp.body()
                            if b[:5] == b"%PDF-":
                                pdf_bodies.append(b)
                    except Exception:  # noqa: BLE001
                        pass

                nav_page = await ctx.new_page()
                nav_page.on("response", on_response)
                try:
                    async with nav_page.expect_download(timeout=45_000) as dl_info:
                        try:
                            await nav_page.goto(url, timeout=45_000)
                        except PWError:
                            pass  # navigation that turns into a download raises; that is fine
                        for _ in range(20):
                            if pdf_bodies:
                                break
                            await asyncio.sleep(0.5)
                        if pdf_bodies:
                            raise _GotPdf()
                    dl = await dl_info.value
                    tmp = pdf_path.with_suffix(".part")
                    await dl.save_as(str(tmp))
                    if core.is_pdf_file(tmp):
                        body = tmp.read_bytes()
                        tmp.unlink(missing_ok=True)
                        return await save(body, url, "navigation_download")
                    tmp.unlink(missing_ok=True)
                    attempts.append({"route": "browser:navigation", "url": url, "result": "download was not a PDF"})
                except _GotPdf:
                    return await save(pdf_bodies[0], url, "navigation_response")
                except PWError as e:
                    if pdf_bodies:
                        return await save(pdf_bodies[0], url, "navigation_response")
                    attempts.append({"route": "browser:navigation", "url": url, "result": str(e).splitlines()[0]})
                finally:
                    await nav_page.close()

            return {
                "status": "not_found",
                "doi": doi,
                "message": "Logged in and on the publisher page, but no PDF could be downloaded. "
                           "Open article_url in Chrome, download the PDF by hand, then run import_downloads.",
                "article_url": article_url,
                "login_steps": login_steps,
                "attempts": attempts,
            }
        finally:
            try:
                await save_cookies(ctx, profile)
            except Exception:  # noqa: BLE001
                pass
            await ctx.close()


class _GotPdf(Exception):
    """Internal: a PDF response arrived during navigation, stop waiting for a download event."""
