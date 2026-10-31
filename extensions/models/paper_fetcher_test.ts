// Tests for @vcjdeboer/paper-fetcher. The network is replaced by a fake fetch;
// Zotero is a small fake database; PDFs are generated on the fly.

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261027.64";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { model } from "./paper_fetcher.ts";
import { fetchPdf } from "./paper_fetcher/fetch.ts";
import { importDownloads } from "./paper_fetcher/import_downloads.ts";
import { pdfToText } from "./paper_fetcher/pdftext.ts";
import { resolveDoi } from "./paper_fetcher/resolve.ts";
import {
  doiToFilename,
  findCitationPdfUrl,
  guessDoi,
  HttpClient,
  normalizeDoi,
} from "./paper_fetcher/util.ts";
import { zoteroLookup } from "./paper_fetcher/zotero.ts";
import {
  bytes,
  FAKE_PDF,
  fakeFetch,
  html,
  json,
  makePdf,
  makeZotero,
} from "./paper_fetcher/fixtures_test.ts";

const DOI = "10.1038/s41586-025-09694-5";
const OA_URL = `https://api.openalex.org/works/doi:${DOI}`;
const CR_URL = `https://api.crossref.org/works/${DOI}`;
const LANDING = "https://www.nature.com/articles/s41586-025-09694-5";
const OPENALEX = {
  title: "Evidence for improved DNA repair in the long-lived bowhead whale",
  publication_year: 2025,
  primary_location: {
    landing_page_url: LANDING,
    source: { display_name: "Nature", host_organization_name: "Springer Nature" },
  },
  authorships: [{ author: { display_name: "Denis Firsanov" } }],
  open_access: { is_oa: true, oa_status: "hybrid", oa_url: LANDING },
  best_oa_location: { pdf_url: `${LANDING}.pdf` },
  locations: [],
  ids: { pmcid: "https://www.ncbi.nlm.nih.gov/pmc/articles/123456" },
};

function client(f: ReturnType<typeof fakeFetch>): HttpClient {
  return new HttpClient({ fetchFn: f });
}

async function tmp(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "pf-test-" });
}

async function listDir(d: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(d)) out.push(e.name);
  return out.sort();
}

// ------------------------------------------------------------------ helpers

Deno.test("normalizeDoi accepts common forms and rejects non-DOIs", () => {
  for (const raw of [DOI, `doi:${DOI}`, `https://doi.org/${DOI}`, ` ${DOI.toUpperCase()}. `]) {
    assertEquals(normalizeDoi(raw), DOI);
  }
  assertThrows(() => normalizeDoi("not a doi"));
  assertThrows(() => normalizeDoi(""));
});

Deno.test("doiToFilename makes a safe file stem", () => {
  assertEquals(doiToFilename(DOI), "10.1038_s41586-025-09694-5");
  assertEquals(doiToFilename("10.1002/(sici)1097:x<y>"), "10.1002_sici_1097_x_y_");
});

Deno.test("citation_pdf_url is found in either attribute order", () => {
  const a = '<meta name="citation_pdf_url" content="/articles/x.pdf">';
  const b = "<meta content='https://p.org/y.pdf?a=1&amp;b=2' name='citation_pdf_url'/>";
  assertEquals(findCitationPdfUrl(a, "https://www.nature.com/articles/x"), "https://www.nature.com/articles/x.pdf");
  assertEquals(findCitationPdfUrl(b, "https://p.org/"), "https://p.org/y.pdf?a=1&b=2");
  assertEquals(findCitationPdfUrl("<html></html>", "https://p.org/"), null);
});

Deno.test("guessDoi prefers the paper's own (most frequent, earliest) DOI", () => {
  const text = `Journal X https://doi.org/10.1234/own.5 ... doi:10.1234/OWN.5.
  References: 10.9999/other.1; 10.8888/other.2`;
  assertEquals(guessDoi(text), "10.1234/own.5");
  assertEquals(guessDoi("no identifiers here"), null);
});

// ------------------------------------------------------------------ resolve

Deno.test("resolve merges OpenAlex and Crossref and adds Europe PMC", async () => {
  const f = fakeFetch({
    [OA_URL]: json(OPENALEX),
    [CR_URL]: json({ message: { publisher: "SN", link: [{ URL: "https://x.org/c.pdf", "content-type": "application/pdf" }] } }),
  });
  const w = await resolveDoi(`https://doi.org/${DOI}`, client(f));
  assert(w.title?.startsWith("Evidence"));
  assertEquals([w.is_oa, w.journal, w.pmcid, w.year], [true, "Nature", "PMC123456", 2025]);
  const urls = w.pdf_candidates.map((c) => c.url);
  assertEquals(urls[0], `${LANDING}.pdf`);
  assert(urls.includes("https://x.org/c.pdf"));
  assert(urls.some((u) => u.includes("europepmc")));
  assertEquals(w.errors, []);
});

Deno.test("resolve falls back to Crossref metadata when OpenAlex has nothing", async () => {
  const f = fakeFetch({
    [CR_URL]: json({
      message: {
        title: ["A Crossref title"],
        "container-title": ["J"],
        issued: { "date-parts": [[2019, 3]] },
        author: [{ given: "Ann", family: "Lee" }],
      },
    }),
  });
  const w = await resolveDoi(DOI, client(f));
  assertEquals([w.title, w.year, w.authors, w.metadata_source], ["A Crossref title", 2019, ["Ann Lee"], "crossref"]);
  assertEquals(w.errors, ["openalex HTTP 404"]);
});

Deno.test("OpenAlex API key is sent as api_key", async () => {
  const f = fakeFetch({ [`${OA_URL}?api_key=k%26y`]: json(OPENALEX) });
  const w = await resolveDoi(DOI, client(f), "k&y");
  assertEquals(w.metadata_source, "openalex");
});

// ------------------------------------------------------------------ fetch

Deno.test("fetch downloads an open-access PDF, writes provenance, and is idempotent", async () => {
  const dir = await tmp();
  const f = fakeFetch({ [OA_URL]: json(OPENALEX), [`${LANDING}.pdf`]: bytes(FAKE_PDF) });
  const out = await fetchPdf(DOI, dir, client(f));
  assertEquals(out.status, "downloaded");
  assertEquals(out.route, "open_access:openalex:best_oa_location");
  const stem = "10.1038_s41586-025-09694-5";
  assertEquals(await Deno.readFile(join(dir, `${stem}.pdf`)), FAKE_PDF);
  const prov = JSON.parse(await Deno.readTextFile(join(dir, `${stem}.json`)));
  assertEquals(prov.sha256, out.sha256);
  assertEquals(prov.attempts[0].result, "ok");
  assertEquals(prov.title, OPENALEX.title);
  const again = await fetchPdf(DOI, dir, client(fakeFetch({})));
  assertEquals([again.status, again.route, again.sha256], ["already_present", out.route, out.sha256]);
  assertEquals(await listDir(dir), [`${stem}.json`, `${stem}.pdf`]);
});

Deno.test("fetch falls back to the publisher's citation_pdf_url", async () => {
  const dir = await tmp();
  const oa = { ...OPENALEX, best_oa_location: {}, open_access: { is_oa: false }, ids: {} };
  const f = fakeFetch({
    [OA_URL]: json(oa),
    [LANDING]: html(`<html><meta name="citation_pdf_url" content="/articles/s41586-025-09694-5.pdf"></html>`),
    [`${LANDING}.pdf`]: bytes(FAKE_PDF, "application/octet-stream"),
  });
  const out = await fetchPdf(DOI, dir, client(f));
  assertEquals([out.status, out.route], ["downloaded", "publisher:citation_pdf_url"]);
});

Deno.test("fetch rejects login pages and reports not_fetched without leftovers", async () => {
  const dir = await tmp();
  const oa = { ...OPENALEX, best_oa_location: { pdf_url: "https://pub.org/a.pdf" }, ids: {} };
  const f = fakeFetch({
    [OA_URL]: json(oa),
    "https://pub.org/a.pdf": html("<html>Please log in</html>"),
    [LANDING]: html("forbidden", 403),
  });
  const out = await fetchPdf(DOI, dir, client(f));
  assertEquals(out.status, "not_fetched");
  assertMatch(out.attempts[0].result, /not a PDF/);
  assertEquals(out.attempts[1].result, "HTTP 403");
  assertEquals(out.landing_url, LANDING);
  assertEquals(await listDir(dir), []);
});

Deno.test("fetch survives a dead network", async () => {
  const dir = await tmp();
  const f = fakeFetch({ [OA_URL]: new TypeError("blocked"), [CR_URL]: new TypeError("blocked"), [`https://doi.org/${DOI}`]: new TypeError("blocked") });
  await assertRejects(
    () => fetchPdf(DOI, dir, client(f)),
    Error,
    "Network unreachable",
  );
  assertEquals(await listDir(dir), []);
});

Deno.test("fetch labels Crossref links as publisher links and tries them after open access", async () => {
  const dir = await tmp();
  const oa = { ...OPENALEX, best_oa_location: { pdf_url: "https://oa.org/a.pdf" }, ids: {} };
  const f = fakeFetch({
    [OA_URL]: json(oa),
    [CR_URL]: json({ message: { link: [{ URL: "https://pub.org/tdm.pdf", "content-type": "application/pdf" }] } }),
    "https://pub.org/tdm.pdf": bytes(FAKE_PDF),
  });
  const out = await fetchPdf(DOI, dir, client(f));
  assertEquals([out.status, out.route], ["downloaded", "publisher:crossref_link"]);
  assertEquals(out.attempts.map((a) => a.url), ["https://oa.org/a.pdf", "https://pub.org/tdm.pdf"]);
});

Deno.test("fetch never files a PDF under another DOI's name, and tolerates a null sidecar", async () => {
  const dir = await tmp();
  // 10.1234/a_b and 10.1234/a/b share the file name 10.1234_a_b
  await Deno.writeFile(join(dir, "10.1234_a_b.pdf"), FAKE_PDF);
  await Deno.writeTextFile(join(dir, "10.1234_a_b.json"), JSON.stringify({ doi: "10.1234/a_b" }));
  const out = await fetchPdf("10.1234/a/b", dir, client(fakeFetch({})));
  assertEquals(out.status, "conflict");
  await Deno.writeTextFile(join(dir, "10.1234_a_b.json"), "null");
  assertEquals((await fetchPdf("10.1234/a/b", dir, client(fakeFetch({})))).status, "already_present");
});

Deno.test("redirects to file: URLs or private hosts are refused", async () => {
  for (const loc of ["file:///etc/passwd", "http://127.0.0.1/x.pdf", "http://169.254.169.254/latest", "http://localhost/x"]) {
    const f = fakeFetch({ "https://a.org/x": new Response(null, { status: 302, headers: { location: loc } }) });
    await assertRejects(() => client(f).get("https://a.org/x"), Error, "Refusing");
  }
  assertEquals(findCitationPdfUrl('<meta name="citation_pdf_url" content="file:///etc/x.pdf">', "https://p.org/"), null);
});

Deno.test("DOIs are URL-encoded in API calls and URL junk is stripped", async () => {
  const sici = "10.1002/(sici)1097-4636(199601)30:1<1::aid-jbm1>3.0.co;2-#";
  assertEquals(normalizeDoi(`https://doi.org/${encodeURIComponent(sici)}?utm_source=x`), sici);
  assertEquals(normalizeDoi("https://doi.org/10.1234/abc?utm_source=x#top"), "10.1234/abc");
  const f = fakeFetch({});
  await resolveDoi(sici, client(f), "KEY");
  const oaCall = new URL(f.calls[0].url);
  assertEquals(oaCall.hash, "");
  assertEquals(oaCall.searchParams.get("api_key"), "KEY");
  assert(oaCall.pathname.endsWith("2-%23"));
});

Deno.test("redirects are followed and cookies are sent back", async () => {
  const f = fakeFetch({
    "https://a.org/start": new Response(null, {
      status: 302,
      headers: { location: "https://www.a.org/next", "set-cookie": "sess=1; Domain=a.org; Path=/" },
    }),
    "https://www.a.org/next": ({ headers }) =>
      headers.get("cookie") === "sess=1" ? bytes(FAKE_PDF) : html("no cookie", 403),
  });
  const r = await client(f).get("https://a.org/start");
  assertEquals([r.status, r.url], [200, "https://www.a.org/next"]);
});

// ------------------------------------------------------------------ zotero

Deno.test("zoteroLookup by DOI, title words and collection, on a copy", async () => {
  const z = await tmp();
  makeZotero(z);
  const before = await Deno.readFile(join(z, "zotero.sqlite"));
  const r = await zoteroLookup(z, { doi: "https://doi.org/10.1016/J.STEMCR.2017.09.007" });
  assertEquals(r.count, 1);
  assertEquals(r.items[0].has_pdf, true);
  assertEquals(r.items[0].creators, ["Li Tan"]);
  assert(r.items[0].attachments[0].path!.endsWith(join("storage", "BBBB2222", "Tan 2017.pdf")));
  assertEquals((await zoteroLookup(z, { query: "mole rat epigenome" })).count, 1);
  assertEquals((await zoteroLookup(z, { collection: "LECTURE2" })).count, 1);
  // whole-word start: 'aging' must not match 'imaging'; items in the bin are left out
  assertEquals((await zoteroLookup(z, { query: "aging" })).count, 0);
  assertEquals(await Deno.readFile(join(z, "zotero.sqlite")), before);
  await assertRejects(() => zoteroLookup(z, {}));
  await assertRejects(() => zoteroLookup(join(z, "missing"), { query: "x" }));
});

// ------------------------------------------------------------------ pdf text

Deno.test("pdfToText works with both engines, chunks, and saves .txt", async () => {
  const dir = await tmp();
  const p = join(dir, "paper.pdf");
  const lines = Array.from({ length: 30 }, (_, i) => `Line ${i} of a test paper about mitochondria`);
  await Deno.writeFile(p, makePdf(lines));
  for (const engine of ["pdftotext", "unpdf"] as const) {
    if (engine === "pdftotext") {
      try {
        await new Deno.Command("pdftotext", { args: ["-v"], stderr: "null" }).output();
      } catch {
        continue; // not installed here
      }
    }
    const r = await pdfToText(p, { maxChars: 100, engine });
    assertEquals(r.engine, engine);
    assert(r.total_chars > 500, `${engine}: ${r.total_chars}`);
    assertEquals([r.returned_chars, r.next_offset], [100, 100]);
    assertMatch(r.text, /Line 0 of a test paper/);
    assertEquals(await Deno.readTextFile(r.txt_path!), (await pdfToText(p, { maxChars: 1e6, engine, saveTxt: false })).text);
    const r2 = await pdfToText(p, { maxChars: 100, offset: 100, engine });
    assertEquals(r2.offset, 100);
  }
});

Deno.test("pdfToText rejects files that are not PDFs", async () => {
  const dir = await tmp();
  await Deno.writeTextFile(join(dir, "x.pdf"), "hello");
  await assertRejects(() => pdfToText(join(dir, "x.pdf")), Error, "%PDF-");
  await assertRejects(() => pdfToText(join(dir, "nope.pdf")), Error, "not found");
  await assertRejects(() => pdfToText(join(dir, "x.txt")), Error, "Not a .pdf");
});

// ------------------------------------------------------------------ import downloads

Deno.test("importDownloads files PDFs by DOI, checks titles, skips duplicates", async () => {
  const dl = await tmp();
  const papers = await tmp();
  const own = makePdf([OPENALEX.title, `https://doi.org/${DOI}`]);
  await Deno.writeFile(join(dl, "paper (1).pdf"), own);
  await Deno.writeFile(join(dl, "paper (2).pdf"), own); // same bytes
  await Deno.writeFile(join(dl, "other.pdf"), makePdf(["Totally unrelated title text", "doi:10.5555/zzz.1"]));
  await Deno.writeFile(join(dl, "nodoi.pdf"), makePdf(["no identifier in here"]));
  await Deno.writeTextFile(join(dl, "fake.pdf"), "<html>login</html>");
  const f = fakeFetch({
    [OA_URL]: json(OPENALEX),
    "https://api.openalex.org/works/doi:10.5555/zzz.1": json({ ...OPENALEX, title: "Bowhead whale DNA repair evidence" }),
  });

  const dry = await importDownloads(dl, papers, client(f), { dryRun: true, engine: "unpdf" });
  assertEquals(dry.summary.would_import, 1);
  assertEquals(await listDir(papers), []);

  const res = await importDownloads(dl, papers, client(f), { engine: "unpdf" });
  const byFile = Object.fromEntries(res.files.map((r) => [r.file, r.status]));
  assertEquals(res.scanned, 5);
  assertEquals(byFile["fake.pdf"], "skipped");
  assertEquals(byFile["nodoi.pdf"], "no_doi");
  assertEquals(byFile["other.pdf"], "doi_mismatch");
  assertEquals(
    [byFile["paper (1).pdf"], byFile["paper (2).pdf"]].sort(),
    ["duplicate", "imported"],
  );
  const stem = doiToFilename(DOI);
  assertEquals(await listDir(papers), [`${stem}.json`, `${stem}.pdf`]);
  const prov = JSON.parse(await Deno.readTextFile(join(papers, `${stem}.json`)));
  assertEquals([prov.route, prov.doi_source, prov.doi_found_in_text], ["import_downloads", "pdf_text", true]);

  const again = await importDownloads(dl, papers, client(f), { engine: "unpdf" });
  assertEquals(again.summary.already_present, 1);
});

Deno.test("importDownloads finds a DOI by embedded title when the text has none", async () => {
  const dl = await tmp();
  const papers = await tmp();
  await Deno.writeFile(join(dl, "t.pdf"), makePdf([OPENALEX.title, "body text"], OPENALEX.title));
  const search = "https://api.openalex.org/works?" +
    new URLSearchParams({ search: OPENALEX.title, "per-page": "3" });
  const f = fakeFetch({
    [search]: json({ results: [{ title: OPENALEX.title, doi: `https://doi.org/${DOI}` }] }),
    [OA_URL]: json(OPENALEX),
  });
  const res = await importDownloads(dl, papers, client(f), { engine: "unpdf" });
  assertEquals(res.files[0].status, "imported");
  assertEquals(res.files[0].doi_source, "title_search");
});

Deno.test("importDownloads does not file a PDF it could not verify", async () => {
  const dl = await tmp();
  const papers = await tmp();
  await Deno.writeFile(join(dl, "p.pdf"), makePdf([OPENALEX.title, `doi:${DOI}`]));
  const down = fakeFetch({ [OA_URL]: new TypeError("offline"), [CR_URL]: new TypeError("offline") });
  const res = await importDownloads(dl, papers, client(down), { engine: "unpdf" });
  assertEquals(res.files[0].status, "unverified");
  assertMatch(res.files[0].reason!, /offline/);
  assertEquals(await listDir(papers), []);
});

Deno.test("importDownloads dry run predicts the real run (same DOI, different files)", async () => {
  const dl = await tmp();
  const papers = await tmp();
  await Deno.writeFile(join(dl, "a.pdf"), makePdf([OPENALEX.title, `doi:${DOI}`, "version A"]));
  await Deno.writeFile(join(dl, "b.pdf"), makePdf([OPENALEX.title, `doi:${DOI}`, "version B"]));
  const f = fakeFetch({ [OA_URL]: json(OPENALEX) });
  const dry = await importDownloads(dl, papers, client(f), { dryRun: true, engine: "unpdf" });
  const real = await importDownloads(dl, papers, client(f), { engine: "unpdf" });
  assertEquals(dry.summary, { would_import: 1, conflict: 1 });
  assertEquals(real.summary, { imported: 1, conflict: 1 });
  await assertRejects(() => importDownloads(join(dl, "nope"), papers, client(f)), Error, "does not exist");
});

Deno.test("zoteroLookup reports truncation and matches DOIs stored as URLs", async () => {
  const z = await tmp();
  makeZotero(z);
  // "i" starts a word in both live titles ("iPSC", "imaging")
  const r = await zoteroLookup(z, { query: "i", limit: 1 });
  assertEquals([r.count, r.returned, r.truncated], [2, 1, true]);
  const db = new DatabaseSync(join(z, "zotero.sqlite"));
  db.exec("update itemDataValues set value = 'https://doi.org/10.1016/j.stemcr.2017.09.007' where valueID = 2");
  db.close();
  assertEquals((await zoteroLookup(z, { doi: "10.1016/j.stemcr.2017.09.007" })).count, 1);
});

// ------------------------------------------------------------------ model methods

Deno.test("model.fetch writes a download resource named after the DOI", async () => {
  const dir = await tmp();
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { papersDir: dir, downloadsDir: dir, zoteroDir: dir },
  });
  const f = fakeFetch({ [OA_URL]: json(OPENALEX), [`${LANDING}.pdf`]: bytes(FAKE_PDF) });
  // deno-lint-ignore no-explicit-any
  await model.methods.fetch.execute({ doi: DOI, overwrite: false, _fetch: f }, context as any);
  const w = getWrittenResources();
  assertEquals(w.length, 1);
  assertEquals([w[0].specName, w[0].name], ["download", "download-10.1038_s41586-025-09694-5"]);
  assertEquals(w[0].data.status, "downloaded");
  assert(model.resources.download.schema.safeParse(w[0].data).success);
});

Deno.test("model.resolve writes a work resource and fails loudly when nothing resolves", async () => {
  const { context, getWrittenResources } = createModelTestContext({ globalArgs: {} });
  const f = fakeFetch({ [OA_URL]: json(OPENALEX) });
  // deno-lint-ignore no-explicit-any
  await model.methods.resolve.execute({ doi: DOI, _fetch: f }, context as any);
  const w = getWrittenResources()[0];
  assertEquals(w.name, "work-10.1038_s41586-025-09694-5");
  assert(model.resources.work.schema.safeParse(w.data).success);
  await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => model.methods.resolve.execute({ doi: DOI, _fetch: fakeFetch({}) }, context as any),
    Error,
    "Could not resolve",
  );
});

Deno.test("model.zoteroLookup and model.pdfToText write schema-valid resources", async () => {
  const z = await tmp();
  makeZotero(z);
  await Deno.writeFile(join(z, "a.pdf"), makePdf(["hello text"]));
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { papersDir: z, downloadsDir: z, zoteroDir: z },
  });
  // deno-lint-ignore no-explicit-any
  await model.methods.zoteroLookup.execute({ query: "mole rat", limit: 20 }, context as any);
  // deno-lint-ignore no-explicit-any
  await model.methods.pdfToText.execute({ path: join(z, "a.pdf"), maxChars: 1000, offset: 0, saveTxt: false }, context as any);
  const [zr, tx] = getWrittenResources();
  assertEquals([zr.name, zr.data.count], ["zotero-latest", 1]);
  assert(model.resources.zoteroResult.schema.strict().safeParse(zr.data).success);
  assertMatch(tx.name, /^text-a-[0-9a-f]{8}$/);
  assertEquals(tx.data.txt_path, null);
  assert(model.resources.pdfText.schema.strict().safeParse(tx.data).success);
});

Deno.test("model.importDownloads writes a schema-valid importRun", async () => {
  const dl = await tmp();
  const papers = await tmp();
  await Deno.writeFile(join(dl, "p.pdf"), makePdf([OPENALEX.title, `doi:${DOI}`]));
  await Deno.writeTextFile(join(dl, "bad.pdf"), "nope");
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { papersDir: papers, downloadsDir: dl, zoteroDir: dl },
  });
  const f = fakeFetch({ [OA_URL]: json(OPENALEX) });
  // deno-lint-ignore no-explicit-any
  await model.methods.importDownloads.execute({ sinceHours: 1, dryRun: false, _fetch: f }, context as any);
  const w = getWrittenResources()[0];
  assertEquals([w.specName, w.name], ["importRun", "import-latest"]);
  const parsed = model.resources.importRun.schema.safeParse(w.data);
  assert(parsed.success, JSON.stringify(parsed.error?.issues));
  assertEquals(w.data.summary, { imported: 1, skipped: 1 });
});
