import { createHash } from "node:crypto";
import type { DatasetFileInput } from "../domain/contracts.js";

type JsonObject = Record<string, unknown>;

const REGIONS_EN = "public-export/en/ExportRegions_en.json";
const REGIONS_ZH = "public-export/zh/ExportRegions_zh.json";
const PLUS_REGIONS = "plus/ExportRegions.json";
const PLUS_SYSTEMS = "plus/ExportSystems.json";
const PLUS_MISSION_TYPES = "plus/ExportMissionTypes.json";
const PLUS_FACTIONS = "plus/ExportFactions.json";
const PLUS_SYNDICATES = "plus/ExportSyndicates.json";
const LANG_EN = "languages/en.json";
const LANG_ZH = "languages/zh.json";
const RELIC_EN = "public-export/en/ExportRelicArcane_en.json";
const RELIC_ZH = "public-export/zh/ExportRelicArcane_zh.json";
const LOCALES = ["en", "de", "es", "fr", "it", "ja", "ko", "pl", "pt", "ru", "tc", "th", "tr", "uk", "zh"] as const;

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
  const plusSystems = readArray(plusFiles, PLUS_SYSTEMS);
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
    const name = translate(nameKey, langEn);
    missionTypes[key] = {
      ...value,
      ...(nameKey ? { nameKey } : {}),
      name,
      nameEn: name,
      nameZh: translate(nameKey, langZh),
    };
  }

  // 派系：FC_* -> 名称（先构建，供节点内联可读名）。
  const factions: Record<string, JsonObject> = {};
  for (const [key, rawValue] of Object.entries(plusFactions)) {
    const value = asObject(rawValue, `faction ${key}`);
    const nameKey = text(value, "name") ?? "";
    const name = translate(nameKey, langEn);
    factions[key] = {
      ...value,
      ...(nameKey ? { nameKey } : {}),
      name,
      nameEn: name,
      nameZh: translate(nameKey, langZh),
    };
  }

  // 辛迪加：键 -> 名称。
  const syndicates: Record<string, JsonObject> = {};
  for (const [key, rawValue] of Object.entries(plusSyndicates)) {
    const value = asObject(rawValue, `syndicate ${key}`);
    const nameKey = text(value, "name") ?? "";
    const name = translate(nameKey, langEn);
    syndicates[key] = {
      ...value,
      ...(nameKey ? { nameKey } : {}),
      name,
      nameEn: name,
      nameZh: translate(nameKey, langZh),
    };
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
      ...node,
      ...(nameKey ? { nameKey } : {}),
      ...(systemKey ? { systemNameKey: systemKey } : {}),
      ...(missionNameKey ? { missionNameKey } : {}),
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
      entry.missionNameEn = translate(missionNameKey, langEn);
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

  const worldMap = buildWorldMap(nodes, publicExportFiles, plusSystems, langEn, langZh);

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

  // 升级类型：GAMEPLAY_* → 中英名（服务 worldState.php GlobalUpgrades[].operationType）。
  const upgradeTypes: Record<string, JsonObject> = {};
  for (const [key, name] of Object.entries(langEn)) {
    const match = /^\/Lotus\/Language\/Labels\/(GAMEPLAY_[A-Za-z0-9_]+)$/u.exec(key);
    if (!match || !match[1]) continue;
    upgradeTypes[match[1]] = { name, nameZh: langZh[key] ?? "" };
  }

  // PHP boss tokens and client localization share the explicit Archon identifier.
  const bosses: Record<string, JsonObject> = {};
  for (const [key, name] of Object.entries(langEn)) {
    const suffix = /^\/Lotus\/Language\/Narmer\/Archon(Amar|Boreal|Nira)$/u.exec(key)?.[1];
    if (!suffix) continue;
    const variants = ["", "Mythic"].map((variant) => {
      const nameKey = `/Lotus/Language/Narmer/ArchonCrystal${suffix}${variant}NameNoIcon`;
      return { nameKey, nameEn: langEn[nameKey] ?? "", nameZh: langZh[nameKey] ?? "", tauforged: !!variant };
    });
    bosses[`SORTIE_BOSS_${suffix.toUpperCase()}`] = { nameKey: key, name, nameEn: name, nameZh: langZh[key] ?? "", shardCategory: { variants, selection: "account_and_reward_rules_required" } };
  }

  const capturedAt = plusFiles.find((f) => f.path === PLUS_REGIONS)?.source.capturedAt ?? "";
  const inputs = [
    REGIONS_EN, REGIONS_ZH, PLUS_REGIONS, PLUS_MISSION_TYPES, PLUS_FACTIONS, PLUS_SYNDICATES, LANG_EN, LANG_ZH,
  ];
  const fissureInputs = [RELIC_EN, RELIC_ZH];
  const project = "warframe-datasource-nnm";
  return [
    appendWorldMap(worldMap, Object.keys(nodes).length, publicExportFiles, plusFiles, languagesFiles),
    appendCodebook("worldstate/mission-types.json", missionTypes, Object.keys(missionTypes).length, inputs, capturedAt, project),
    appendCodebook("worldstate/factions.json", factions, Object.keys(factions).length, inputs, capturedAt, project),
    appendCodebook("worldstate/syndicates.json", syndicates, Object.keys(syndicates).length, inputs, capturedAt, project),
    appendCodebook("worldstate/fissure-modifiers.json", fissureModifiers, Object.keys(fissureModifiers).length, fissureInputs, capturedAt, project),
    appendCodebook("worldstate/bosses.json", bosses, Object.keys(bosses).length, [LANG_EN, LANG_ZH], capturedAt, project),
    appendCodebook("worldstate/upgrade-types.json", upgradeTypes, Object.keys(upgradeTypes).length, inputs, capturedAt, project),
  ];
}

function buildWorldMap(
  nodes: Record<string, JsonObject>,
  publicExportFiles: DatasetFileInput[],
  plusSystems: JsonObject[],
  langEn: Record<string, string>,
  langZh: Record<string, string>,
): JsonObject {
  const localizedByNode = new Map<string, Map<string, JsonObject>>();
  const itemDetails = readPublicResourceDetails(publicExportFiles);
  for (const locale of LOCALES) {
    const path = `public-export/${locale}/ExportRegions_${locale}.json`;
    const file = publicExportFiles.find((candidate) => candidate.path === path);
    if (!file) continue;
    const root = parseObject(file);
    const records = root.ExportRegions;
    if (!Array.isArray(records)) throw new Error(`Expected ExportRegions array in ${path}`);
    for (const raw of records) {
      const record = asObject(raw, path);
      const nodeKey = text(record, "uniqueName");
      if (!nodeKey) continue;
      const locales = localizedByNode.get(nodeKey) ?? new Map<string, JsonObject>();
      if (locales.has(locale)) throw new Error(`Duplicate localized world node ${nodeKey}/${locale}`);
      locales.set(locale, record);
      localizedByNode.set(nodeKey, locales);
    }
  }

  const systems = new Map<number, JsonObject & { nodes: JsonObject[]; translations: Record<string, JsonObject> }>();
  const systemNameCandidates = new Map<number, Map<string, Map<string, number>>>();
  for (const rawSystem of plusSystems) {
    const systemIndex = number(rawSystem, "index");
    const nameKey = text(rawSystem, "name");
    if (systemIndex === undefined || !nameKey) throw new Error("Plus system lacks index or name key");
    if (systems.has(systemIndex)) throw new Error(`Duplicate Plus system index ${systemIndex}`);
    const en = translate(nameKey, langEn);
    const zh = translate(nameKey, langZh);
    const resourceDrops = Array.isArray(rawSystem.resources)
      ? rawSystem.resources.map((rawResource, index) => {
        const resource = asObject(rawResource, `Plus system ${systemIndex}/resources[${index}]`);
        const storeItem = text(resource, "StoreItem") ?? "";
        const itemType = text(resource, "ItemType") ?? "";
        const uniqueName = storeItem || itemType;
        const details = itemDetails.get(canonicalItemPath(uniqueName));
        return {
          ...resource,
          item: {
            uniqueName,
            name: details?.name ?? "",
            nameZh: details?.nameZh ?? "",
            ...(details?.iconUrl ? { iconUrl: details.iconUrl } : {}),
            resolution: details?.name || details?.nameZh ? "localized" : "identity_only",
          },
        };
      })
      : [];
    systems.set(systemIndex, {
      ...rawSystem,
      systemIndex,
      name: en,
      nameZh: zh,
      resources: resourceDrops,
      translations: {
        en: { name: en },
        zh: { name: zh },
      },
      nodes: [],
    });
  }
  for (const [nodeKey, node] of Object.entries(nodes)) {
    const systemIndex = number(node, "systemIndex");
    if (systemIndex === undefined) throw new Error(`WorldState node ${nodeKey} lacks systemIndex`);
    const system = systems.get(systemIndex) ?? {
      systemIndex,
      name: text(node, "systemName") ?? "",
      nameZh: text(node, "systemNameZh") ?? "",
      translations: {},
      nodes: [],
    };
    const translations: Record<string, JsonObject> = {};
    for (const locale of LOCALES) {
      const record = localizedByNode.get(nodeKey)?.get(locale);
      const localizedName = text(record ?? {}, "name");
      const localizedSystemName = text(record ?? {}, "systemName");
      const fallbackName = locale === "en" ? text(node, "name")
        : locale === "zh" ? text(node, "nameZh") : undefined;
      const fallbackSystem = locale === "en" ? text(node, "systemName")
        : locale === "zh" ? text(node, "systemNameZh") : undefined;
      const translation: JsonObject = {};
      const name = localizedName ?? fallbackName;
      const systemName = localizedSystemName ?? fallbackSystem;
      if (name) translation.name = name;
      if (systemName) translation.systemName = systemName;
      if (Object.keys(translation).length > 0) translations[locale] = translation;
      if (systemName) {
        const locales = systemNameCandidates.get(systemIndex) ?? new Map<string, Map<string, number>>();
        const names = locales.get(locale) ?? new Map<string, number>();
        names.set(systemName, (names.get(systemName) ?? 0) + 1);
        locales.set(locale, names);
        systemNameCandidates.set(systemIndex, locales);
      }
    }
    const enrichedNode: JsonObject = {
      nodeKey,
      uniqueName: nodeKey,
      ...node,
      translations,
    };
    system.nodes.push(enrichedNode);
    // Parent systems come from ExportSystems; node labels may describe a Proxima subregion.
    // Missing parent names are resolved below by the stable majority across nodes.
    systems.set(systemIndex, system);
  }

  const orderedSystems = [...systems.values()].sort((left, right) =>
    Number(left.systemIndex) - Number(right.systemIndex),
  );
  for (const system of orderedSystems) {
    const index = Number(system.systemIndex);
    for (const [locale, names] of systemNameCandidates.get(index) ?? []) {
      const name = selectMostCommonName(names);
      if (!name) continue;
      if (!system.translations[locale]?.name) system.translations[locale] = { name };
      if (locale === "en" && !system.name) system.name = name;
      if (locale === "zh" && !system.nameZh) system.nameZh = name;
    }
    system.nodes.sort((left, right) => compareText(String(left.nodeKey), String(right.nodeKey)));
  }
  return {
    systems: orderedSystems,
    nodeCount: Object.keys(nodes).length,
    systemCount: orderedSystems.length,
  };
}

function readPublicResourceDetails(publicExportFiles: DatasetFileInput[]): Map<string, JsonObject> {
  const details = new Map<string, JsonObject>();
  for (const locale of ["en", "zh"] as const) {
    const path = `public-export/${locale}/ExportResources_${locale}.json`;
    const file = publicExportFiles.find((candidate) => candidate.path === path);
    if (!file) continue;
    const root = parseObject(file);
    const records = root.ExportResources;
    if (!Array.isArray(records)) throw new Error(`Expected ExportResources array in ${path}`);
    for (const raw of records) {
      const record = asObject(raw, path);
      const uniqueName = text(record, "uniqueName");
      if (!uniqueName) continue;
      const key = canonicalItemPath(uniqueName);
      const item = details.get(key) ?? {};
      const name = text(record, "name");
      if (name) item[locale === "en" ? "name" : "nameZh"] = name;
      details.set(key, item);
    }
  }

  const manifestFile = publicExportFiles.find((candidate) => candidate.path === "public-export/shared/ExportManifest.json");
  if (manifestFile) {
    const manifest = parseObject(manifestFile).Manifest;
    if (Array.isArray(manifest)) {
      for (const raw of manifest) {
        const record = asObject(raw, manifestFile.path);
        const uniqueName = text(record, "uniqueName");
        const textureLocation = text(record, "textureLocation");
        if (!uniqueName || !textureLocation) continue;
        const item = details.get(canonicalItemPath(uniqueName));
        if (item) item.iconUrl = `https://content.warframe.com/PublicExport/${textureLocation.replace(/^\//u, "")}`;
      }
    }
  }
  return details;
}

function canonicalItemPath(uniqueName: string): string {
  return uniqueName.replace("/Lotus/StoreItems/", "/Lotus/");
}

function selectMostCommonName(names: Map<string, number>): string | undefined {
  return [...names].sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))[0]?.[0];
}

function appendWorldMap(
  value: JsonObject,
  nodeCount: number,
  publicExportFiles: DatasetFileInput[],
  plusFiles: DatasetFileInput[],
  languagesFiles: DatasetFileInput[],
): DatasetFileInput {
  const paths = [
    ...LOCALES.flatMap((locale) => [
      `public-export/${locale}/ExportRegions_${locale}.json`,
      ...(locale === "en" || locale === "zh" ? [`public-export/${locale}/ExportResources_${locale}.json`] : []),
    ]).filter((path) => publicExportFiles.some((file) => file.path === path)),
    ...(publicExportFiles.some((file) => file.path === "public-export/shared/ExportManifest.json")
      ? ["public-export/shared/ExportManifest.json"] : []),
    PLUS_REGIONS,
    PLUS_SYSTEMS,
    PLUS_MISSION_TYPES,
    PLUS_FACTIONS,
    PLUS_SYNDICATES,
    LANG_EN,
    LANG_ZH,
  ];
  const inputFiles = paths.map((path) => findFile(path, [...publicExportFiles, ...plusFiles, ...languagesFiles]));
  const capturedAt = inputFiles[0]?.source.capturedAt ?? "";
  const path = "catalog/world/map.json";
  return {
    stage: "cleaned",
    path,
    content: `${JSON.stringify(value, null, 2)}\n`,
    recordCount: nodeCount,
    source: {
      project: "warframe-datasource-nnm",
      dataset: path,
      url: "https://content.warframe.com/PublicExport/Manifest",
      capturedAt,
      upstreamRevision: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
      transformer: "warframe-datasource-nnm/world-map-projection@2",
      derivedFrom: paths,
    },
  };
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

function parseObject(file: DatasetFileInput): JsonObject {
  const value = JSON.parse(Buffer.isBuffer(file.content) ? file.content.toString("utf8") : file.content) as unknown;
  return asObject(value, file.path);
}

function findFile(path: string, files: DatasetFileInput[]): DatasetFileInput {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Worldstate codebook input is missing: ${path}`);
  return file;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

function readArray(files: DatasetFileInput[], path: string, key: string): JsonObject[];
function readArray(files: DatasetFileInput[], path: string): JsonObject[];
function readArray(files: DatasetFileInput[], path: string, key?: string): JsonObject[] {
  const file = files.find((f) => f.path === path);
  if (!file) throw new Error(`Worldstate codebook input is missing: ${path}`);
  const value = JSON.parse(Buffer.isBuffer(file.content) ? file.content.toString("utf8") : file.content) as unknown;
  const records = key === undefined ? value : asObject(value, path)[key];
  if (!Array.isArray(records)) throw new Error(`Expected ${key ?? "top-level"} array in ${path}`);
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
