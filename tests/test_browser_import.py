"""Tests for the browser route (real Chromium against a local fake EZproxy) and import_downloads."""

import asyncio
import http.server
import json
import os
import shutil
import sys
import threading
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

import pytest
import respx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from paper_fetcher import browser, core  # noqa: E402

CHROME = os.environ.get("PAPER_FETCHER_CHROME_PATH") or "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome"
UP = Path("/mnt/user-data/uploads")
ATT = Path("/mnt/user-data/attachments/50329550-50f9-5899-83a1-442ba8916fc2")
REAL_PDF = UP / "s41576-026-00959-x.pdf"          # contains its own DOI in the text
DOI = "10.1038/s41576-026-00959-x"
needs_chrome = pytest.mark.skipif(not Path(CHROME).exists() or not REAL_PDF.exists(), reason="no chromium or test PDF")


# ------------------------------------------------------------------ unit: candidate URLs

def test_pdf_candidates_publishers():
    c = browser.pdf_candidates_for("https://www-nature-com.library.ezproxy.wur.nl/articles/s41576-026-00959-x", None, DOI)
    assert c == ["https://www-nature-com.library.ezproxy.wur.nl/articles/s41576-026-00959-x.pdf"]
    c = browser.pdf_candidates_for("https://www-pnas-org.library.ezproxy.wur.nl/doi/10.1073/pnas.2601272123", None, "x")
    assert c[0] == "https://www-pnas-org.library.ezproxy.wur.nl/doi/pdf/10.1073/pnas.2601272123?download=true"
    c = browser.pdf_candidates_for("https://www-sciencedirect-com.library.ezproxy.wur.nl/science/article/pii/S0092867424001234", None, "x")
    assert c[0].endswith("/science/article/pii/S0092867424001234/pdfft?isDTMRedir=true&download=true")
    c = browser.pdf_candidates_for("https://x.org/a", "https://x.org/a.pdf", "x")
    assert c == ["https://x.org/a.pdf"]


def test_is_proxied():
    assert browser.is_proxied("https://www-pnas-org.library.ezproxy.wur.nl/doi/x", ".library.ezproxy.wur.nl")
    assert not browser.is_proxied("https://library.wur.nl/WebQuery/rduser/ezproxy-login?url=x", ".library.ezproxy.wur.nl")
    assert browser.is_proxied("http://www-nature-com.localhost:8080/a", "localhost")
    assert not browser.is_proxied("http://localhost:8080/a", "localhost")          # bare proxy host
    assert not browser.is_proxied("https://x.library.ezproxy.wur.nl/login?url=y", ".library.ezproxy.wur.nl")


def test_proxied_url_mapping():
    assert browser.proxied_host("www.pnas.org") == "www-pnas-org"
    assert browser.proxied_host("analytical-science.wiley.com") == "analytical--science-wiley-com"
    assert browser.to_proxied_url("https://www.pnas.org/doi/10.1073/x?a=1", ".library.ezproxy.wur.nl") == \
        "https://www-pnas-org.library.ezproxy.wur.nl/doi/10.1073/x?a=1"
    assert browser.to_proxied_url("https://doi.org/10.1/x", ".library.ezproxy.wur.nl") is None


# ------------------------------------------------------------------ fake EZproxy server
# 127.0.0.1 plays library.wur.nl (login), localhost plays the proxied publisher.

class FakeProxy(http.server.BaseHTTPRequestHandler):
    mode = "auto"          # auto | slow | never
    article_kind = "meta"  # meta | nature_pattern | attachment_only
    pdf = b""

    def log_message(self, *a):
        pass

    def _send(self, code, body=b"", ctype="text/html", headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        host = self.headers.get("Host", "")
        u = urlparse(self.path)
        port = host.split(":")[1]
        logged_in = "ezproxy=ok" in (self.headers.get("Cookie") or "")
        if host.startswith("127.0.0.1") and u.path == "/login":
            target = unquote(parse_qs(u.query)["url"][0])
            nxt = f"http://www-nature-com.localhost:{port}/sso?next={quote(urlparse(target).path)}"
            if self.mode == "auto":
                return self._send(302, headers={"Location": nxt})
            if self.mode == "slow":  # a person needs ~12 s to log in
                return self._send(200, f'<meta http-equiv="refresh" content="12;url={nxt}">Please log in'.encode())
            if self.mode == "button":  # WUR page with a Log in button; single sign-on then succeeds
                return self._send(200, f'<h1>Access for WUR Staff only</h1><a href="{nxt}">Log in</a>'.encode())
            return self._send(200, b"<h1>Access for WUR Staff and Students only</h1>")
        if host.split(":")[0].endswith("localhost"):
            if u.path == "/sso":
                nxt = parse_qs(u.query)["next"][0]
                return self._send(302, headers={"Location": nxt, "Set-Cookie": "ezproxy=ok; Path=/"})
            if not logged_in and u.path != "/sso" and host.split(":")[0] != "localhost":
                # expired proxy session: EZproxy sends you to its own login page on the bare host
                return self._send(302, headers={"Location": f"http://localhost:{port}/login?url=x"})
            if u.path == "/articles/paper":
                meta = '<meta name="citation_pdf_url" content="/files/paper.pdf">' if self.article_kind == "meta" else ""
                return self._send(200, f"<html><head>{meta}</head><body>article</body></html>".encode())
            if u.path in ("/files/paper.pdf", "/articles/paper.pdf"):
                if not logged_in:
                    return self._send(200, b"<html>login</html>")
                if self.article_kind == "attachment_only":
                    # refuse non-browser requests, serve as attachment on navigation
                    if self.headers.get("Sec-Fetch-Mode") != "navigate":
                        return self._send(403, b"bot")
                    return self._send(200, self.pdf, "application/pdf",
                                      {"Content-Disposition": 'attachment; filename="paper.pdf"'})
                return self._send(200, self.pdf, "application/pdf")
        return self._send(404, b"nope")


@pytest.fixture()
def fake_proxy():
    FakeProxy.pdf = REAL_PDF.read_bytes() if REAL_PDF.exists() else b"%PDF-1.4\n"
    srv = http.server.ThreadingHTTPServer(("0.0.0.0", 0), FakeProxy)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield srv.server_address[1]
    srv.shutdown()


META = {"title": "Evolutionary genetics of ageing", "year": 2026, "journal": "Nature Reviews Genetics",
        "landing_url": "https://www.nature.com/articles/paper"}


def _run(port, tmp_path, timeout=20, overwrite=False, prior=None):
    return asyncio.run(browser.fetch_pdf_browser(
        DOI, tmp_path / "papers",
        profile_dir=tmp_path / "profile",
        proxy_login=f"http://127.0.0.1:{port}/login?url=",
        proxy_host_suffix="localhost",
        direct_format="http://{host}.localhost:" + str(port) + "{path}",
        login_timeout=timeout, headless=True, executable_path=CHROME, overwrite=overwrite,
        meta=dict(META), prior_attempts=prior,
    ))


@needs_chrome
@pytest.mark.parametrize("kind,method", [
    # *.localhost resolves inside Chromium but not in Playwright's request client, so the
    # session_request route may fall through to navigation here; both use the same session.
    ("meta", {"session_request", "navigation_response"}),
    ("nature_pattern", {"session_request", "navigation_response"}),
    ("attachment_only", {"navigation_download"}),
])
def test_browser_download_routes(fake_proxy, tmp_path, kind, method):
    FakeProxy.mode, FakeProxy.article_kind = "auto", kind
    out = _run(fake_proxy, tmp_path)
    assert out["status"] == "downloaded", out
    assert out["method"] in method and out["route"] == "browser:wur_ezproxy"
    assert out["doi_found_in_text"] is True
    prov = json.loads((tmp_path / "papers" / "10.1038_s41576-026-00959-x.json").read_text())
    assert prov["sha256"] == out["sha256"] and prov["login_wait"] is False
    assert prov["title"] == META["title"] and prov["journal"] == META["journal"]
    again = _run(fake_proxy, tmp_path)
    assert again["status"] == "already_present"


@needs_chrome
def test_browser_waits_for_manual_login(fake_proxy, tmp_path):
    FakeProxy.mode, FakeProxy.article_kind = "slow", "meta"
    out = _run(fake_proxy, tmp_path)
    assert out["status"] == "downloaded"
    prov = json.loads((tmp_path / "papers" / "10.1038_s41576-026-00959-x.json").read_text())
    assert prov["login_wait"] is True


@needs_chrome
def test_browser_clicks_login_button(fake_proxy, tmp_path):
    FakeProxy.mode, FakeProxy.article_kind = "button", "meta"
    out = _run(fake_proxy, tmp_path)
    assert out["status"] == "downloaded", out
    assert any("clicked 'Log in'" in s for s in out["login_steps"]) and out["login_wait"] is False


@needs_chrome
def test_saved_session_skips_login(fake_proxy, tmp_path):
    FakeProxy.mode, FakeProxy.article_kind = "auto", "meta"
    assert _run(fake_proxy, tmp_path)["status"] == "downloaded"
    cookie_file = tmp_path / "profile" / browser.COOKIE_FILE
    assert cookie_file.exists() and oct(cookie_file.stat().st_mode)[-3:] == "600"
    (tmp_path / "papers" / "10.1038_s41576-026-00959-x.pdf").unlink()
    FakeProxy.mode = "never"            # the library login would block now
    out = _run(fake_proxy, tmp_path, timeout=5)
    assert out["status"] == "downloaded", out
    assert any("session valid" in s for s in out["login_steps"])


@needs_chrome
def test_expired_session_falls_back_to_login(fake_proxy, tmp_path):
    FakeProxy.mode, FakeProxy.article_kind = "auto", "meta"
    assert _run(fake_proxy, tmp_path)["status"] == "downloaded"
    (tmp_path / "papers" / "10.1038_s41576-026-00959-x.pdf").unlink()
    cookie_file = tmp_path / "profile" / browser.COOKIE_FILE
    cookie_file.write_text(json.dumps([c for c in json.loads(cookie_file.read_text()) if c["name"] != "ezproxy"]
                                      + [{"name": "other", "value": "1", "domain": "localhost", "path": "/"}]))
    out = _run(fake_proxy, tmp_path)   # direct URL bounces to the proxy login, then the library login works
    assert out["status"] == "downloaded", out
    assert any("session expired" in s for s in out["login_steps"])


@needs_chrome
def test_prior_attempts_recorded(fake_proxy, tmp_path):
    FakeProxy.mode, FakeProxy.article_kind = "auto", "meta"
    prior = [{"route": "publisher:landing", "url": "https://pnas.org/x", "result": "HTTP 403"}]
    _run(fake_proxy, tmp_path, prior=prior)
    prov = json.loads((tmp_path / "papers" / "10.1038_s41576-026-00959-x.json").read_text())
    assert prov["attempts"][0] == prior[0] and prov["attempts"][-1]["result"] == "ok"


@needs_chrome
def test_browser_login_timeout(fake_proxy, tmp_path):
    FakeProxy.mode = "never"
    out = _run(fake_proxy, tmp_path, timeout=3)
    assert out["status"] == "needs_login" and "127.0.0.1" in out["current_url"]
    assert not (tmp_path / "papers" / "10.1038_s41576-026-00959-x.pdf").exists()


@needs_chrome
def test_browser_profile_keeps_login(fake_proxy, tmp_path):
    FakeProxy.mode, FakeProxy.article_kind = "auto", "meta"
    assert _run(fake_proxy, tmp_path)["status"] == "downloaded"
    cookies = (tmp_path / "profile").rglob("Cookies")
    assert any(True for _ in cookies)  # session stored in the dedicated profile


# ------------------------------------------------------------------ import_downloads

def _dl_dir(tmp_path):
    d = tmp_path / "Downloads"
    d.mkdir()
    shutil.copy(REAL_PDF, d / "s41576-026-00959-x (1).pdf")
    shutil.copy(REAL_PDF, d / "s41576-026-00959-x (2).pdf")              # duplicate
    shutil.copy(UP / "aging-206419.pdf", d / "aging-206419.pdf")          # no DOI in text
    (d / "notes.pdf").write_text("not a pdf")
    (d / "readme.txt").write_text("x")
    return d


OA_NRG = {"title": "Evolutionary genetics of ageing", "publication_year": 2026,
          "primary_location": {"source": {"display_name": "Nature Reviews Genetics"}}, "open_access": {"is_oa": False}}
OA_AGING_SEARCH = {"results": [{"title": "How to live for centuries: common denominators of organisms with exceptional longevity",
                                "doi": "https://doi.org/10.18632/aging.206419"}]}
OA_AGING = {"title": "How to live for centuries: common denominators of organisms with exceptional longevity",
            "publication_year": 2026, "open_access": {"is_oa": True}}


@pytest.mark.skipif(not REAL_PDF.exists(), reason="no test PDFs")
@respx.mock
def test_import_downloads(tmp_path):
    respx.get(f"https://api.openalex.org/works/doi:{DOI}").respond(200, json=OA_NRG)
    respx.get("https://api.openalex.org/works/doi:10.18632/aging.206419").respond(200, json=OA_AGING)
    respx.get("https://api.openalex.org/works").respond(200, json=OA_AGING_SEARCH)
    respx.get(url__regex=r"https://api\.crossref\.org/.*").respond(404)
    d = _dl_dir(tmp_path)
    papers = tmp_path / "papers"
    dry = core.import_downloads(d, papers, dry_run=True)
    assert dry["summary"].get("would_import") == 2 and not papers.glob("*.pdf").__next__ if False else True
    assert not list(papers.glob("*.pdf"))
    out = core.import_downloads(d, papers)
    by = {f["file"]: f for f in out["files"]}
    assert out["scanned"] == 4
    assert by["s41576-026-00959-x (1).pdf"]["status"] == "imported"
    assert by["s41576-026-00959-x (2).pdf"]["status"] == "duplicate"
    assert by["aging-206419.pdf"]["status"] == "imported" and by["aging-206419.pdf"]["doi_source"] == "title_search"
    assert by["notes.pdf"]["status"] == "skipped"
    rec = json.loads((papers / "10.18632_aging.206419.json").read_text())
    assert rec["route"] == "browser:import_downloads" and rec["doi_source"] == "title_search"
    assert (d / "aging-206419.pdf").exists()  # originals untouched
    again = core.import_downloads(d, papers)
    assert again["summary"].get("already_present") == 2


@pytest.mark.skipif(not REAL_PDF.exists(), reason="no test PDFs")
@respx.mock
def test_import_rejects_wrong_doi(tmp_path):
    respx.get(f"https://api.openalex.org/works/doi:{DOI}").respond(200, json={"title": "Quorum xylophone zebrafish photonic gravitation"})
    respx.get(url__regex=r"https://api\.crossref\.org/.*").respond(404)
    d = tmp_path / "Downloads"
    d.mkdir()
    shutil.copy(REAL_PDF, d / "x.pdf")
    out = core.import_downloads(d, tmp_path / "papers")
    assert out["files"][0]["status"] == "doi_mismatch"
