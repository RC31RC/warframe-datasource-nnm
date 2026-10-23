import { createHash } from "node:crypto";
import type { DatasetFileInput } from "../domain/contracts.js";

type JsonObject = Record<string, unknown>;

const I18N_ITEMS = "catalog/i18n/items.json";
const MARKET_ITEMS = "market/items.json";

/** Adds the official catalog reference directly to each Market record without dropping unmatched listings. */
export function projectMarketItems(
  catalogFiles: DatasetFileInput[],
  marketFiles: DatasetFileInput[],
): DatasetFileInput[] {
  const catalogFile = catalogFiles.find((file) => file.path === I18N_ITEMS);
  const marketFile = marketFiles.find((file) => file.path === MARKET_ITEMS && file.stage === "cleaned");
  if (!catalogFile || !marketFile) throw new Error("Market item projection input is missing");

  const translations = parseObject(catalogFile);
  const records = parseArray(marketFile);
  const projected = records.map((item) => {
    const gameRef = text(item, "gameRef");
    const official = gameRef ? objectAt(translations, gameRef) : undefined;
    const english = official ? objectAt(official, "en") : undefined;
    const chinese = official ? objectAt(official, "zh") : undefined;
    const icon = text(item, "icon");
    const thumb = text(item, "thumb");
    const gameItem = gameRef ? {
      uniqueName: gameRef,
      name: text(english ?? {}, "name") ?? text(item, "name") ?? "",
      nameZh: text(chinese ?? {}, "name") ?? "",
      ...(text(official ?? {}, "iconUrl") ? { iconUrl: text(official ?? {}, "iconUrl") } : {}),
      resolution: official ? "catalog_match" : "identity_only",
    } : null;
    return {
      ...item,
      gameRefStatus: !gameRef ? "missing_game_ref" : official ? "matched" : "unresolved_catalog_identity",
      gameItem,
      iconUrl: icon ? marketAssetUrl(icon) : "",
      thumbUrl: thumb ? marketAssetUrl(thumb) : "",
    };
  });

  if (projected.length !== records.length) throw new Error("Market item projection dropped records");
  const slugs = projected.map((item) => text(item, "slug"));
  if (slugs.some((slug) => !slug) || new Set(slugs).size !== slugs.length) {
    throw new Error("Market item projection requires unique, non-empty slugs");
  }

  const rawInputs = marketFiles.filter((file) => file.stage === "raw");
  const output: DatasetFileInput = {
    ...marketFile,
    content: `${JSON.stringify(projected, null, 2)}\n`,
    recordCount: projected.length,
    source: {
      ...marketFile.source,
      upstreamRevision: createHash("sha256").update(JSON.stringify(projected)).digest("hex"),
      transformer: "warframe-datasource-nnm/market-item-enrichment@2",
      derivedFrom: [...new Set([...(marketFile.source.derivedFrom ?? []), ...rawInputs.map((file) => file.path), I18N_ITEMS])],
    },
  };
  return [...rawInputs, output];
}

function parseObject(file: DatasetFileInput): JsonObject {
  return asObject(JSON.parse(asText(file.content)) as unknown, file.path);
}

function parseArray(file: DatasetFileInput): JsonObject[] {
  const value = JSON.parse(asText(file.content)) as unknown;
  if (!Array.isArray(value)) throw new Error(`Expected array in ${file.path}`);
  return value.map((entry, index) => asObject(entry, `${file.path}[${index}]`));
}

function objectAt(record: JsonObject, key: string): JsonObject | undefined {
  const value = record[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function asObject(value: unknown, context: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as JsonObject;
}

function text(record: JsonObject, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] as string : undefined;
}

function marketAssetUrl(path: string): string {
  return path ? `https://warframe.market/static/assets/${path}` : "";
}

function asText(content: Buffer | string): string {
  return Buffer.isBuffer(content) ? content.toString("utf8") : content;
}
