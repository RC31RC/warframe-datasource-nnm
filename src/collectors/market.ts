import { createHash } from "node:crypto";
import { config } from "../core/config.js";
import { fetchJson } from "../core/http.js";
import type { DatasetFileInput } from "../domain/contracts.js";

export async function collectRivenAttributes(now = new Date()): Promise<DatasetFileInput[]> {
  const response = await fetchJson(config.marketRivenAttributesUrl, {
    timeoutMs: config.requestTimeoutMs,
    maxBytes: config.maxResponseBytes,
    retries: config.requestRetries,
    headers: { "user-agent": config.marketUserAgent },
  });
  const records = projectAttributes(response.value);
  const capturedAt = now.toISOString();
  const upstreamRevision = createHash("sha256").update(response.bytes).digest("hex");
  const rawPath = "warframe-market/riven-attributes-v2.json";
  const source = {
    project: "Warframe Market API v2",
    dataset: "riven/attributes",
    url: config.marketRivenAttributesUrl,
    capturedAt,
    upstreamRevision,
  };
  return [
    {
      stage: "raw",
      path: rawPath,
      content: response.bytes,
      recordCount: extractSourceData(response.value).length,
      source,
    },
    {
      stage: "cleaned",
      path: "market/riven-attributes.json",
      content: `${JSON.stringify(records, null, 2)}\n`,
      recordCount: records.length,
      source: {
        ...source,
        dataset: "riven/attributes/nnm-projection",
        transformer: "warframe-datasource-nnm/market-riven-projection@1",
        derivedFrom: [rawPath],
      },
    },
  ];
}

export function extractAttributes(value: unknown): Record<string, unknown>[] {
  const data = extractSourceData(value);
  const slugs = new Set<string>();
  const ids = new Set<number>();
  const records: Record<string, unknown>[] = [];
  for (const source of data) {
    const slug = source.slug;
    if (typeof slug !== "string" || slug.trim() === "") {
      throw new Error("Warframe Market riven attribute lacks slug");
    }
    if (slugs.has(slug)) throw new Error(`Duplicate Warframe Market riven attribute: ${slug}`);
    slugs.add(slug);
    const id = stableNumericId(slug);
    if (ids.has(id)) throw new Error(`Stable numeric attribute id collision: ${slug}`);
    ids.add(id);

    const translated = asObject(asObject(source.i18n)?.en);
    const exclusiveTo = source.exclusiveTo;
    records.push({
      ...source,
      ids: id,
      recordKey: slug,
      url_name: slug,
      effect: typeof translated?.name === "string" ? translated.name : slug,
      group: typeof source.group === "string" ? source.group : "default",
      negative_only: source.negativeOnly === true,
      positive_is_negative: source.positiveIsNegative === true,
      prefix: typeof source.prefix === "string" ? source.prefix : "",
      search_only: false,
      suffix: typeof source.suffix === "string" ? source.suffix : "",
      units: typeof source.unit === "string" ? source.unit : "",
      exclusive_to: Array.isArray(exclusiveTo) ? JSON.stringify(exclusiveTo) : "",
    });
  }
  return records;
}

function extractSourceData(value: unknown): Record<string, unknown>[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Warframe Market riven attributes response must be an object");
  }
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Warframe Market riven attributes response has no data records");
  }
  const records: Record<string, unknown>[] = [];
  for (const record of data) {
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new Error("Warframe Market riven attributes contains a non-object record");
    }
    records.push(record as Record<string, unknown>);
  }
  return records;
}

export function projectAttributes(value: unknown): Record<string, unknown>[] {
  return extractAttributes(value);
}

export async function collectRivenWeapons(now = new Date()): Promise<DatasetFileInput[]> {
  const response = await fetchJson(config.marketRivenWeaponsUrl, {
    timeoutMs: config.requestTimeoutMs,
    maxBytes: config.maxResponseBytes,
    retries: config.requestRetries,
    headers: { "user-agent": config.marketUserAgent },
  });
  const records = projectWeapons(response.value);
  const capturedAt = now.toISOString();
  const upstreamRevision = createHash("sha256").update(response.bytes).digest("hex");
  const rawPath = "warframe-market/riven-weapons-v2.json";
  const source = {
    project: "Warframe Market API v2",
    dataset: "riven/weapons",
    url: config.marketRivenWeaponsUrl,
    capturedAt,
    upstreamRevision,
  };
  return [
    {
      stage: "raw",
      path: rawPath,
      content: response.bytes,
      recordCount: extractWeaponData(response.value).length,
      source,
    },
    {
      stage: "cleaned",
      path: "market/riven-weapons.json",
      content: `${JSON.stringify(records, null, 2)}\n`,
      recordCount: records.length,
      source: {
        ...source,
        dataset: "riven/weapons/nnm-projection",
        transformer: "warframe-datasource-nnm/market-riven-weapons-projection@1",
        derivedFrom: [rawPath],
      },
    },
  ];
}

export function projectWeapons(value: unknown): Record<string, unknown>[] {
  const data = extractWeaponData(value);
  const slugs = new Set<string>();
  const records: Record<string, unknown>[] = [];
  for (const source of data) {
    const slug = source.slug;
    if (typeof slug !== "string" || slug.trim() === "") {
      throw new Error("Warframe Market riven weapon lacks slug");
    }
    if (slugs.has(slug)) throw new Error(`Duplicate Warframe Market riven weapon: ${slug}`);
    slugs.add(slug);
    const translated = asObject(asObject(source.i18n)?.en);
    records.push({
      ...source,
      recordKey: slug,
      url_name: slug,
      name: typeof translated?.name === "string" ? translated.name : slug,
      group: typeof source.group === "string" ? source.group : "unknown",
      rivenType: typeof source.rivenType === "string" ? source.rivenType : "",
      gameRef: typeof source.gameRef === "string" ? source.gameRef : "",
      disposition: typeof source.disposition === "number" ? source.disposition : 0,
    });
  }
  return records;
}

function extractWeaponData(value: unknown): Record<string, unknown>[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Warframe Market riven weapons response must be an object");
  }
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Warframe Market riven weapons response has no data records");
  }
  const records: Record<string, unknown>[] = [];
  for (const record of data) {
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new Error("Warframe Market riven weapons contains a non-object record");
    }
    records.push(record as Record<string, unknown>);
  }
  return records;
}

export async function collectMarketItems(now = new Date()): Promise<DatasetFileInput[]> {
  const response = await fetchJson(config.marketItemsUrl, {
    timeoutMs: config.requestTimeoutMs,
    maxBytes: config.maxResponseBytes,
    retries: config.requestRetries,
    headers: { "user-agent": config.marketUserAgent },
  });
  const records = projectItems(response.value);
  const capturedAt = now.toISOString();
  const upstreamRevision = createHash("sha256").update(response.bytes).digest("hex");
  const rawPath = "warframe-market/items-v2.json";
  const source = {
    project: "Warframe Market API v2",
    dataset: "items",
    url: config.marketItemsUrl,
    capturedAt,
    upstreamRevision,
  };
  return [
    {
      stage: "raw",
      path: rawPath,
      content: response.bytes,
      recordCount: extractItemData(response.value).length,
      source,
    },
    {
      stage: "cleaned",
      path: "market/items.json",
      content: `${JSON.stringify(records, null, 2)}\n`,
      recordCount: records.length,
      source: {
        ...source,
        dataset: "items/nnm-projection",
        transformer: "warframe-datasource-nnm/market-items-projection@1",
        derivedFrom: [rawPath],
      },
    },
  ];
}

export function projectItems(value: unknown): Record<string, unknown>[] {
  const data = extractItemData(value);
  const slugs = new Set<string>();
  const records: Record<string, unknown>[] = [];
  for (const source of data) {
    const slug = source.slug;
    if (typeof slug !== "string" || slug.trim() === "") {
      throw new Error("Warframe Market item lacks slug");
    }
    if (slugs.has(slug)) throw new Error(`Duplicate Warframe Market item: ${slug}`);
    slugs.add(slug);
    const en = asObject(asObject(source.i18n)?.en);
    records.push({
      ...source,
      recordKey: slug,
      url_name: slug,
      name: typeof en?.name === "string" ? en.name : slug,
      icon: typeof en?.icon === "string" ? en.icon : "",
      thumb: typeof en?.thumb === "string" ? en.thumb : "",
      subIcon: typeof en?.subIcon === "string" ? en.subIcon : "",
      gameRef: typeof source.gameRef === "string" ? source.gameRef : "",
      tags: Array.isArray(source.tags) ? source.tags : [],
    });
  }
  return records;
}

function extractItemData(value: unknown): Record<string, unknown>[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Warframe Market items response must be an object");
  }
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Warframe Market items response has no data records");
  }
  const records: Record<string, unknown>[] = [];
  for (const record of data) {
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new Error("Warframe Market items contains a non-object record");
    }
    records.push(record as Record<string, unknown>);
  }
  return records;
}

function stableNumericId(slug: string): number {
  // Keep the value within JavaScript's exact integer range and NnmBot's Long field.
  const digest = createHash("sha256").update(`warframe-market-riven:${slug}`).digest();
  return Number(digest.readBigUInt64BE(0) % BigInt(Number.MAX_SAFE_INTEGER - 1)) + 1;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
