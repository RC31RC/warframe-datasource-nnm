import { createHash } from "node:crypto";
import { config } from "../core/config.js";
import { fetchBytes } from "../core/http.js";
import type { DatasetFileInput } from "../domain/contracts.js";

/**
 * DE 官方年度战甲/武器使用率统计（一手数据）。
 * 来源：https://www-static.warframe.com/repos/WarframeUsageData{year}.json
 * 顶层为平台（ALL/NI/PC/PS/XB），其下为类别（Melee/Primary/Secondary/Warframe），
 * 再下为「装备名 -> { 段位 -> 使用率 }」。2025 年起官方仅发布 ALL（全平台合并）。
 */

const USAGE_YEARS = ["2020", "2021", "2022", "2023", "2024", "2025"] as const;
const USAGE_URL_TEMPLATE = "https://www-static.warframe.com/repos/WarframeUsageData{year}.json";

export interface UsageRecord {
  year: string;
  platform: string;
  category: string;
  item: string;
  rank: string;
  usage: number;
}

export async function collectUsageData(now = new Date()): Promise<DatasetFileInput[]> {
  const capturedAt = now.toISOString();
  const output: DatasetFileInput[] = [];
  for (const year of USAGE_YEARS) {
    const url = USAGE_URL_TEMPLATE.replace("{year}", year);
    const bytes = await fetchBytes(url, {
      timeoutMs: config.requestTimeoutMs,
      maxBytes: 16 * 1024 * 1024,
      retries: config.requestRetries,
      headers: { accept: "application/json", "accept-encoding": "identity" },
    });
    const value = parseUsageData(bytes, year);
    const upstreamRevision = createHash("sha256").update(bytes).digest("hex");
    const rawPath = `usage/raw/WarframeUsageData${year}.json`;
    output.push({
      stage: "raw",
      path: rawPath,
      content: bytes,
      source: {
        project: "Digital Extremes Warframe Usage Data",
        dataset: `usage/${year}`,
        url,
        capturedAt,
        upstreamRevision,
      },
    });
    output.push({
      stage: "cleaned",
      path: `usage/${year}.json`,
      content: `${JSON.stringify(value, null, 2)}\n`,
      recordCount: value.length,
      source: {
        project: "Digital Extremes Warframe Usage Data",
        dataset: `usage/${year}/nnm-projection`,
        url,
        capturedAt,
        upstreamRevision,
        transformer: "warframe-datasource-nnm/usage-projection@1",
        derivedFrom: [rawPath],
      },
    });
  }
  return output;
}

/** 把官方嵌套结构 {platform: {category: {item: {rank: usage}}}} 展平成扁平记录。 */
export function parseUsageData(bytes: Buffer, year: string): UsageRecord[] {
  let root: unknown;
  try {
    root = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Invalid Warframe usage data payload for ${year}`, { cause: error });
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new Error(`Warframe usage data ${year} must be a JSON object`);
  }
  const records: UsageRecord[] = [];
  for (const [platform, categories] of Object.entries(root as Record<string, unknown>)) {
    if (typeof categories !== "object" || categories === null || Array.isArray(categories)) continue;
    for (const [category, items] of Object.entries(categories as Record<string, unknown>)) {
      if (typeof items !== "object" || items === null || Array.isArray(items)) continue;
      for (const [item, ranks] of Object.entries(items as Record<string, unknown>)) {
        if (typeof ranks !== "object" || ranks === null || Array.isArray(ranks)) continue;
        for (const [rank, usage] of Object.entries(ranks as Record<string, unknown>)) {
          if (typeof usage !== "number" || !Number.isFinite(usage)) continue;
          records.push({ year, platform, category, item, rank, usage });
        }
      }
    }
  }
  if (records.length === 0) throw new Error(`Warframe usage data ${year} contains no records`);
  return records;
}
