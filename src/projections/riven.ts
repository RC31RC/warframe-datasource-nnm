import { createHash } from "node:crypto";
import type { JsonValue, DatasetFileInput } from "../domain/contracts.js";

type JsonObject = Record<string, unknown>;

const UPGRADES_INPUT = "public-export/en/ExportUpgrades_en.json";
const UPGRADES_ZH_INPUT = "public-export/zh/ExportUpgrades_zh.json";
const WEAPONS_INPUT = "public-export/en/ExportWeapons_en.json";
const WEAPONS_ZH_INPUT = "public-export/zh/ExportWeapons_zh.json";
const RANDOMIZED_MOD_PREFIX = "/Lotus/Upgrades/Mods/Randomized/";
const LANG_EN = "languages/en.json";
const LANG_ZH = "languages/zh.json";

/**
 * Project official Public Export fields into riven datasets:
 * - riven/definitions.json: the randomized riven mods' upgradeEntries (词条)
 *   and availableChallenges (挑战) from ExportUpgrades.
 * - riven/disposition.json: each weapon's current disposition from the
 *   omegaAttenuation field in ExportWeapons / ExportRailjackWeapons.
 *
 * Both are official values; internal fields are preserved rather than dropped.
 * 官方 Export 的 locTag / description 恒为英文模板（中文 Export 里也一样，不是本地化字段），
 * 故额外用 languages-bin-data 反查补 nameZh / locTagZh / descriptionZh（英文值 → 语言 key → 中文）。
 */
export function projectRiven(
  rawFiles: DatasetFileInput[],
  languagesFiles: DatasetFileInput[] = [],
): DatasetFileInput[] {
  const sourceByPath = new Map([...rawFiles, ...languagesFiles].map((file) => [file.path, file]));
  const output: DatasetFileInput[] = [];

  const upgrades = readExport(sourceByPath, UPGRADES_INPUT);
  const zhByUniqueName = readZhUpgradeNames(sourceByPath);
  const translations = buildTranslationLookup(languagesFiles);
  const definitions = requiredArray(upgrades, "ExportUpgrades")
    .filter((record) => Array.isArray(record.upgradeEntries) && Array.isArray(record.availableChallenges))
    .map((record) => {
      const key = record.uniqueName;
      if (typeof key !== "string" || !key.startsWith(RANDOMIZED_MOD_PREFIX)) {
        throw new Error(`Non-riven upgrade carries riven definitions: ${String(key)}`);
      }
      const entry: JsonObject = { ...record, recordKey: key };
      const nameZh = zhByUniqueName.get(key);
      if (nameZh) entry.nameZh = nameZh;
      entry.upgradeEntries = localizeEntries(record.upgradeEntries, translations);
      entry.availableChallenges = localizeChallenges(record.availableChallenges, translations);
      return entry;
    });
  if (definitions.length === 0) {
    throw new Error("ExportUpgrades contains no randomized riven mod definitions");
  }
  const definitionInputs = [UPGRADES_INPUT, UPGRADES_ZH_INPUT, LANG_EN, LANG_ZH]
    .filter((inputPath) => sourceByPath.has(inputPath));
  appendArrayProjection(output, sourceByPath, "riven/definitions.json", definitions, definitionInputs);

  const weapons = readExport(sourceByPath, WEAPONS_INPUT);
  const zhWeaponNames = readZhNames(sourceByPath, WEAPONS_ZH_INPUT);
  const dispositionSources: Array<{ records: JsonObject[]; input: string }> = [
    { records: requiredArray(weapons, "ExportWeapons"), input: WEAPONS_INPUT },
  ];
  if (weapons.ExportRailjackWeapons !== undefined) {
    dispositionSources.push({
      records: requiredArray(weapons, "ExportRailjackWeapons"),
      input: WEAPONS_INPUT,
    });
  }
  const dispositions = new Map<string, JsonObject>();
  for (const source of dispositionSources) {
    for (const record of source.records) {
      const uniqueName = typeof record.uniqueName === "string" ? record.uniqueName : undefined;
      if (!uniqueName?.startsWith("/")) continue;
      if (typeof record.omegaAttenuation !== "number") continue;
      const entry: JsonObject = {
        uniqueName,
        name: typeof record.name === "string" ? record.name : uniqueName,
        disposition: record.omegaAttenuation,
      };
      const nameZh = zhWeaponNames.get(uniqueName);
      if (nameZh) entry.nameZh = nameZh;
      if (typeof record.primeOmegaAttenuation === "number") {
        entry.primeDisposition = record.primeOmegaAttenuation;
      }
      const previous = dispositions.get(uniqueName);
      if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) {
        throw new Error(`Conflicting riven disposition: ${uniqueName}`);
      }
      dispositions.set(uniqueName, previous ?? entry);
    }
  }
  if (dispositions.size === 0) {
    throw new Error("ExportWeapons contains no riven disposition values");
  }
  const dispositionRecords = [...dispositions.values()].map((entry) => ({
    ...entry,
    recordKey: entry.uniqueName,
  }));
  appendArrayProjection(output, sourceByPath, "riven/disposition.json", dispositionRecords, [WEAPONS_INPUT]);

  return output;
}

/** 读 zh ExportUpgrades，返回紫卡 Mod 的 uniqueName → 中文名。 */
function readZhUpgradeNames(sourceByPath: Map<string, DatasetFileInput>): Map<string, string> {
  const result = new Map<string, string>();
  const zh = sourceByPath.get(UPGRADES_ZH_INPUT);
  if (!zh) return result;
  const root = JSON.parse(Buffer.isBuffer(zh.content) ? zh.content.toString("utf8") : zh.content) as JsonObject;
  for (const record of requiredArray(root, "ExportUpgrades")) {
    const uniqueName = record.uniqueName;
    const name = record.name;
    if (typeof uniqueName === "string" && typeof name === "string" && name !== "") {
      result.set(uniqueName, name);
    }
  }
  return result;
}

/** 读取 zh 版本官方 Export 的 uniqueName → 中文名。 */
function readZhNames(sourceByPath: Map<string, DatasetFileInput>, path: string): Map<string, string> {
  const result = new Map<string, string>();
  const zh = sourceByPath.get(path);
  if (!zh) return result;
  const root = JSON.parse(Buffer.isBuffer(zh.content) ? zh.content.toString("utf8") : zh.content) as JsonObject;
  for (const value of Object.values(root)) {
    if (!Array.isArray(value)) continue;
    for (const record of value) {
      const uniqueName = (record as JsonObject).uniqueName;
      const name = (record as JsonObject).name;
      if (typeof uniqueName === "string" && typeof name === "string" && name !== "") {
        result.set(uniqueName, name);
      }
    }
  }
  return result;
}

/** 构建「英文文本 → 中文文本」反查（languages-bin-data 的 en 值反查 key，再取 zh 值）。 */
function buildTranslationLookup(languagesFiles: DatasetFileInput[]): Map<string, string> {
  const lookup = new Map<string, string>();
  const en = readLanguagesMap(languagesFiles, LANG_EN);
  const zh = readLanguagesMap(languagesFiles, LANG_ZH);
  if (!en || !zh) return lookup;
  for (const [key, enValue] of Object.entries(en)) {
    if (typeof enValue !== "string" || enValue === "" || lookup.has(enValue)) continue;
    const zhValue = zh[key];
    if (typeof zhValue === "string" && zhValue !== "") lookup.set(enValue, zhValue);
  }
  return lookup;
}

function readLanguagesMap(files: DatasetFileInput[], path: string): Record<string, string> | undefined {
  const file = files.find((item) => item.path === path);
  if (!file) return undefined;
  const value = JSON.parse(Buffer.isBuffer(file.content) ? file.content.toString("utf8") : file.content) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, string>;
}

/** 词条本地化：保留原始 locTag，追加 locTagZh。 */
function localizeEntries(entries: unknown, translations: Map<string, string>): JsonObject[] {
  return arrayOf(entries).map((rawEntry) => {
    const entry = object(rawEntry, "upgradeEntry");
    const next: JsonObject = { ...entry };
    if (Array.isArray(entry.upgradeValues)) {
      next.upgradeValues = entry.upgradeValues.map((rawValue) => {
        const value = object(rawValue, "upgradeValue");
        const locTag = value.locTag;
        const zh = typeof locTag === "string" ? translations.get(locTag) : undefined;
        return zh ? { ...value, locTagZh: zh } : { ...value };
      });
    }
    return next;
  });
}

/** 挑战本地化：description 与 complications[].description 追加中文。 */
function localizeChallenges(challenges: unknown, translations: Map<string, string>): JsonObject[] {
  return arrayOf(challenges).map((rawChallenge) => {
    const challenge = object(rawChallenge, "challenge");
    const next: JsonObject = { ...challenge };
    const description = challenge.description;
    const descriptionZh = typeof description === "string" ? translations.get(description) : undefined;
    if (descriptionZh) next.descriptionZh = descriptionZh;
    if (Array.isArray(challenge.complications)) {
      next.complications = challenge.complications.map((rawComplication) => {
        const complication = object(rawComplication, "complication");
        const desc = complication.description;
        const zh = typeof desc === "string" ? translations.get(desc) : undefined;
        return zh ? { ...complication, descriptionZh: zh } : { ...complication };
      });
    }
    return next;
  });
}

function arrayOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected an array");
  return value;
}

function appendArrayProjection(
  output: DatasetFileInput[],
  sourceByPath: Map<string, DatasetFileInput>,
  path: string,
  records: JsonObject[],
  inputs: string[],
): void {
  const inputSources = inputs.map((inputPath) => {
    const input = sourceByPath.get(inputPath);
    if (!input) throw new Error(`Riven projection input is missing: ${inputPath}`);
    return input;
  });
  const primary = inputSources[0]?.source;
  if (!primary) throw new Error(`Riven projection ${path} has no source metadata`);
  output.push({
    stage: "cleaned",
    path,
    content: `${JSON.stringify(records, null, 2)}\n`,
    recordCount: records.length,
    source: {
      ...primary,
      dataset: path,
      upstreamRevision: createHash("sha256").update(inputSources
        .map((source) => `${source.path}:${source.source.upstreamRevision ?? ""}`).join("\n")).digest("hex"),
      transformer: "warframe-datasource-nnm/riven-projection@1",
      derivedFrom: inputs,
    },
  });
}

function readExport(sourceByPath: Map<string, DatasetFileInput>, path: string): JsonObject {
  const source = sourceByPath.get(path);
  if (!source) throw new Error(`Riven projection input is missing: ${path}`);
  try {
    return object(JSON.parse(Buffer.isBuffer(source.content) ? source.content.toString("utf8") : source.content) as unknown, path);
  } catch (error) {
    throw new Error(`Riven projection input is invalid JSON: ${path}`, { cause: error });
  }
}

function requiredArray(root: JsonObject, key: string): JsonObject[] {
  const value = root[key];
  if (!Array.isArray(value)) throw new Error(`Expected ${key} to be an array`);
  return value.map((record, index) => object(record, `${key}[${index}]`));
}

function object(value: unknown, context: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object`);
  }
  return value as JsonObject;
}
