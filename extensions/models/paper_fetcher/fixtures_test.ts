// Test fixtures shared by the paper-fetcher tests (the _test.ts suffix keeps
// swamp from loading this file as a model).

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { FetchFn } from "./util.ts";

/** Smallest byte string that passes the %PDF- check. */
export const FAKE_PDF = new TextEncoder().encode(
  "%PDF-1.7\n% fake test pdf\n%%EOF\n",
);

/** Build a real one-page PDF with the given text lines and optional /Title. */
export function makePdf(lines: string[], title?: string): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => "\\" + c);
  const content = "BT /F1 12 Tf 72 720 Td 14 TL " +
    lines.map((l) => `(${esc(l)}) '`).join(" ") + " ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  if (title) objs.push(`<< /Title (${esc(title)}) >>`);
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${
    title ? ` /Info ${objs.length} 0 R` : ""
  } >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** A route of the fake network: a Response, a function producing one, or an error to throw. */
export type Route =
  | Response
  | ((req: { url: string; headers: Headers }) => Response)
  | Error;

/**
 * Fake fetch: exact-URL routes; anything else is a 404. Records each request.
 * Responses are cloned so a route can be hit more than once.
 */
export function fakeFetch(
  routes: Record<string, Route>,
): FetchFn & { calls: { url: string; headers: Headers }[] } {
  const calls: { url: string; headers: Headers }[] = [];
  const fn = (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    calls.push({ url, headers });
    const r = routes[url];
    if (r === undefined) return Promise.resolve(new Response("nf", { status: 404 }));
    if (r instanceof Error) return Promise.reject(r);
    if (typeof r === "function") return Promise.resolve(r({ url, headers }));
    return Promise.resolve(r.clone());
  };
  return Object.assign(fn, { calls });
}

/** JSON response helper. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Bytes response helper. */
export function bytes(
  body: Uint8Array,
  contentType = "application/pdf",
): Response {
  return new Response(body as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

/** HTML response helper. */
export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
  });
}

/** Write a small Zotero database (same schema subset Zotero uses) into `dir`. */
export function makeZotero(dir: string): void {
  const db = new DatabaseSync(join(dir, "zotero.sqlite"));
  db.exec(`
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
  `);
  db.close();
  Deno.mkdirSync(join(dir, "storage", "BBBB2222"), { recursive: true });
  Deno.writeFileSync(join(dir, "storage", "BBBB2222", "Tan 2017.pdf"), FAKE_PDF);
}
