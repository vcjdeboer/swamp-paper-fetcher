/**
 * Read-only search of a local Zotero library.
 *
 * The live `zotero.sqlite` is never opened: it is copied to a temporary
 * folder, the copy is opened read-only and deleted afterwards. This is safe
 * while Zotero is running (Zotero locks its own database).
 *
 * @module
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { exists, expandHome, normalizeDoi } from "./util.ts";

/** One attachment of a Zotero item. */
export interface ZoteroAttachment {
  key: string;
  content_type: string | null;
  path: string | null;
  exists: boolean;
}

/** One Zotero item (not attachments, notes or annotations; not items in the bin). */
export interface ZoteroItem {
  item_key: string;
  type: string;
  title: string | null;
  doi: string | null;
  date: string | null;
  publication: string | null;
  creators: string[];
  collections: string[];
  attachments: ZoteroAttachment[];
  has_pdf: boolean;
}

/** Search result: `count` matches in total, `items` the first `limit` sorted by title. */
export interface ZoteroResult {
  count: number;
  returned: number;
  /** True when more items matched than `limit` allowed. */
  truncated: boolean;
  items: ZoteroItem[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Search Zotero. `doi`: exact DOI match. `query`: every word must start a word
 * in the title (so `aging` matches "aging-related" but not "imaging").
 * `collection`: only items in a collection with this name (case-insensitive).
 */
export async function zoteroLookup(
  zoteroDir: string,
  q: { doi?: string; query?: string; collection?: string; limit?: number },
): Promise<ZoteroResult> {
  if (!q.doi && !q.query && !q.collection) {
    throw new Error("Give at least one of doi, query or collection");
  }
  const zdir = expandHome(zoteroDir);
  const src = join(zdir, "zotero.sqlite");
  if (!await exists(src)) throw new Error(`No zotero.sqlite in ${zdir}`);
  const tmpDir = await Deno.makeTempDir({ prefix: "paper-fetcher-z-" });
  const copy = join(tmpDir, "zotero.sqlite");
  try {
    await Deno.copyFile(src, copy);
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const fieldRows = (name: string): Map<number, string> => {
        const rows = db.prepare(
          `select d.itemID as id, v.value as value from itemData d
           join fields f on f.fieldID = d.fieldID and f.fieldName = ?
           join itemDataValues v on v.valueID = d.valueID`,
        ).all(name) as { id: number; value: string }[];
        return new Map(rows.map((r) => [Number(r.id), String(r.value)]));
      };
      const regular = new Map<number, { key: string; type: string }>();
      for (
        const r of db.prepare(
          `select i.itemID as id, i.key as key, t.typeName as type
           from items i join itemTypes t using(itemTypeID)
           where t.typeName not in ('attachment','note','annotation')
           and i.itemID not in (select itemID from deletedItems)`,
        ).all() as { id: number; key: string; type: string }[]
      ) regular.set(Number(r.id), { key: r.key, type: r.type });

      const titles = fieldRows("title");
      const dois = fieldRows("DOI");
      const dates = fieldRows("date");
      const pubs = fieldRows("publicationTitle");

      let cand = [...regular.keys()];
      if (q.doi) {
        const nd = normalizeDoi(q.doi);
        const stored = (i: number): string | null => {
          const v = dois.get(i);
          if (!v) return null;
          try {
            return normalizeDoi(v); // also matches values stored as doi:… or https://doi.org/…
          } catch {
            return v.trim().toLowerCase();
          }
        };
        cand = cand.filter((i) => stored(i) === nd);
      }
      if (q.query) {
        const words = q.query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
        const pats = words.map((w) =>
          new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(w)}`, "iu")
        );
        cand = cand.filter((i) => {
          const t = titles.get(i);
          return t !== undefined && pats.every((p) => p.test(t));
        });
      }
      const collNames = new Map<number, string[]>();
      for (
        const r of db.prepare(
          `select ci.itemID as id, c.collectionName as name
           from collectionItems ci join collections c using(collectionID)`,
        ).all() as { id: number; name: string }[]
      ) {
        const id = Number(r.id);
        collNames.set(id, [...(collNames.get(id) ?? []), r.name]);
      }
      if (q.collection) {
        const cl = q.collection.toLowerCase();
        cand = cand.filter((i) =>
          (collNames.get(i) ?? []).some((c) => c.toLowerCase() === cl)
        );
      }

      const storage = join(zdir, "storage");
      const creatorsStmt = db.prepare(
        `select c.firstName as first, c.lastName as last
         from itemCreators ic join creators c using(creatorID)
         where ic.itemID = ? order by ic.orderIndex`,
      );
      const attStmt = db.prepare(
        `select i.key as key, a.contentType as ctype, a.path as path
         from itemAttachments a join items i on i.itemID = a.itemID
         where a.parentItemID = ?`,
      );
      const sorted = cand.sort((a, b) =>
        (titles.get(a) ?? "").localeCompare(titles.get(b) ?? "")
      ).slice(0, Math.max(1, q.limit ?? 20));
      const items: ZoteroItem[] = [];
      for (const id of sorted) {
        const { key, type } = regular.get(id)!;
        const creators = (creatorsStmt.all(id) as {
          first: string | null;
          last: string | null;
        }[]).map((r) => [r.first, r.last].filter(Boolean).join(" "));
        const attachments: ZoteroAttachment[] = [];
        for (
          const a of attStmt.all(id) as {
            key: string;
            ctype: string | null;
            path: string | null;
          }[]
        ) {
          let full: string | null = null;
          if (a.path?.startsWith("storage:")) {
            full = join(storage, a.key, a.path.slice("storage:".length));
          } else if (a.path) full = a.path;
          attachments.push({
            key: a.key,
            content_type: a.ctype,
            path: full,
            exists: full ? await exists(full) : false,
          });
        }
        items.push({
          item_key: key,
          type,
          title: titles.get(id) ?? null,
          doi: dois.get(id) ?? null,
          date: dates.get(id) ?? null,
          publication: pubs.get(id) ?? null,
          creators,
          collections: collNames.get(id) ?? [],
          attachments,
          has_pdf: attachments.some((x) =>
            x.content_type === "application/pdf" && x.exists
          ),
        });
      }
      return {
        count: cand.length,
        returned: items.length,
        truncated: items.length < cand.length,
        items,
      };
    } finally {
      db.close();
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}
