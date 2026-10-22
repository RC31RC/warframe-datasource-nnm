import { createHash } from "node:crypto";
import type { DatasetFileInput } from "../domain/contracts.js";

type JsonObject = Record<string, unknown>;

const RELIC_ARCANE_EN = "public-export/en/ExportRelicArcane_en.json";
const RELIC_ARCANE_ZH = "public-export/zh/ExportRelicArcane_zh.json";
const DROP_RELICS = "drop/relics.json";
const DROP_MISSIONS = "drop/missions.json";
const MARKET_ITEMS = "market/items.json";
const I18N_ITEMS = "catalog/i18n/items.json";

const STATES = ["Intact", "Exceptional", "Flawless", "Radiant"] as const;

/**
 * 以"遗物可读名"为枢纽，跨源关联官方 Export、官方掉落表、market items，
 * 产出"掉什么部件 + 去哪里刷 + 中英名 + market slug"的完整遗物总表。
 */
export function projectLinkedRelics(
  publicExportFiles: DatasetFileInput[],
  dropFiles: DatasetFileInput[],
  marketFiles: DatasetFileInput[],
): DatasetFileInput[] {
  const relicArcaneEn = readRequired(publicExportFiles, RELIC_ARCANE_EN, "ExportRelicArcane");
  const relicArcaneZh = readRequired(publicExportFiles, RELIC_ARCANE_ZH, "ExportRelicArcane");
  const dropRelics = readJsonArray(dropFiles, DROP_RELICS);
  const dropMissions = readJsonArray(dropFiles, DROP_MISSIONS);
  const marketItems = readJsonArray(marketFiles, MARKET_ITEMS);

  // 官方 zh 名：uniqueName -> 中文名。
  const zhByUniqueName = new Map<string, string>();
  for (const record of relicArcaneZh) {
    const uniqueName = text(record, "uniqueName");
    const name = text(record, "name");
    if (uniqueName && name) zhByUniqueName.set(uniqueName, name);
  }

  // 官方遗物：可读名 -> { nameZh, uniqueNames(按状态) }。
  const relicsByName = new Map<string, JsonObject>();
  for (const record of relicArcaneEn) {
    const uniqueName = text(record, "uniqueName");
    const name = text(record, "name");
    if (!uniqueName?.includes("/Projections/") || !name) continue;
    const state = stateFor(uniqueName);
    const existing = relicsByName.get(name);
    if (existing) {
      (existing.uniqueNames as Record<string, string>)[state] = uniqueName;
      continue;
    }
    relicsByName.set(name, {
      name,
      nameZh: zhByUniqueName.get(uniqueName) ?? name,
      uniqueNames: { [state]: uniqueName },
      rewardsByState: Object.fromEntries(STATES.map((s) => [s, []])) as Record<string, JsonObject[]>,
      drops: [],
      marketSlug: "",
    });
  }

  // 掉落内容：drop/relics.json 的 source "Axi A19 Relic (Intact)" -> 按状态分组 rewards。
  for (const entry of dropRelics) {
    const source = text(entry, "source") ?? "";
    const match = source.match(/^(.*?)\s*\((Intact|Exceptional|Flawless|Radiant)\)\s*$/u);
    if (!match) continue;
    const name = match[1]?.trim() ?? "";
    const state = match[2] ?? "Intact";
    const relic = relicsByName.get(name);
    const item = text(entry, "item");
    if (!relic || !item) continue;
    const byState = relic.rewardsByState as Record<string, JsonObject[]>;
    const list = byState[state] ?? (byState[state] = []);
    list.push({
      item,
      rarity: text(entry, "rarity") ?? "",
      chance: number(entry, "chance") ?? 0,
    });
  }

  // 掉落位置：drop/missions.json 的 item "Axi A19 Relic" -> drops（location）。
  for (const entry of dropMissions) {
    const item = text(entry, "item");
    if (!item?.endsWith(" Relic")) continue;
    const relic = relicsByName.get(item);
    if (!relic) continue;
    const location = [...(entry.groups as string[] | undefined) ?? [], text(entry, "source") ?? ""]
      .filter(Boolean).join(" ");
    (relic.drops as JsonObject[]).push({
      location,
      chance: number(entry, "chance") ?? 0,
      rarity: text(entry, "rarity") ?? "",
    });
  }

  // market slug：按英文名匹配（market i18n.en.name == 官方 name）。
  const marketByName = new Map<string, string>();
  for (const item of marketItems) {
    const name = text(item, "name");
    const slug = text(item, "slug");
    if (name?.endsWith(" Relic") && slug) marketByName.set(name, slug);
  }
  for (const [name, relic] of relicsByName) {
    relic.marketSlug = marketByName.get(name) ?? "";
  }

  const linked = [...relicsByName.values()].map((relic) => {
    const drops = relic.drops as JsonObject[];
    const name = relic.name as string;
    const tier = name.split(" ")[0] ?? "";
    const relicName = name.split(" ")[1] ?? "";
    return {
      name,
      nameZh: relic.nameZh as string,
      tier,
      relicName,
      uniqueNames: relic.uniqueNames,
      rewardsByState: relic.rewardsByState,
      drops,
      marketSlug: relic.marketSlug as string,
      vaulted: drops.length === 0,
    };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const inputPaths = [RELIC_ARCANE_EN, RELIC_ARCANE_ZH, DROP_RELICS, DROP_MISSIONS, MARKET_ITEMS];
  return [{
    stage: "cleaned",
    path: "linked/relics.json",
    content: `${JSON.stringify(linked, null, 2)}\n`,
    recordCount: linked.length,
    source: {
      project: "warframe-datasource-nnm",
      dataset: "linked/relics",
      url: "https://www.warframe.com/droptables",
      capturedAt: publicExportFiles.find((f) => f.path === RELIC_ARCANE_EN)?.source.capturedAt ?? "",
      upstreamRevision: createHash("sha256").update(JSON.stringify(linked)).digest("hex"),
      transformer: "warframe-datasource-nnm/linked-relics-projection@1",
      derivedFrom: inputPaths,
    },
  }];
}

function stateFor(uniqueName: string): string {
  if (uniqueName.endsWith("Platinum")) return "Radiant";
  if (uniqueName.endsWith("Gold")) return "Flawless";
  if (uniqueName.endsWith("Silver")) return "Exceptional";
  return "Intact"; // Bronze 或无后缀
}

/**
 * 以官方 uniqueName 为枢纽，把 market items（slug/图标/tags/ducats）与官方
 * i18n（中英名）关联，产出"market↔官方"的完整物品桥接表。
 */
export function projectLinkedItems(
  catalogFiles: DatasetFileInput[],
  marketFiles: DatasetFileInput[],
): DatasetFileInput[] {
  const i18nFile = catalogFiles.find((f) => f.path === I18N_ITEMS);
  const marketFile = marketFiles.find((f) => f.path === MARKET_ITEMS);
  if (!i18nFile || !marketFile) {
    throw new Error("Linked items projection input is missing");
  }
  const i18n = JSON.parse(Buffer.isBuffer(i18nFile.content) ? i18nFile.content.toString("utf8") : i18nFile.content) as unknown as Record<string, JsonObject>;
  const market = JSON.parse(Buffer.isBuffer(marketFile.content) ? marketFile.content.toString("utf8") : marketFile.content) as unknown as JsonObject[];

  const linked: JsonObject[] = [];
  for (const item of market) {
    const gameRef = text(item, "gameRef");
    const slug = text(item, "slug");
    if (!gameRef || !slug) continue;
    const official = i18n[gameRef];
    const nameZh = official && typeof official.zh === "object" && official.zh !== null
      ? text(official.zh as JsonObject, "name") : undefined;
    const icon = text(item, "icon") ?? "";
    const thumb = text(item, "thumb") ?? "";
    linked.push({
      slug,
      uniqueName: gameRef,
      name: text(item, "name") ?? slug,
      nameZh: nameZh ?? "",
      icon,
      thumb,
      iconUrl: icon ? `https://warframe.market/static/assets/${icon}` : "",
      thumbUrl: thumb ? `https://warframe.market/static/assets/${thumb}` : "",
      tags: item.tags ?? [],
      ducats: item.ducats ?? null,
      maxRank: item.maxRank ?? null,
    });
  }

  const capturedAt = marketFile.source.capturedAt ?? "";
  return [{
    stage: "cleaned",
    path: "linked/items.json",
    content: `${JSON.stringify(linked, null, 2)}\n`,
    recordCount: linked.length,
    source: {
      project: "warframe-datasource-nnm",
      dataset: "linked/items",
      url: "https://api.warframe.market/v2/items",
      capturedAt,
      upstreamRevision: createHash("sha256").update(JSON.stringify(linked)).digest("hex"),
      transformer: "warframe-datasource-nnm/linked-items-projection@1",
      derivedFrom: [I18N_ITEMS, MARKET_ITEMS],
    },
  }];
}

function readRequired(files: DatasetFileInput[], path: string, key: string): JsonObject[] {
  const file = files.find((f) => f.path === path);
  if (!file) throw new Error(`Linked relic projection input is missing: ${path}`);
  const value = JSON.parse(Buffer.isBuffer(file.content) ? file.content.toString("utf8") : file.content) as unknown;
  const records = (value as JsonObject)[key];
  if (!Array.isArray(records)) throw new Error(`Expected ${key} array in ${path}`);
  return records.map((r) => object(r, path));
}

function readJsonArray(files: DatasetFileInput[], path: string): JsonObject[] {
  const file = files.find((f) => f.path === path);
  if (!file) throw new Error(`Linked relic projection input is missing: ${path}`);
  const value = JSON.parse(Buffer.isBuffer(file.content) ? file.content.toString("utf8") : file.content) as unknown;
  if (!Array.isArray(value)) throw new Error(`Expected array in ${path}`);
  return value.map((r) => object(r, path));
}

function object(value: unknown, context: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object`);
  }
  return value as JsonObject;
}

function text(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function number(record: JsonObject, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}
