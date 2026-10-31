"""Core logic for paper-fetcher. No MCP code here, so every function can be tested on its own.

Four operations:
  resolve_doi   DOI -> metadata, open-access status and candidate PDF URLs (OpenAlex, Crossref fallback)
  fetch_pdf     DOI -> PDF on disk, plus a JSON provenance record next to it
  zotero_lookup DOI / title words / collection -> items from a read-only copy of zotero.sqlite
  pdf_to_text   PDF path -> plain text (pdftotext if installed, otherwise pypdf)
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import html
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx

VERSION = "0.2.1"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36 paper-fetcher/" + VERSION
)
DOI_RE = re.compile(r"10\.\d{4,9}/\S+", re.IGNORECASE)


# --------------------------------------------------------------------------- helpers


def normalize_doi(raw: str) -> str:
    """Accept '10.x/y', 'doi:10.x/y' or 'https://doi.org/10.x/y'. Return lower-case bare DOI."""
    if not raw:
        raise ValueError("Empty DOI")
    m = DOI_RE.search(raw.strip())
    if not m:
        raise ValueError(f"Not a DOI: {raw!r}")
    return m.group(0).rstrip(".,;)").lower()


def doi_to_filename(doi: str) -> str:
    """10.1038/s41586-025-09694-5 -> 10.1038_s41586-025-09694-5 (safe on macOS/Windows)."""
    return re.sub(r"[^A-Za-z0-9._-]+", "_", doi)


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def is_pdf_file(path: Path) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(5) == b"%PDF-"
    except OSError:
        return False


def make_client(timeout: float = 30.0) -> httpx.Client:
    return httpx.Client(
        follow_redirects=True,
        timeout=timeout,
        headers={"User-Agent": USER_AGENT, "Accept": "*/*"},
    )


# --------------------------------------------------------------------------- resolve_doi


@dataclass
class Resolved:
    doi: str
    title: str | None = None
    year: int | None = None
    journal: str | None = None
    publisher: str | None = None
    authors: list[str] = field(default_factory=list)
    is_oa: bool | None = None
    oa_status: str | None = None
    landing_url: str | None = None
    pmcid: str | None = None
    pdf_candidates: list[dict[str, str]] = field(default_factory=list)
    metadata_source: str | None = None
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


def _add_candidate(res: Resolved, url: str | None, source: str) -> None:
    if url and not any(c["url"] == url for c in res.pdf_candidates):
        res.pdf_candidates.append({"url": url, "source": source})


def _from_openalex(res: Resolved, w: dict[str, Any]) -> None:
    res.metadata_source = "openalex"
    res.title = w.get("title") or w.get("display_name")
    res.year = w.get("publication_year")
    prim = w.get("primary_location") or {}
    src = prim.get("source") or {}
    res.journal = src.get("display_name")
    res.publisher = src.get("host_organization_name")
    res.landing_url = prim.get("landing_page_url") or res.landing_url
    res.authors = [
        (a.get("author") or {}).get("display_name")
        for a in (w.get("authorships") or [])
        if (a.get("author") or {}).get("display_name")
    ][:30]
    oa = w.get("open_access") or {}
    res.is_oa = oa.get("is_oa")
    res.oa_status = oa.get("oa_status")
    pmcid = (w.get("ids") or {}).get("pmcid")
    if pmcid:
        last = pmcid.rstrip("/").split("/")[-1]
        res.pmcid = last if last.upper().startswith("PMC") else f"PMC{last}"
    best = w.get("best_oa_location") or {}
    _add_candidate(res, best.get("pdf_url"), "openalex:best_oa_location")
    for loc in w.get("locations") or []:
        if loc.get("is_oa"):
            _add_candidate(res, loc.get("pdf_url"), "openalex:oa_location")
    _add_candidate(res, oa.get("oa_url") if (oa.get("oa_url") or "").lower().endswith(".pdf") else None, "openalex:oa_url")


def _from_crossref(res: Resolved, m: dict[str, Any]) -> None:
    res.metadata_source = res.metadata_source or "crossref"
    if not res.title:
        t = m.get("title") or []
        res.title = t[0] if t else None
    if not res.journal:
        c = m.get("container-title") or []
        res.journal = c[0] if c else None
    res.publisher = res.publisher or m.get("publisher")
    if not res.year:
        parts = ((m.get("issued") or {}).get("date-parts") or [[None]])[0]
        res.year = parts[0] if parts else None
    if not res.authors:
        res.authors = [
            " ".join(x for x in (a.get("given"), a.get("family")) if x)
            for a in (m.get("author") or [])
        ][:30]
    for link in m.get("link") or []:
        if (link.get("content-type") or "").lower() == "application/pdf":
            _add_candidate(res, link.get("URL"), "crossref:link")


def resolve_doi(raw_doi: str, client: httpx.Client | None = None, openalex_api_key: str | None = None) -> Resolved:
    doi = normalize_doi(raw_doi)
    res = Resolved(doi=doi, landing_url=f"https://doi.org/{doi}")
    own = client is None
    client = client or make_client()
    try:
        params = {"api_key": openalex_api_key} if openalex_api_key else None
        try:
            r = client.get(f"https://api.openalex.org/works/doi:{doi}", params=params)
            if r.status_code == 200:
                _from_openalex(res, r.json())
            else:
                res.errors.append(f"openalex HTTP {r.status_code}")
        except httpx.HTTPError as e:
            res.errors.append(f"openalex: {type(e).__name__}: {e}")
        try:
            r = client.get(f"https://api.crossref.org/works/{doi}")
            if r.status_code == 200:
                _from_crossref(res, r.json().get("message") or {})
            else:
                res.errors.append(f"crossref HTTP {r.status_code}")
        except httpx.HTTPError as e:
            res.errors.append(f"crossref: {type(e).__name__}: {e}")
        if res.pmcid:
            _add_candidate(
                res,
                f"https://europepmc.org/backend/ptpmcrender.fcgi?accid={res.pmcid}&blobtype=pdf",
                "europepmc",
            )
    finally:
        if own:
            client.close()
    return res


# --------------------------------------------------------------------------- fetch_pdf

_META_PDF_RE = re.compile(
    r"<meta[^>]+name=[\"']citation_pdf_url[\"'][^>]*content=[\"']([^\"']+)[\"']"
    r"|<meta[^>]+content=[\"']([^\"']+)[\"'][^>]*name=[\"']citation_pdf_url[\"']",
    re.IGNORECASE,
)


def find_citation_pdf_url(page_html: str, base_url: str) -> str | None:
    m = _META_PDF_RE.search(page_html)
    if not m:
        return None
    return urljoin(base_url, html.unescape(m.group(1) or m.group(2)))


def _download_pdf(client: httpx.Client, url: str, dest: Path) -> tuple[bool, str]:
    """Stream url to dest. Keep it only if it really is a PDF. Return (ok, note)."""
    tmp = dest.with_suffix(".part")
    try:
        with client.stream("GET", url, headers={"Accept": "application/pdf,*/*"}) as r:
            if r.status_code != 200:
                return False, f"HTTP {r.status_code}"
            with open(tmp, "wb") as f:
                for chunk in r.iter_bytes():
                    f.write(chunk)
            final_url = str(r.url)
        if not is_pdf_file(tmp):
            tmp.unlink(missing_ok=True)
            return False, "response was not a PDF (probably a login or landing page)"
        tmp.replace(dest)
        return True, final_url
    except httpx.HTTPError as e:
        tmp.unlink(missing_ok=True)
        return False, f"{type(e).__name__}: {e}"


def fetch_pdf(
    raw_doi: str,
    download_dir: str | Path,
    client: httpx.Client | None = None,
    openalex_api_key: str | None = None,
    overwrite: bool = False,
) -> dict[str, Any]:
    """Get the PDF for a DOI. Order: open-access URLs, then the publisher landing page
    (citation_pdf_url meta tag). On VPN or campus the publisher route also covers
    subscription papers. If nothing works, status is 'needs_browser' with the landing URL."""
    doi = normalize_doi(raw_doi)
    out_dir = Path(os.path.expanduser(str(download_dir)))
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = doi_to_filename(doi)
    pdf_path = out_dir / f"{stem}.pdf"
    prov_path = out_dir / f"{stem}.json"

    if pdf_path.exists() and is_pdf_file(pdf_path) and not overwrite:
        prov = json.loads(prov_path.read_text()) if prov_path.exists() else {}
        return {
            "status": "already_present",
            "doi": doi,
            "path": str(pdf_path),
            "sha256": _sha256(pdf_path),
            "bytes": pdf_path.stat().st_size,
            "route": prov.get("route"),
            "source_url": prov.get("source_url"),
        }

    own = client is None
    client = client or make_client(timeout=60.0)
    attempts: list[dict[str, str]] = []
    try:
        res = resolve_doi(doi, client=client, openalex_api_key=openalex_api_key)

        def try_url(url: str, route: str) -> dict[str, Any] | None:
            ok, note = _download_pdf(client, url, pdf_path)
            attempts.append({"route": route, "url": url, "result": "ok" if ok else note})
            if not ok:
                return None
            record = {
                "doi": doi,
                "title": res.title,
                "year": res.year,
                "journal": res.journal,
                "authors": res.authors,
                "is_oa": res.is_oa,
                "oa_status": res.oa_status,
                "route": route,
                "source_url": url,
                "final_url": note,
                "path": str(pdf_path),
                "sha256": _sha256(pdf_path),
                "bytes": pdf_path.stat().st_size,
                "retrieved_at": _now(),
                "tool": f"paper-fetcher {VERSION}",
                "attempts": attempts,
            }
            prov_path.write_text(json.dumps(record, indent=2))
            return {"status": "downloaded", **{k: record[k] for k in (
                "doi", "title", "route", "source_url", "path", "sha256", "bytes", "is_oa", "oa_status")}}

        # 1. open-access candidates
        for cand in res.pdf_candidates:
            out = try_url(cand["url"], f"open_access:{cand['source']}")
            if out:
                return out

        # 2. publisher landing page -> citation_pdf_url (works for subscriptions on VPN/campus)
        landing = res.landing_url or f"https://doi.org/{doi}"
        try:
            r = client.get(landing, headers={"Accept": "text/html,application/xhtml+xml"})
            page_url = str(r.url)
            ctype = r.headers.get("content-type", "")
            if r.status_code == 200 and "pdf" in ctype.lower():
                out = try_url(page_url, "publisher:direct")
                if out:
                    return out
            elif r.status_code == 200:
                pdf_url = find_citation_pdf_url(r.text, page_url)
                if pdf_url:
                    out = try_url(pdf_url, "publisher:citation_pdf_url")
                    if out:
                        return out
                else:
                    attempts.append({"route": "publisher:landing", "url": page_url, "result": "no citation_pdf_url meta tag"})
            else:
                attempts.append({"route": "publisher:landing", "url": page_url, "result": f"HTTP {r.status_code}"})
            landing = page_url
        except httpx.HTTPError as e:
            attempts.append({"route": "publisher:landing", "url": landing, "result": f"{type(e).__name__}: {e}"})

        return {
            "status": "needs_browser",
            "doi": doi,
            "title": res.title,
            "is_oa": res.is_oa,
            "landing_url": landing,
            "message": "No PDF could be fetched automatically. Open landing_url in the browser and use "
                       "'Access through your institution', or retry on WUR VPN.",
            "attempts": attempts,
            "resolve_errors": res.errors,
        }
    finally:
        if own:
            client.close()


# --------------------------------------------------------------------------- zotero_lookup


def _copy_db(zotero_dir: Path) -> Path:
    src = zotero_dir / "zotero.sqlite"
    if not src.exists():
        raise FileNotFoundError(f"No zotero.sqlite in {zotero_dir}")
    tmpdir = Path(tempfile.mkdtemp(prefix="paper-fetcher-z-"))
    dst = tmpdir / "zotero.sqlite"
    shutil.copy2(src, dst)
    return dst


def zotero_lookup(
    zotero_dir: str | Path,
    doi: str | None = None,
    query: str | None = None,
    collection: str | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    """Search a temporary copy of zotero.sqlite. Never touches the live database.
    doi: exact DOI match. query: all words must appear in the title (whole-word match).
    collection: restrict to a collection name (case-insensitive)."""
    if not (doi or query or collection):
        raise ValueError("Give at least one of doi, query or collection")
    zdir = Path(os.path.expanduser(str(zotero_dir)))
    db = _copy_db(zdir)
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row

        def field_rows(name: str) -> dict[int, str]:
            rows = con.execute(
                """select d.itemID, v.value from itemData d
                   join fields f on f.fieldID = d.fieldID and f.fieldName = ?
                   join itemDataValues v on v.valueID = d.valueID""",
                (name,),
            )
            return {r[0]: r[1] for r in rows}

        regular = {
            r[0]: (r[1], r[2])
            for r in con.execute(
                """select i.itemID, i.key, t.typeName from items i join itemTypes t using(itemTypeID)
                   where t.typeName not in ('attachment','note','annotation')
                   and i.itemID not in (select itemID from deletedItems)"""
            )
        }
        titles = field_rows("title")
        dois = field_rows("DOI")
        dates = field_rows("date")
        pubs = field_rows("publicationTitle")

        cand = set(regular)
        if doi:
            nd = normalize_doi(doi)
            cand &= {i for i, v in dois.items() if v and v.strip().lower() == nd}
        if query:
            words = [w for w in re.findall(r"\w+", query.lower()) if w]
            pats = [re.compile(rf"\b{re.escape(w)}", re.IGNORECASE) for w in words]
            cand &= {i for i in cand if i in titles and all(p.search(titles[i]) for p in pats)}
        coll_names: dict[int, list[str]] = {}
        for r in con.execute(
            "select ci.itemID, c.collectionName from collectionItems ci join collections c using(collectionID)"
        ):
            coll_names.setdefault(r[0], []).append(r[1])
        if collection:
            cl = collection.lower()
            cand &= {i for i in cand if any(c.lower() == cl for c in coll_names.get(i, []))}

        storage = zdir / "storage"
        results = []
        for item_id in sorted(cand, key=lambda i: titles.get(i, ""))[: max(1, limit)]:
            key, typ = regular[item_id]
            creators = [
                " ".join(x for x in (r["firstName"], r["lastName"]) if x)
                for r in con.execute(
                    """select c.firstName, c.lastName from itemCreators ic join creators c using(creatorID)
                       where ic.itemID = ? order by ic.orderIndex""",
                    (item_id,),
                )
            ]
            atts = []
            for a in con.execute(
                """select i.key, a.contentType, a.path from itemAttachments a join items i on i.itemID = a.itemID
                   where a.parentItemID = ?""",
                (item_id,),
            ):
                p = a["path"]
                full = None
                if p and p.startswith("storage:"):
                    full = storage / a["key"] / p[len("storage:"):]
                elif p:
                    full = Path(p)
                atts.append({
                    "key": a["key"],
                    "content_type": a["contentType"],
                    "path": str(full) if full else None,
                    "exists": bool(full and full.exists()),
                })
            results.append({
                "item_key": key,
                "type": typ,
                "title": titles.get(item_id),
                "doi": dois.get(item_id),
                "date": dates.get(item_id),
                "publication": pubs.get(item_id),
                "creators": creators[:10],
                "collections": coll_names.get(item_id, []),
                "attachments": atts,
                "has_pdf": any(x["content_type"] == "application/pdf" and x["exists"] for x in atts),
            })
        con.close()
        return {"count": len(cand), "returned": len(results), "items": results}
    finally:
        shutil.rmtree(db.parent, ignore_errors=True)


# --------------------------------------------------------------------------- pdf_to_text


def _clean(text: str) -> str:
    lines = [ln.rstrip() for ln in text.splitlines()]
    lines = [ln for ln in lines if ln.strip() and not re.fullmatch(r"\s*[\d.]+\s*", ln)]
    return "\n".join(lines)


def pdf_to_text(path: str | Path, max_chars: int = 50000, offset: int = 0, save_txt: bool = True) -> dict[str, Any]:
    p = Path(os.path.expanduser(str(path)))
    if p.suffix.lower() != ".pdf" or not p.exists():
        raise FileNotFoundError(f"Not an existing .pdf file: {p}")
    if not is_pdf_file(p):
        raise ValueError(f"File does not start with %PDF-: {p}")
    engine = None
    text = ""
    if shutil.which("pdftotext"):
        r = subprocess.run(["pdftotext", str(p), "-"], capture_output=True, text=True, timeout=120)
        if r.returncode == 0 and r.stdout.strip():
            text, engine = r.stdout, "pdftotext"
    if not engine:
        from pypdf import PdfReader

        reader = PdfReader(str(p))
        text = "\n".join((pg.extract_text() or "") for pg in reader.pages)
        engine = "pypdf"
    text = _clean(text)
    txt_path = None
    if save_txt:
        txt_path = p.with_suffix(".txt")
        txt_path.write_text(text)
    chunk = text[offset: offset + max_chars]
    return {
        "path": str(p),
        "engine": engine,
        "total_chars": len(text),
        "offset": offset,
        "returned_chars": len(chunk),
        "next_offset": offset + len(chunk) if offset + len(chunk) < len(text) else None,
        "txt_path": str(txt_path) if txt_path else None,
        "text": chunk,
    }


# --------------------------------------------------------------------------- import_downloads


def _title_overlap(title: str | None, text: str) -> float | None:
    if not title:
        return None
    words = {w for w in re.findall(r"[a-z0-9]{4,}", title.lower())}
    if not words:
        return None
    low = text.lower()
    return sum(1 for w in words if w in low) / len(words)


def guess_doi(text: str) -> str | None:
    """Pick the paper's own DOI from its first pages: the most frequent DOI, earliest on a tie.
    Reference-list DOIs appear once each and later, so they rarely win."""
    found = [normalize_doi(m.group(0)) for m in DOI_RE.finditer(text)]
    # strip trailing punctuation / bits glued on by text extraction
    found = [re.sub(r"[).,;:\]]+$", "", d) for d in found]
    if not found:
        return None
    counts: dict[str, int] = {}
    for d in found:
        counts[d] = counts.get(d, 0) + 1
    best = max(counts.values())
    return next(d for d in found if counts[d] == best)


def pdf_meta_title(path: Path) -> str | None:
    try:
        from pypdf import PdfReader

        t = (PdfReader(str(path)).metadata or {}).get("/Title")
        t = str(t).strip() if t else None
        return t if t and len(t) > 15 else None
    except Exception:  # noqa: BLE001
        return None


def doi_from_title(title: str, client: httpx.Client, openalex_api_key: str | None = None) -> str | None:
    """Search OpenAlex by title; accept only a near-exact title match."""
    params: dict[str, Any] = {"search": title, "per_page": 3}
    if openalex_api_key:
        params["api_key"] = openalex_api_key
    try:
        r = client.get("https://api.openalex.org/works", params=params)
        if r.status_code != 200:
            return None
        for w in r.json().get("results") or []:
            cand = w.get("title") or ""
            ov_a = _title_overlap(title, cand) or 0
            ov_b = _title_overlap(cand, title) or 0
            if min(ov_a, ov_b) >= 0.9 and w.get("doi"):
                return normalize_doi(w["doi"])
    except (httpx.HTTPError, ValueError):
        return None
    return None


def import_downloads(
    downloads_dir: str | Path,
    papers_dir: str | Path,
    since_hours: float = 48,
    dry_run: bool = False,
    verify_online: bool = True,
    client: httpx.Client | None = None,
    openalex_api_key: str | None = None,
) -> dict[str, Any]:
    """Find PDFs in downloads_dir changed in the last since_hours, read the DOI from the first two
    pages, and copy each to papers_dir as <doi>.pdf with a provenance record (route browser:import).
    Originals are left in place. Same-content duplicates are reported, not copied twice."""
    src_dir = Path(os.path.expanduser(str(downloads_dir)))
    dst_dir = Path(os.path.expanduser(str(papers_dir)))
    dst_dir.mkdir(parents=True, exist_ok=True)
    cutoff = _dt.datetime.now().timestamp() - since_hours * 3600
    pdfs = sorted(
        (p for p in src_dir.iterdir() if p.is_file() and p.suffix.lower() == ".pdf" and p.stat().st_mtime >= cutoff),
        key=lambda p: p.stat().st_mtime,
    )
    own = client is None and verify_online
    if verify_online and client is None:
        client = make_client()
    results: list[dict[str, Any]] = []
    seen_hash: dict[str, str] = {}
    try:
        for p in pdfs:
            row: dict[str, Any] = {"file": p.name}
            if not is_pdf_file(p):
                results.append({**row, "status": "skipped", "reason": "not a real PDF"})
                continue
            h = _sha256(p)
            if h in seen_hash:
                results.append({**row, "status": "duplicate", "same_as": seen_hash[h]})
                continue
            seen_hash[h] = p.name
            try:
                text = pdf_to_text(p, max_chars=40000, save_txt=False)["text"]
            except Exception as e:  # noqa: BLE001
                results.append({**row, "status": "skipped", "reason": f"text extraction failed: {e}"})
                continue
            first = text[:15000]
            doi = guess_doi(first)
            row["doi_source"] = "pdf_text"
            if not doi and verify_online and client is not None:
                mt = pdf_meta_title(p)
                if mt:
                    doi = doi_from_title(mt, client, openalex_api_key)
                    row["doi_source"] = "title_search"
            if not doi:
                results.append({**row, "status": "no_doi",
                                "reason": "no DOI on the first pages and no confident title match"})
                continue
            row["doi"] = doi
            res = None
            overlap = None
            if verify_online:
                res = resolve_doi(doi, client=client, openalex_api_key=openalex_api_key)
                overlap = _title_overlap(res.title, first)
                row["title"] = res.title
                row["title_match"] = None if overlap is None else round(overlap, 2)
                if overlap is not None and overlap < 0.6:
                    results.append({**row, "status": "doi_mismatch",
                                    "reason": "the DOI found does not match this PDF's title; check by hand"})
                    continue
            stem = doi_to_filename(doi)
            target = dst_dir / f"{stem}.pdf"
            if target.exists():
                same = _sha256(target) == h
                results.append({**row, "status": "already_present" if same else "conflict",
                                "path": str(target),
                                **({} if same else {"reason": "a different file with this DOI is already in papers"})})
                continue
            if dry_run:
                results.append({**row, "status": "would_import", "path": str(target)})
                continue
            shutil.copy2(p, target)
            record = {
                "doi": doi,
                "title": res.title if res else None,
                "year": res.year if res else None,
                "journal": res.journal if res else None,
                "authors": res.authors if res else None,
                "is_oa": res.is_oa if res else None,
                "route": "browser:import_downloads",
                "original_filename": p.name,
                "original_mtime": _dt.datetime.fromtimestamp(p.stat().st_mtime, _dt.timezone.utc).isoformat(timespec="seconds"),
                "path": str(target),
                "sha256": h,
                "bytes": target.stat().st_size,
                "doi_source": row["doi_source"],
                "doi_found_in_text": doi in first.lower(),
                "title_match": None if overlap is None else round(overlap, 2),
                "recorded_at": _now(),
                "tool": f"paper-fetcher {VERSION}",
            }
            (dst_dir / f"{stem}.json").write_text(json.dumps(record, indent=2))
            results.append({**row, "status": "imported", "path": str(target)})
    finally:
        if own and client is not None:
            client.close()
    summary: dict[str, int] = {}
    for r in results:
        summary[r["status"]] = summary.get(r["status"], 0) + 1
    return {"scanned": len(pdfs), "summary": summary, "files": results}
