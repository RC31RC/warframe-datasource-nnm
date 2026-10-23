import { createHash } from "node:crypto";
import type { DatasetFileInput } from "../domain/contracts.js";

type JsonObject = Record<string, unknown>;
type Weapon = {
  uniqueName: string;
  name: string;
  nameZh: string;
  disposition?: number;
  marketListings: JsonObject[];
  weeklyByPlatform: Record<string, JsonObject[]>;
};

const DISPOSITION_PATH = "riven/disposition.json";
const MARKET_WEAPONS_PATH = "market/riven-weapons.json";
const PLATFORMS = ["PC", "PS4", "SWI", "XB1"] as const;
const INPUT_PATHS = [
  "public-export/en/ExportWeapons_en.json",
  "warframe-market/riven-weapons-v2.json",
  ...PLATFORMS.map((platform) => `weekly-rivens/${platform}.txt`),
];

/** Consolidates weapon disposition, Market details, and uniquely matched weekly records. */
export function projectRivenWeapons(files: DatasetFileInput[]): DatasetFileInput[] {
  const dispositions = readArray(files, DISPOSITION_PATH);
  const marketWeapons = readArray(files, MARKET_WEAPONS_PATH);
  const weeklyByPlatform = new Map<string, JsonObject[]>();
  for (const platform of PLATFORMS) weeklyByPlatform.set(platform, readArray(files, `riven/weekly-${platform.toLowerCase()}.json`));

  const weapons = new Map<string, Weapon>();
  const identitiesByName = new Map<string, Set<string>>();
  for (const record of dispositions) {
    const uniqueName = requiredText(record, "uniqueName", DISPOSITION_PATH);
    if (weapons.has(uniqueName)) throw new Error(`Duplicate riven disposition identity: ${uniqueName}`);
    const disposition = number(record, "disposition");
    const weapon: Weapon = {
      uniqueName,
      name: text(record, "name") ?? "",
      nameZh: text(record, "nameZh") ?? "",
      ...(disposition === undefined ? {} : { disposition }),
      marketListings: [],
      weeklyByPlatform: Object.fromEntries(PLATFORMS.map((platform) => [platform, []])),
    };
    weapons.set(uniqueName, weapon);
    addName(identitiesByName, weapon.name, uniqueName);
  }

  const unresolvedMarketWeapons: JsonObject[] = [];
  for (const market of marketWeapons) {
    const gameRef = text(market, "gameRef");
    const name = text(market, "name") ?? text(optionalObject(optionalObject(market.i18n).en), "name") ?? "";
    if (!gameRef) {
      unresolvedMarketWeapons.push({ ...market, resolution: "missing_game_ref" });
      continue;
    }
    let weapon = weapons.get(gameRef);
    if (!weapon) {
      weapon = {
        uniqueName: gameRef,
        name,
        nameZh: text(market, "nameZh") ?? "",
        marketListings: [],
        weeklyByPlatform: Object.fromEntries(PLATFORMS.map((platform) => [platform, []])),
      };
      weapons.set(gameRef, weapon);
      addName(identitiesByName, weapon.name, gameRef);
    }
    weapon.marketListings.push(market);
  }

  const unresolvedWeeklyRows: JsonObject[] = [];
  const categorySummaries: JsonObject[] = [];
  for (const platform of PLATFORMS) {
    for (const record of weeklyByPlatform.get(platform) ?? []) {
      const compatibility = text(record, "compatibility");
      if (!compatibility) {
        categorySummaries.push({ platform, ...record });
        continue;
      }
      const allCandidates = [...(identitiesByName.get(normalize(compatibility)) ?? [])].sort(compareText);
      const ordinary = allCandidates.filter((id) => !/PvPVariant|Doppelganger/u.test(id));
      const candidates = ordinary.length === 1 ? ordinary : allCandidates;
      if (candidates.length !== 1) {
        unresolvedWeeklyRows.push({
          platform,
          ...record,
          resolution: candidates.length > 1 ? "ambiguous_weapon_name" : "unresolved_weapon_name",
          ...(candidates.length > 1 ? { candidateUniqueNames: candidates } : {}),
        });
        continue;
      }
      const weapon = weapons.get(candidates[0] as string);
      if (!weapon) throw new Error(`Missing riven weapon ${candidates[0]}`);
      weapon.weeklyByPlatform[platform]?.push(record);
    }
  }

  const orderedWeapons = [...weapons.values()].sort((left, right) => compareText(left.uniqueName, right.uniqueName));
  for (const weapon of orderedWeapons) {
    for (const rows of Object.values(weapon.weeklyByPlatform)) {
      rows.sort((left, right) => compareText(String(left.itemType ?? ""), String(right.itemType ?? ""))
        || Number(Boolean(left.rerolled)) - Number(Boolean(right.rerolled)));
    }
    weapon.marketListings.sort((left, right) => compareText(String(left.slug ?? ""), String(right.slug ?? "")));
  }

  const unresolvedMarketPathCount = unresolvedMarketWeapons.length;
  const marketListingsWithDisposition = orderedWeapons.reduce((count, weapon) =>
    count + (typeof weapon.disposition === "number" ? weapon.marketListings.length : 0), 0);
  const quality = {
    weaponCount: orderedWeapons.length,
    dispositionCount: dispositions.length,
    marketListingCount: marketWeapons.length,
    marketListingsAttached: marketWeapons.length - unresolvedMarketPathCount,
    marketListingsWithDisposition,
    marketListingsWithoutDisposition: marketWeapons.length - marketListingsWithDisposition,
    unresolvedMarketWeapons: unresolvedMarketPathCount,
    weeklyRows: [...weeklyByPlatform.values()].reduce((count, rows) => count + rows.length, 0),
    weeklyRowsAttached: orderedWeapons.reduce((count, weapon) => count
      + Object.values(weapon.weeklyByPlatform).reduce((sum, rows) => sum + rows.length, 0), 0),
    unresolvedWeeklyRows: unresolvedWeeklyRows.length,
    categorySummaryRows: categorySummaries.length,
  };
  const value = { weapons: orderedWeapons, categorySummaries, unresolvedMarketWeapons, unresolvedWeeklyRows, quality };
  const inputFiles = INPUT_PATHS.map((path) => findFile(files, path, "raw"));
  const first = inputFiles[0];
  if (!first) throw new Error("Riven weapon projection has no input metadata");
  const content = `${JSON.stringify(value, null, 2)}\n`;
  return [{
    stage: "cleaned",
    path: "riven/weapons.json",
    content,
    recordCount: orderedWeapons.length,
    source: {
      ...first.source,
      dataset: "riven/weapons.json",
      upstreamRevision: createHash("sha256").update(content).digest("hex"),
      transformer: "warframe-datasource-nnm/riven-weapon-projection@1",
      derivedFrom: INPUT_PATHS,
    },
  }];
}

function readArray(files: DatasetFileInput[], path: string): JsonObject[] {
  const file = findFile(files, path);
  const value = JSON.parse(asText(file.content)) as unknown;
  if (!Array.isArray(value)) throw new Error(`Expected array in ${path}`);
  return value.map((row, index) => asObject(row, `${path}[${index}]`));
}

function findFile(files: DatasetFileInput[], path: string, stage: DatasetFileInput["stage"] = "cleaned"): DatasetFileInput {
  const file = files.find((candidate) => candidate.path === path && candidate.stage === stage);
  if (!file) throw new Error(`Riven weapon projection input is missing: ${path}`);
  return file;
}

function addName(index: Map<string, Set<string>>, name: string, uniqueName: string): void {
  if (!name) return;
  const key = normalize(name);
  const candidates = index.get(key) ?? new Set<string>();
  candidates.add(uniqueName);
  index.set(key, candidates);
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asObject(value: unknown, context: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as JsonObject;
}

function optionalObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: JsonObject, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] as string : undefined;
}

function number(value: JsonObject, key: string): number | undefined {
  return typeof value[key] === "number" ? value[key] as number : undefined;
}

function requiredText(value: JsonObject, key: string, context: string): string {
  const result = text(value, key);
  if (!result) throw new Error(`${context} lacks ${key}`);
  return result;
}

function asText(content: Buffer | string): string {
  return Buffer.isBuffer(content) ? content.toString("utf8") : content;
}
