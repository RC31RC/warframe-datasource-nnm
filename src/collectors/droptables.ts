import { createHash } from "node:crypto";
import { config } from "../core/config.js";
import { fetchBytes } from "../core/http.js";
import type { DatasetFileInput } from "../domain/contracts.js";

/**
 * 官方掉落表（Warframe PC Drops，HTML）采集与解析。
 * 数据源：https://www.warframe.com/droptables（DE 官方，4.5MB HTML）。
 * 覆盖遗物掉落内容、任务掉落（含遗物掉落位置）、Mod/蓝图/资源/赏金等全量掉落。
 */

export interface DropEntry {
  category: string;
  source: string;
  groups: string[];
  item: string;
  rarity: string;
  chance: number;
}

const DROP_TABLE_URL = "https://www.warframe.com/droptables";

export async function collectDropTables(now = new Date()): Promise<DatasetFileInput[]> {
  const capturedAt = now.toISOString();
  const bytes = await fetchBytes(DROP_TABLE_URL, {
    timeoutMs: config.requestTimeoutMs,
    maxBytes: 16 * 1024 * 1024,
    retries: config.requestRetries,
    headers: { accept: "text/html", "accept-encoding": "identity" },
  });
  const html = bytes.toString("utf8");
  const entries = parseDropTables(html);
  const upstreamRevision = createHash("sha256").update(bytes).digest("hex");
  const rawPath = "droptables/droptables.html";
  const source = {
    project: "Digital Extremes Warframe Drop Tables",
    dataset: "droptables",
    url: DROP_TABLE_URL,
    capturedAt,
    upstreamRevision,
  };
  const output: DatasetFileInput[] = [
    {
      stage: "raw",
      path: rawPath,
      content: bytes,
      source,
    },
  ];

  // 按分类产出清洗后的掉落数据。
  const byCategory = new Map<string, DropEntry[]>();
  for (const entry of entries) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }
  for (const [category, list] of byCategory) {
    output.push({
      stage: "cleaned",
      path: `drop/${slugify(category)}.json`,
      content: `${JSON.stringify(list, null, 2)}\n`,
      recordCount: list.length,
      source: {
        ...source,
        dataset: `droptables/${slugify(category)}`,
        transformer: "warframe-datasource-nnm/droptables-projection@1",
        derivedFrom: [rawPath],
      },
    });
  }
  return output;
}

export function parseDropTables(html: string): DropEntry[] {
  const result: DropEntry[] = [];
  // 按 <h3> 分段：每个 h3 标题是一个分类。
  const sections = html.split(/<h3[^>]*>/u);
  for (const section of sections.slice(1)) {
    const titleEnd = section.indexOf("</h3>");
    if (titleEnd < 0) continue;
    const category = stripTags(section.slice(0, titleEnd)).trim().replace(/:$/u, "");
    const body = section.slice(titleEnd + "</h3>".length);
    result.push(...parseSection(category, body));
  }
  return result;
}

function parseSection(category: string, body: string): DropEntry[] {
  const entries: DropEntry[] = [];
  const rows = body.match(/<tr[^>]*>[\s\S]*?<\/tr>/gu) ?? [];
  let source = "";
  let groups: string[] = [];
  for (const row of rows) {
    if (row.includes("blank-row")) {
      source = "";
      groups = [];
      continue;
    }
    const headers = [...row.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gu)].map((m) => stripTags(m[1] ?? "").trim());
    if (headers.length > 0) {
      const text = headers.join(" ").trim();
      if (!text) continue;
      if (isColumnHeader(text)) continue;
      if (source === "") {
        source = text;
        groups = [];
      } else {
        groups = pushGroup(groups, text);
      }
      continue;
    }
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gu)].map((m) => stripTags(m[1] ?? "").trim());
    if (cells.length === 0) continue;
    const item = pickItemCell(category, cells);
    if (!item) continue;
    const rarityChance = pickRarityChanceCell(cells);
    const parsed = parseRarityChance(rarityChance);
    entries.push({
      category,
      source,
      groups: [...groups],
      item,
      rarity: parsed.rarity,
      chance: parsed.chance,
    });
  }
  return entries;
}

/** 从单元格里挑出"掉落物"列（2 列取第一列，3 列取第二列或第一列）。 */
function pickItemCell(category: string, cells: string[]): string {
  if (cells.length >= 3) {
    // Bounty 等 3 列结构：<空><物品><稀有度>；反向索引：<来源><概率><稀有度>。
    const firstEmpty = cells[0] === "";
    return firstEmpty ? cells[1] ?? "" : cells[0] ?? "";
  }
  return cells[0] ?? "";
}

function pickRarityChanceCell(cells: string[]): string {
  return cells[cells.length - 1] ?? "";
}

/** 按子分组层级更新：Rotation 替换一级分组，Stage 替换二级分组，其余累积。 */
function pushGroup(groups: string[], text: string): string[] {
  if (/^Rotation/u.test(text)) return [text];
  if (/^Stage/u.test(text)) {
    const rotation = groups[0] && /^Rotation/u.test(groups[0]) ? groups[0] : undefined;
    return rotation ? [rotation, text] : [text];
  }
  return [...groups, text];
}

function isColumnHeader(text: string): boolean {
  return /^(Source|Chance|Mod Drop Chance|Item|Blueprint\/Item|Resource|Sigil)$/iu.test(text);
}

function parseRarityChance(text: string): { rarity: string; chance: number } {
  const match = text.match(/^([A-Za-z ]+)\s*\((\d+(?:\.\d+)?)%\)$/u);
  if (match) {
    return { rarity: match[1]?.trim() ?? "", chance: Number(match[2] ?? 0) };
  }
  const plain = text.match(/^(\d+(?:\.\d+)?)%$/u);
  if (plain) {
    return { rarity: "", chance: Number(plain[1]) };
  }
  return { rarity: text, chance: 0 };
}

function slugify(category: string): string {
  return category
    .toLowerCase()
    .replace(/['']/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function stripTags(text: string): string {
  return text.replace(/<[^>]*>/gu, "").replace(/&amp;/gu, "&").replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">").replace(/&#39;|&apos;/gu, "'").replace(/&quot;/gu, "\"");
}
