// One-time Airtable export (plan §2.3) — runs when AIRTABLE_TOKEN exists.
// Exports every record from both bases + the metadata (table/field/enum
// definitions) to migration/out/*.json. The import step (Phase 6 cutover)
// reads these files; this script never writes to Airtable.
//
// Also resolves the partner-program base conflict: exports BOTH candidate
// bases; whichever holds live data wins.
//
//   pnpm migrate:export

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadEnv } from "@biolinx/core";

loadEnv();

const TOKEN = process.env.AIRTABLE_TOKEN;
if (!TOKEN) {
  console.error("AIRTABLE_TOKEN not set — get a read-scoped token (Phase 0 item A2) first.");
  process.exit(1);
}

const BASES: Record<string, string> = {
  outreach: process.env.AIRTABLE_BASE_OUTREACH ?? "appuAsxhD5VvAgsSJ",
  partnerLive: process.env.AIRTABLE_BASE_PARTNER_LIVE ?? "app5ZkzkC7jTzxQGx",
  partnerSpec: process.env.AIRTABLE_BASE_PARTNER_SPEC ?? "appWB51fZf8JxqI9f",
};

const OUT = path.join(import.meta.dirname, "out");
await mkdir(OUT, { recursive: true });

const headers = { Authorization: `Bearer ${TOKEN}` };

async function api<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json() as Promise<T>;
}

interface TableMeta {
  id: string;
  name: string;
  fields: Array<{ id: string; name: string; type: string; options?: unknown }>;
}

for (const [label, baseId] of Object.entries(BASES)) {
  try {
    // Metadata: table + field + singleSelect option definitions → our enums.
    const meta = await api<{ tables: TableMeta[] }>(
      `https://api.airtable.com/v0/meta/bases/${baseId}/tables`,
    );
    await writeFile(path.join(OUT, `${label}.meta.json`), JSON.stringify(meta, null, 2));
    console.log(`[${label}] metadata: ${meta.tables.length} tables`);

    // Records: full export per table, paginated.
    for (const table of meta.tables) {
      const records: unknown[] = [];
      let offset: string | undefined;
      do {
        const qs = new URLSearchParams({ pageSize: "100" });
        if (offset) qs.set("offset", offset);
        const page = await api<{ records: unknown[]; offset?: string }>(
          `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table.id)}?${qs}`,
        );
        records.push(...page.records);
        offset = page.offset;
        await new Promise((r) => setTimeout(r, 250)); // stay under 5 rps
      } while (offset);
      await writeFile(
        path.join(OUT, `${label}.${table.name.replace(/\W+/g, "_")}.json`),
        JSON.stringify(records, null, 2),
      );
      console.log(`[${label}] ${table.name}: ${records.length} records`);
    }
  } catch (err) {
    console.error(`[${label}] FAILED: ${(err as Error).message}`);
  }
}

console.log(`\nDone. Files in ${OUT}. Records may contain PII — out/ is gitignored; keep it that way.`);
