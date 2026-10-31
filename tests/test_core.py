"""Tests for paper_fetcher.core. Network is mocked with respx; Zotero is a small fake database."""

import json
import sqlite3
import sys
from pathlib import Path

import httpx
import pytest
import respx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from paper_fetcher import core  # noqa: E402

DOI = "10.1038/s41586-025-09694-5"
FAKE_PDF = b"%PDF-1.7\n% fake test pdf\n%%EOF\n"
UPLOADS = Path("/mnt/user-data/uploads")


# ------------------------------------------------------------------ helpers

def test_normalize_doi_variants():
    for raw in (DOI, f"doi:{DOI}", f"https://doi.org/{DOI}", f" {DOI.upper()}. "):
        assert core.normalize_doi(raw) == DOI
    with pytest.raises(ValueError):
        core.normalize_doi("not a doi")


def test_filename():
    assert core.doi_to_filename(DOI) == "10.1038_s41586-025-09694-5"


def test_citation_pdf_meta_both_orders():
    a = '<meta name="citation_pdf_url" content="/articles/x.pdf">'
    b = "<meta content='https://p.org/y.pdf' name='citation_pdf_url'/>"
    assert core.find_citation_pdf_url(a, "https://www.nature.com/articles/x") == "https://www.nature.com/articles/x.pdf"
    assert core.find_citation_pdf_url(b, "https://p.org/") == "https://p.org/y.pdf"
    assert core.find_citation_pdf_url("<html></html>", "https://p.org/") is None


# ------------------------------------------------------------------ resolve / fetch

OPENALEX = {
    "title": "Evidence for improved DNA repair in the long-lived bowhead whale",
    "publication_year": 2025,
    "primary_location": {"landing_page_url": f"https://www.nature.com/articles/s41586-025-09694-5",
                         "source": {"display_name": "Nature", "host_organization_name": "Springer Nature"}},
    "authorships": [{"author": {"display_name": "Denis Firsanov"}}],
    "open_access": {"is_oa": True, "oa_status": "hybrid", "oa_url": "https://www.nature.com/articles/s41586-025-09694-5"},
    "best_oa_location": {"pdf_url": "https://www.nature.com/articles/s41586-025-09694-5.pdf"},
    "locations": [],
    "ids": {"pmcid": "https://www.ncbi.nlm.nih.gov/pmc/articles/123456"},
}


@respx.mock
def test_resolve_doi_openalex_and_crossref():
    respx.get(f"https://api.openalex.org/works/doi:{DOI}").respond(200, json=OPENALEX)
    respx.get(f"https://api.crossref.org/works/{DOI}").respond(200, json={"message": {"publisher": "SN"}})
    r = core.resolve_doi(f"https://doi.org/{DOI}")
    assert r.title.startswith("Evidence")
    assert r.is_oa is True and r.journal == "Nature" and r.pmcid == "PMC123456"
    urls = [c["url"] for c in r.pdf_candidates]
    assert urls[0].endswith(".pdf")
    assert any("europepmc" in u for u in urls)


@respx.mock
def test_fetch_pdf_open_access(tmp_path):
    respx.get(f"https://api.openalex.org/works/doi:{DOI}").respond(200, json=OPENALEX)
    respx.get(f"https://api.crossref.org/works/{DOI}").respond(404)
    respx.get("https://www.nature.com/articles/s41586-025-09694-5.pdf").respond(
        200, content=FAKE_PDF, headers={"content-type": "application/pdf"})
    out = core.fetch_pdf(DOI, tmp_path)
    assert out["status"] == "downloaded"
    assert out["route"] == "open_access:openalex:best_oa_location"
    pdf = tmp_path / "10.1038_s41586-025-09694-5.pdf"
    prov = json.loads((tmp_path / "10.1038_s41586-025-09694-5.json").read_text())
    assert pdf.read_bytes() == FAKE_PDF
    assert prov["sha256"] == out["sha256"] and prov["attempts"][0]["result"] == "ok"
    # second call is idempotent
    again = core.fetch_pdf(DOI, tmp_path)
    assert again["status"] == "already_present" and again["route"] == out["route"]


@respx.mock
def test_fetch_pdf_falls_back_to_publisher_meta(tmp_path):
    oa = dict(OPENALEX, best_oa_location={}, open_access={"is_oa": False}, ids={})
    respx.get(f"https://api.openalex.org/works/doi:{DOI}").respond(200, json=oa)
    respx.get(f"https://api.crossref.org/works/{DOI}").respond(404)
    respx.get("https://www.nature.com/articles/s41586-025-09694-5").respond(
        200, text='<html><meta name="citation_pdf_url" content="/articles/s41586-025-09694-5.pdf"></html>',
        headers={"content-type": "text/html"})
    respx.get("https://www.nature.com/articles/s41586-025-09694-5.pdf").respond(200, content=FAKE_PDF)
    out = core.fetch_pdf(DOI, tmp_path)
    assert out["status"] == "downloaded" and out["route"] == "publisher:citation_pdf_url"


@respx.mock
def test_fetch_pdf_login_page_gives_needs_browser(tmp_path):
    oa = dict(OPENALEX, best_oa_location={"pdf_url": "https://pub.org/a.pdf"}, ids={})
    respx.get(f"https://api.openalex.org/works/doi:{DOI}").respond(200, json=oa)
    respx.get(f"https://api.crossref.org/works/{DOI}").respond(404)
    # "PDF" URL returns an HTML login page, landing page is forbidden
    respx.get("https://pub.org/a.pdf").respond(200, text="<html>Please log in</html>")
    respx.get("https://www.nature.com/articles/s41586-025-09694-5").respond(403)
    out = core.fetch_pdf(DOI, tmp_path)
    assert out["status"] == "needs_browser"
    assert "not a PDF" in out["attempts"][0]["result"]
    assert not list(tmp_path.glob("*.pdf")) and not list(tmp_path.glob("*.part"))


@respx.mock
def test_fetch_pdf_network_errors_dont_crash(tmp_path):
    respx.get(url__regex=r".*").mock(side_effect=httpx.ConnectError("blocked"))
    out = core.fetch_pdf(DOI, tmp_path)
    assert out["status"] == "needs_browser"
    assert any("ConnectError" in e for e in out["resolve_errors"])


# ------------------------------------------------------------------ zotero

def _make_zotero(d: Path) -> Path:
    con = sqlite3.connect(d / "zotero.sqlite")
    con.executescript("""
    create table itemTypes(itemTypeID integer primary key, typeName text);
    create table items(itemID integer primary key, itemTypeID int, key text, dateAdded text);
    create table fields(fieldID integer primary key, fieldName text);
    create table itemDataValues(valueID integer primary key, value text);
    create table itemData(itemID int, fieldID int, valueID int);
    create table itemAttachments(itemID int, parentItemID int, contentType text, path text);
    create table collections(collectionID integer primary key, collectionName text);
    create table collectionItems(collectionID int, itemID int);
    create table creators(creatorID integer primary key, firstName text, lastName text);
    create table itemCreators(itemID int, creatorID int, orderIndex int);
    create table deletedItems(itemID int);
    insert into itemTypes values (1,'journalArticle'),(2,'attachment');
    insert into items values (1,1,'AAAA1111','2021'),(2,2,'BBBB2222','2021'),(3,1,'CCCC3333','2022'),(4,1,'DDDD4444','2023');
    insert into fields values (1,'title'),(2,'DOI'),(3,'date'),(4,'publicationTitle');
    insert into itemDataValues values
      (1,'Naked Mole Rat Cells Have a Stable Epigenome that Resists iPSC Reprogramming'),
      (2,'10.1016/j.stemcr.2017.09.007'),
      (3,'Quantitative imaging of mitochondria'),
      (4,'Deleted aging paper');
    insert into itemData values (1,1,1),(1,2,2),(3,1,3),(4,1,4);
    insert into itemAttachments values (2,1,'application/pdf','storage:Tan 2017.pdf');
    insert into collections values (1,'lecture2');
    insert into collectionItems values (1,1);
    insert into creators values (1,'Li','Tan');
    insert into itemCreators values (1,1,0);
    insert into deletedItems values (4);
    """)
    con.commit()
    con.close()
    (d / "storage" / "BBBB2222").mkdir(parents=True)
    (d / "storage" / "BBBB2222" / "Tan 2017.pdf").write_bytes(FAKE_PDF)
    return d


def test_zotero_by_doi_query_collection(tmp_path):
    z = _make_zotero(tmp_path)
    before = (z / "zotero.sqlite").read_bytes()
    r = core.zotero_lookup(z, doi="https://doi.org/10.1016/J.STEMCR.2017.09.007")
    assert r["count"] == 1 and r["items"][0]["has_pdf"] is True
    assert r["items"][0]["creators"] == ["Li Tan"]
    assert r["items"][0]["attachments"][0]["path"].endswith("storage/BBBB2222/Tan 2017.pdf")
    assert core.zotero_lookup(z, query="mole rat epigenome")["count"] == 1
    assert core.zotero_lookup(z, collection="LECTURE2")["count"] == 1
    # whole-word start match: 'aging' must not match 'imaging'; deleted items are excluded
    assert core.zotero_lookup(z, query="aging")["count"] == 0
    assert (z / "zotero.sqlite").read_bytes() == before  # live db untouched
    with pytest.raises(ValueError):
        core.zotero_lookup(z)


# ------------------------------------------------------------------ pdf_to_text

def _real_pdf() -> Path | None:
    for name in ("s41576-026-00959-x.pdf", "aging-206419.pdf"):
        if (UPLOADS / name).exists():
            return UPLOADS / name
    return None


def test_pdf_to_text_real_paper(tmp_path):
    src = _real_pdf()
    if not src:
        pytest.skip("no real PDF available")
    p = tmp_path / "paper.pdf"
    p.write_bytes(src.read_bytes())
    r = core.pdf_to_text(p, max_chars=2000)
    assert r["total_chars"] > 10000 and r["returned_chars"] == 2000 and r["next_offset"] == 2000
    assert Path(r["txt_path"]).exists()
    r2 = core.pdf_to_text(p, max_chars=2000, offset=r["next_offset"])
    assert r2["offset"] == 2000


def test_pdf_to_text_pypdf_fallback(tmp_path, monkeypatch):
    src = _real_pdf()
    if not src:
        pytest.skip("no real PDF available")
    p = tmp_path / "paper.pdf"
    p.write_bytes(src.read_bytes())
    monkeypatch.setattr(core.shutil, "which", lambda _: None)
    r = core.pdf_to_text(p, max_chars=500, save_txt=False)
    assert r["engine"] == "pypdf" and r["total_chars"] > 10000


def test_pdf_to_text_rejects_non_pdf(tmp_path):
    f = tmp_path / "x.pdf"
    f.write_text("hello")
    with pytest.raises(ValueError):
        core.pdf_to_text(f)
