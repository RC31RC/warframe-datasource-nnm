import { createHash } from "node:crypto";
import type { DatasetFileInput } from "../domain/contracts.js";

type JsonObject = Record<string, unknown>;

const REGIONS_EN = "public-export/en/ExportRegions_en.json";
const REGIONS_ZH = "public-export/zh/ExportRegions_zh.json";
const PLUS_REGIONS = "plus/ExportRegions.json";
const PLUS_MISSION_TYPES = "plus/ExportMissionTypes.json";
const PLUS_FACTIONS = "plus/ExportFactions.json";
const PLUS_SYNDICATES = "plus/ExportSyndicates.json";
const LANG_EN = "languages/en.json";
const LANG_ZH = "languages/zh.json";
const RELIC_EN = "public-export/en/ExportRelicArcane_en.json";
const RELIC_ZH = "public-export/zh/ExportRelicArcane_zh.json";

/**
 * WorldState 代码簿投影：产出解析 worldState.php 动态快照所需的静态映射。
 *
 * worldState.php（动态数据，NnmBot 运行时拉取）返回的是内部键（MT_SURVIVAL / FC_GRINEER /
 * SolNode94 / CrewBattleNode559 等），本投影把这些内部键映射为可读名（含中英），供消费者解析。
 *
 * 来源（均一手）：
 * - 节点名：官方 ExportRegions（269 节点直接给 name）+ Plus ExportRegions（354 节点，
 *   含 CrewBattleNode/Hub/ClanNode 特殊节点，name 指向 /Lotus/Language/ 路径）。
 * - 任务类型/派系/辛迪加：Plus ExportMissionTypes/Factions/Syndicates（内部键 → 语言 key）。
 * - 语言文本：warframe-languages-bin-data（Pluto 提取的游戏内语言字符串，en/zh）。
 *
 * 节点深度增强（自 Plus ExportRegions 一手字段）：
 * - 内联可读名：missionTypeName(±Zh)/factionName(±Zh)/secondaryFactionName(±Zh)，消费者无需二次 join。
 * - 玩法元数据：minEnemyLevel/maxEnemyLevel（敌人等级区间）、masteryReq（精通段位要求）、
 *   nodeType（节点类型枚举）、systemIndex（星系索引）、hidden（是否隐藏）、tileset（图块集）、
 *   nextNodes（相邻节点，用于星图邻接遍历）、questReq（前置任务）。
 *
 * nodeType 枚举含义（由 Plus ExportRegions 数据推断）：
 *   0 = 普通星图节点（SolNode/SettlementNode/CrewBattleNode）
 *   1 = 特殊节点（Railjack 等）
 *   2 = PvP 节点（Conclave）
 *   3 = 中继站/Hub（Cetus/Deimos/Zariman 等开放世界城镇）
 *   4 = 氏族道场（ClanNode）
 *   6 = 特殊节点
 *   7 = 星图枢纽（Junction）
 */
export function projectWorldstateCodebook(
  publicExportFiles: DatasetFileInput[],
  plusFiles: DatasetFileInput[],
  languagesFiles: DatasetFileInput[],
): DatasetFileInput[] {
  const regionsEn = readArray(publicExportFiles, REGIONS_EN, "ExportRegions");
  const regionsZh = readArray(publicExportFiles, REGIONS_ZH, "ExportRegions");
  const plusRegions = readObject(plusFiles, PLUS_REGIONS);
  const plusMissionTypes = readObject(plusFiles, PLUS_MISSION_TYPES);
  const plusFactions = readObject(plusFiles, PLUS_FACTIONS);
  const plusSyndicates = readObject(plusFiles, PLUS_SYNDICATES);
  const langEn = readLanguages(languagesFiles, LANG_EN);
  const langZh = readLanguages(languagesFiles, LANG_ZH);

  // 官方节点：uniqueName -> { name, nameZh, systemName, systemNameZh }
  const officialNodes = new Map<string, JsonObject>();
  for (const record of regionsEn) {
    const uniqueName = text(record, "uniqueName");
    if (!uniqueName) continue;
    officialNodes.set(uniqueName, {
      name: text(record, "name") ?? "",
      systemName: text(record, "systemName") ?? "",
    });
  }
  for (const record of regionsZh) {
    const uniqueName = text(record, "uniqueName");
    if (!uniqueName) continue;
    const existing = officialNodes.get(uniqueName);
    if (existing) {
      existing.nameZh = text(record, "name") ?? "";
      existing.systemNameZh = text(record, "systemName") ?? "";
    }
  }

  // 任务类型：MT_* -> 名称（先构建，供节点内联可读名）。
  const missionTypes: Record<string, JsonObject> = {};
  for (const [key, rawValue] of Object.entries(plusMissionTypes)) {
    const value = asObject(rawValue, `mission type ${key}`);
    const nameKey = text(value, "name") ?? "";
    missionTypes[key] = { name: translate(nameKey, langEn), nameZh: translate(nameKey, langZh) };
  }

  // 派系：FC_* -> 名称（先构建，供节点内联可读名）。
  const factions: Record<string, JsonObject> = {};
  for (const [key, rawValue] of Object.entries(plusFactions)) {
    const value = asObject(rawValue, `faction ${key}`);
    const nameKey = text(value, "name") ?? "";
    factions[key] = { name: translate(nameKey, langEn), nameZh: translate(nameKey, langZh) };
  }

  // 辛迪加：键 -> 名称。
  const syndicates: Record<string, JsonObject> = {};
  for (const [key, rawValue] of Object.entries(plusSyndicates)) {
    const value = asObject(rawValue, `syndicate ${key}`);
    const nameKey = text(value, "name") ?? "";
    const entry: JsonObject = { name: translate(nameKey, langEn), nameZh: translate(nameKey, langZh) };
    if (text(value, "uniqueName")) entry.uniqueName = text(value, "uniqueName");
    syndicates[key] = entry;
  }

  // 节点：以 Plus 更全的节点集合为底，官方有 name 的用官方，特殊节点用语言表翻译。
  // 内联 missionType/faction/secondaryFaction 的可读名，并提取玩法元数据。
  const nodes: Record<string, JsonObject> = {};
  for (const [nodeId, rawNode] of Object.entries(plusRegions)) {
    const node = asObject(rawNode, `node ${nodeId}`);
    const official = officialNodes.get(nodeId);
    const nameKey = text(node, "name") ?? "";
    const systemKey = text(node, "systemName") ?? "";
    const missionNameKey = text(node, "missionName") ?? "";
    const missionType = text(node, "missionType");
    const faction = text(node, "faction");
    const secondaryFaction = text(node, "secondaryFaction");

    const entry: JsonObject = {
      name: (official?.name as string | undefined) ?? translate(nameKey, langEn),
      nameZh: (official?.nameZh as string | undefined) ?? translate(nameKey, langZh),
    };
    if (systemKey) {
      entry.systemName = (official?.systemName as string | undefined) ?? translate(systemKey, langEn);
      entry.systemNameZh = (official?.systemNameZh as string | undefined) ?? translate(systemKey, langZh);
    }
    if (missionType) {
      entry.missionType = missionType;
      if (missionTypes[missionType]?.name) entry.missionTypeName = missionTypes[missionType].name;
      if (missionTypes[missionType]?.nameZh) entry.missionTypeNameZh = missionTypes[missionType].nameZh;
    }
    if (missionNameKey) {
      entry.missionName = translate(missionNameKey, langEn);
      entry.missionNameZh = translate(missionNameKey, langZh);
    }
    if (faction) {
      entry.faction = faction;
      if (factions[faction]?.name) entry.factionName = factions[faction].name;
      if (factions[faction]?.nameZh) entry.factionNameZh = factions[faction].nameZh;
    }
    if (secondaryFaction) {
      entry.secondaryFaction = secondaryFaction;
      if (factions[secondaryFaction]?.name) entry.secondaryFactionName = factions[secondaryFaction].name;
      if (factions[secondaryFaction]?.nameZh) entry.secondaryFactionNameZh = factions[secondaryFaction].nameZh;
    }

    const minEnemyLevel = number(node, "minEnemyLevel");
    if (minEnemyLevel !== undefined) entry.minEnemyLevel = minEnemyLevel;
    const maxEnemyLevel = number(node, "maxEnemyLevel");
    if (maxEnemyLevel !== undefined) entry.maxEnemyLevel = maxEnemyLevel;
    const masteryReq = number(node, "masteryReq");
    if (masteryReq !== undefined) entry.masteryReq = masteryReq;
    const nodeType = number(node, "nodeType");
    if (nodeType !== undefined) entry.nodeType = nodeType;
    const systemIndex = number(node, "systemIndex");
    if (systemIndex !== undefined) entry.systemIndex = systemIndex;
    if (trueFlag(node, "hidden")) entry.hidden = true;
    const tileset = text(node, "tileset");
    if (tileset) entry.tileset = tileset;
    const nextNodes = stringArray(node, "nextNodes");
    if (nextNodes) entry.nextNodes = nextNodes;
    const questReq = text(node, "questReq");
    if (questReq) entry.questReq = questReq;

    nodes[nodeId] = entry;
  }

  // 裂缝 modifier：VoidT1~T5 由官方遗物 uniqueName 前缀 T1~T5 推导（Lith/Meso/Neo/Axi/Requiem）。
  // VoidT6 = Omnia（全能）裂缝：允许使用任意遗物的特殊裂缝，不对应单一遗物 tier，故用固定映射。
  const relicEn = readArray(publicExportFiles, RELIC_EN, "ExportRelicArcane");
  const relicZh = readArray(publicExportFiles, RELIC_ZH, "ExportRelicArcane");
  const fissureModifiers: Record<string, JsonObject> = {};
  const tierNameEn = relicTierNames(relicEn);
  const tierNameZh = relicTierNames(relicZh);
  for (let tier = 1; tier <= 5; tier += 1) {
    const tierKey = `T${tier}`;
    fissureModifiers[`VoidT${tier}`] = {
      name: tierNameEn.get(tierKey) ?? "",
      nameZh: tierNameZh.get(tierKey) ?? "",
      tier,
    };
  }
  fissureModifiers.VoidT6 = { name: "Omnia", nameZh: "全能", tier: 6 };

  // 星系索引：官方 ExportRegions 的 systemIndex → systemName（服务 worldState.php PersistentEnemies[].Region）。
  const regions: Record<string, JsonObject> = {};
  const regionNameEn = new Map<number, string>();
  const regionNameZh = new Map<number, string>();
  for (const record of regionsEn) {
    const index = number(record, "systemIndex");
    const name = text(record, "systemName");
    if (index !== undefined && name && !regionNameEn.has(index)) regionNameEn.set(index, name);
  }
  for (const record of regionsZh) {
    const index = number(record, "systemIndex");
    const name = text(record, "systemName");
    if (index !== undefined && name && !regionNameZh.has(index)) regionNameZh.set(index, name);
  }
  for (const [index, name] of regionNameEn) {
    regions[String(index)] = { name, nameZh: regionNameZh.get(index) ?? "" };
  }

  // 升级类型：GAMEPLAY_* → 中英名（服务 worldState.php GlobalUpgrades[].operationType）。
  const upgradeTypes: Record<string, JsonObject> = {};
  for (const [key, name] of Object.entries(langEn)) {
    const match = /^\/Lotus\/Language\/Labels\/(GAMEPLAY_[A-Za-z0-9_]+)$/u.exec(key);
    if (!match || !match[1]) continue;
    upgradeTypes[match[1]] = { name, nameZh: langZh[key] ?? "" };
  }

  const capturedAt = plusFiles.find((f) => f.path === PLUS_REGIONS)?.source.capturedAt ?? "";
  const inputs = [
    REGIONS_EN, REGIONS_ZH, PLUS_REGIONS, PLUS_MISSION_TYPES, PLUS_FACTIONS, PLUS_SYNDICATES, LANG_EN, LANG_ZH,
  ];
  const fissureInputs = [RELIC_EN, RELIC_ZH];
  const project = "warframe-datasource-nnm";
  return [
    appendCodebook("worldstate/nodes.json", nodes, Object.keys(nodes).length, inputs, capturedAt, project),
    appendCodebook("worldstate/mission-types.json", missionTypes, Object.keys(missionTypes).length, inputs, capturedAt, project),
    appendCodebook("worldstate/factions.json", factions, Object.keys(factions).length, inputs, capturedAt, project),
    appendCodebook("worldstate/syndicates.json", syndicates, Object.keys(syndicates).length, inputs, capturedAt, project),
    appendCodebook("worldstate/fissure-modifiers.json", fissureModifiers, Object.keys(fissureModifiers).length, fissureInputs, capturedAt, project),
    appendCodebook("worldstate/regions.json", regions, Object.keys(regions).length, inputs, capturedAt, project),
    appendCodebook("worldstate/upgrade-types.json", upgradeTypes, Object.keys(upgradeTypes).length, inputs, capturedAt, project),
  ];
}

/** 从官方遗物 uniqueName（/Lotus/.../Projections/T1VoidProjection...）提取 tier 名（name 首词）。 */
function relicTierNames(relicRecords: JsonObject[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const record of relicRecords) {
    const uniqueName = text(record, "uniqueName");
    const name = text(record, "name");
    if (!uniqueName || !name) continue;
    const match = /\/Projections\/(T\d+)VoidProjection/u.exec(uniqueName);
    if (!match || !match[1]) continue;
    const tierKey = match[1];
    if (result.has(tierKey)) continue;
    result.set(tierKey, name.trim().split(/\s+/u)[0] ?? "");
  }
  return result;
}

function appendCodebook(
  path: string,
  value: Record<string, JsonObject>,
  recordCount: number,
  inputs: string[],
  capturedAt: string,
  project: string,
): DatasetFileInput {
  return {
    stage: "cleaned",
    path,
    content: `${JSON.stringify(value, null, 2)}\n`,
    recordCount,
    source: {
      project,
      dataset: path,
      url: "https://api.warframe.com/cdn/worldState.php",
      capturedAt,
      upstreamRevision: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
      transformer: "warframe-datasource-nnm/worldstate-codebook-projection@1",
      derivedFrom: inputs,
    },
  };
}

/** 把 /Lotus/Language/... 语言 key 翻译成可读名；查不到时回退到 key 本身。 */
function translate(langKey: string, languages: Record<string, string>): string {
  if (!langKey) return "";
  if (!langKey.startsWith("/")) return langKey;
  return languages[langKey] ?? langKey;
}

function readLanguages(files: DatasetFileInput[], path: string): Record<string, string> {
  const file = files.find((f) => f.path === path);
  if (!file) throw new Error(`Worldstate codebook input is missing: ${path}`);
  const value = JSON.parse(Buffer.isBuffer(file.content) ? file.content.toString("utf8") : file.content) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected object in ${path}`);
  }
  return value as Record<string, string>;
}

function readObject(files: DatasetFileInput[], path: string): JsonObject {
  const file = files.find((f) => f.path === path);
  if (!file) throw new Error(`Worldstate codebook input is missing: ${path}`);
  const value = JSON.parse(Buffer.isBuffer(file.content) ? file.content.toString("utf8") : file.content) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected object in ${path}`);
  }
  return value as JsonObject;
}

function readArray(files: DatasetFileInput[], path: string, key: string): JsonObject[] {
  const root = readObject(files, path);
  const records = root[key];
  if (!Array.isArray(records)) throw new Error(`Expected ${key} array in ${path}`);
  return records.map((r) => asObject(r, path));
}

function asObject(value: unknown, context: string): JsonObject {
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

function trueFlag(record: JsonObject, key: string): true | undefined {
  return record[key] === true ? true : undefined;
}

function stringArray(record: JsonObject, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((item): item is string => typeof item === "string");
  return result.length > 0 ? result : undefined;
}
