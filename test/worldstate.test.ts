import assert from "node:assert/strict";
import { test } from "node:test";
import { projectWorldstateCodebook } from "../src/projections/worldstate.js";
import type { DatasetFileInput, SourceMetadata } from "../src/domain/contracts.js";

const capturedAt = "2026-10-21T00:00:00.000Z";
const source = (dataset: string): SourceMetadata => ({
  project: "test", dataset, url: "https://example.invalid", capturedAt,
});

function raw(path: string, content: unknown): DatasetFileInput {
  return { stage: "raw", path, content: JSON.stringify(content), source: source(path) };
}

test("builds the WorldState codebook from official regions, Plus, and language tables", () => {
  const publicExportFiles = [
    raw("public-export/en/ExportRegions_en.json", {
      ExportRegions: [{ uniqueName: "SolNode94", name: "Apollodorus", systemName: "Mercury", systemIndex: 0 }],
    }),
    raw("public-export/zh/ExportRegions_zh.json", {
      ExportRegions: [{ uniqueName: "SolNode94", name: "阿波罗多罗斯", systemName: "水星", systemIndex: 0 }],
    }),
    raw("public-export/en/ExportResources_en.json", {
      ExportResources: [{ uniqueName: "/Lotus/Types/Items/MiscItems/Ferrite", name: "Ferrite" }],
    }),
    raw("public-export/zh/ExportResources_zh.json", {
      ExportResources: [{ uniqueName: "/Lotus/Types/Items/MiscItems/Ferrite", name: "铁氧体" }],
    }),
    raw("public-export/shared/ExportManifest.json", {
      Manifest: [{
        uniqueName: "/Lotus/Types/Items/MiscItems/Ferrite",
        textureLocation: "/Lotus/Interface/Icons/StoreItems/Ferrite.png",
      }],
    }),
    raw("public-export/en/ExportRelicArcane_en.json", {
      ExportRelicArcane: [
        { uniqueName: "/Lotus/Types/Game/Projections/T1VoidProjectionLithH2", name: "Lith H2 Relic" },
        { uniqueName: "/Lotus/Types/Game/Projections/T5VoidProjectionRequiemIV", name: "Requiem IV Relic" },
      ],
    }),
    raw("public-export/zh/ExportRelicArcane_zh.json", {
      ExportRelicArcane: [
        { uniqueName: "/Lotus/Types/Game/Projections/T1VoidProjectionLithH2", name: "古纪 H2 遗物" },
        { uniqueName: "/Lotus/Types/Game/Projections/T5VoidProjectionRequiemIV", name: "安魂 IV 遗物" },
      ],
    }),
  ];
  const plusFiles = [
    raw("plus/ExportSystems.json", [
      {
        index: 0,
        name: "/Lotus/Language/Locations/Mercury",
        resources: [{
          StoreItem: "/Lotus/StoreItems/Types/Items/MiscItems/Ferrite",
          ItemType: "/Lotus/Types/Items/MiscItems/FerritePickup",
          Rarity: "COMMON",
        }],
      },
      { index: 20, name: "/Lotus/Language/Locations/Earth_SPACE", resources: [] },
    ]),
    raw("plus/ExportRegions.json", {
      SolNode94: {
        name: "/Lotus/Language/Locations/Apollodorus",
        systemName: "/Lotus/Language/Locations/Mercury",
        missionType: "MT_SURVIVAL",
        missionName: "/Lotus/Language/Missions/MissionName_Survival",
        faction: "FC_INFESTATION",
        minEnemyLevel: 5,
        maxEnemyLevel: 10,
        masteryReq: 0,
        nodeType: 0,
        systemIndex: 0,
        tileset: "GrineerAsteroidTileset",
        nextNodes: ["SolNode95"],
        rewardManifests: ["/Lotus/Types/Game/MissionDecks/TestRewards"],
        levelOverride: "/Lotus/Levels/TestLevel",
      },
      CrewBattleNodeTest: { name: "/Lotus/Language/Locations/Apollodorus", systemIndex: 0, systemName: "/Lotus/Language/Locations/Earth_SPACE", missionType: "MT_RAILJACK" },
      CrewBattleNode559: {
        name: "/Lotus/Language/Locations/NemesisShowdownNodeInfested",
        systemName: "/Lotus/Language/Locations/Earth_SPACE",
        missionType: "MT_RAILJACK",
        faction: "FC_INFESTATION",
        hidden: true,
        systemIndex: 20,
      },
    }),
    raw("plus/ExportMissionTypes.json", {
      MT_SURVIVAL: { name: "/Lotus/Language/Missions/MissionName_Survival" },
    }),
    raw("plus/ExportFactions.json", {
      FC_GRINEER: { name: "/Lotus/Language/Game/Faction_GrineerUC" },
      FC_INFESTATION: { name: "/Lotus/Language/Game/Faction_InfestationUC" },
    }),
    raw("plus/ExportSyndicates.json", {
      ArbitersSyndicate: { uniqueName: "/Lotus/Syndicates/ArbitersSyndicate", name: "/Lotus/Language/Syndicates/ArbitersName" },
    }),
  ];
  const languagesFiles = [
    raw("languages/en.json", {
      "/Lotus/Language/Locations/Apollodorus": "Apollodorus",
      "/Lotus/Language/Locations/Mercury": "Mercury",
      "/Lotus/Language/Locations/NemesisShowdownNodeInfested": "TECHNOCYTE CODA CONCERT",
      "/Lotus/Language/Locations/Earth_SPACE": "Earth Proxima",
      "/Lotus/Language/Missions/MissionName_Survival": "Survival",
      "/Lotus/Language/Game/Faction_GrineerUC": "Grineer",
      "/Lotus/Language/Game/Faction_InfestationUC": "Infested",
      "/Lotus/Language/Syndicates/ArbitersName": "Arbiters of Hexis",
      "/Lotus/Language/Labels/GAMEPLAY_KILL_XP_AMOUNT": "AFFINITY FROM KILLS",
      "/Lotus/Language/Labels/GAMEPLAY_DAMAGE_TO_POWER": "DAMAGE TO POWER",
    }),
    raw("languages/zh.json", {
      "/Lotus/Language/Locations/Apollodorus": "阿波罗多罗斯撞击坑",
      "/Lotus/Language/Locations/Mercury": "水星",
      "/Lotus/Language/Locations/NemesisShowdownNodeInfested": "科技细胞终幕者演唱会",
      "/Lotus/Language/Locations/Earth_SPACE": "地球比邻星",
      "/Lotus/Language/Missions/MissionName_Survival": "生存",
      "/Lotus/Language/Game/Faction_GrineerUC": "Grineer",
      "/Lotus/Language/Game/Faction_InfestationUC": "疫变感染体",
      "/Lotus/Language/Syndicates/ArbitersName": "均衡仲裁者",
      "/Lotus/Language/Labels/GAMEPLAY_KILL_XP_AMOUNT": "击杀经验",
      "/Lotus/Language/Labels/GAMEPLAY_DAMAGE_TO_POWER": "伤害转能量",
    }),
  ];

  const output = projectWorldstateCodebook(publicExportFiles, plusFiles, languagesFiles);
  const worldMapFile = output.find((f) => f.path === "catalog/world/map.json");
  assert.ok(worldMapFile);
  const worldMap = JSON.parse(String(worldMapFile.content)) as {
    nodeCount: number;
    systemCount: number;
    systems: Array<{ systemIndex: number; name: string; nameZh: string; nodes: Array<Record<string, unknown>>; resources: Array<Record<string, unknown>> }>;
  };
  const nodeMap = Object.fromEntries(worldMap.systems.flatMap((system) =>
    system.nodes.map((node) => [String(node.nodeKey), node]),
  )) as Record<string, Record<string, unknown>>;
  assert.equal(Object.hasOwn(nodeMap, "CrewBattleNode559"), true);

  // 官方节点：直接用官方中英名（不用语言表）
  assert.equal(nodeMap.SolNode94?.name, "Apollodorus");
  assert.equal(nodeMap.SolNode94?.nameZh, "阿波罗多罗斯");
  assert.equal(nodeMap.SolNode94?.systemName, "Mercury");
  assert.equal(nodeMap.SolNode94?.missionType, "MT_SURVIVAL");

  // 内联可读名：任务类型 / 派系 / 任务名（中英）
  assert.equal(nodeMap.SolNode94?.missionTypeName, "Survival");
  assert.equal(nodeMap.SolNode94?.missionTypeNameZh, "生存");
  assert.equal(nodeMap.SolNode94?.factionName, "Infested");
  assert.equal(nodeMap.SolNode94?.factionNameZh, "疫变感染体");
  assert.equal(nodeMap.SolNode94?.missionName, "Survival");
  assert.equal(nodeMap.SolNode94?.missionNameZh, "生存");

  // 玩法元数据：等级 / 段位 / 节点类型 / 星系 / 图块集 / 相邻节点
  assert.equal(nodeMap.SolNode94?.minEnemyLevel, 5);
  assert.equal(nodeMap.SolNode94?.maxEnemyLevel, 10);
  assert.equal(nodeMap.SolNode94?.masteryReq, 0);
  assert.equal(nodeMap.SolNode94?.nodeType, 0);
  assert.equal(nodeMap.SolNode94?.systemIndex, 0);
  assert.equal(nodeMap.SolNode94?.tileset, "GrineerAsteroidTileset");
  assert.deepEqual(nodeMap.SolNode94?.nextNodes, ["SolNode95"]);
  assert.deepEqual(nodeMap.SolNode94?.rewardManifests, ["/Lotus/Types/Game/MissionDecks/TestRewards"]);
  assert.equal(nodeMap.SolNode94?.levelOverride, "/Lotus/Levels/TestLevel");

  // 特殊节点：官方没有，用 Plus 语言 key 翻译；hidden 标记保留
  assert.equal(nodeMap.CrewBattleNode559?.name, "TECHNOCYTE CODA CONCERT");
  assert.equal(nodeMap.CrewBattleNode559?.nameZh, "科技细胞终幕者演唱会");
  assert.equal(nodeMap.CrewBattleNode559?.missionType, "MT_RAILJACK");
  assert.equal(nodeMap.CrewBattleNode559?.hidden, true);

  // 任务类型/派系/辛迪加
  const missionTypes = JSON.parse(String(output.find((f) => f.path === "worldstate/mission-types.json")?.content)) as Record<string, Record<string, unknown>>;
  assert.equal(missionTypes.MT_SURVIVAL?.name, "Survival");
  assert.equal(missionTypes.MT_SURVIVAL?.nameZh, "生存");
  const factions = JSON.parse(String(output.find((f) => f.path === "worldstate/factions.json")?.content)) as Record<string, Record<string, unknown>>;
  assert.equal(factions.FC_GRINEER?.name, "Grineer");
  assert.equal(factions.FC_INFESTATION?.name, "Infested");
  assert.equal(factions.FC_INFESTATION?.nameKey, "/Lotus/Language/Game/Faction_InfestationUC");
  assert.deepEqual(Object.keys(factions.FC_INFESTATION ?? {}).sort(), ["name", "nameEn", "nameKey", "nameZh"].sort());
  const syndicates = JSON.parse(String(output.find((f) => f.path === "worldstate/syndicates.json")?.content)) as Record<string, Record<string, unknown>>;
  assert.equal(syndicates.ArbitersSyndicate?.name, "Arbiters of Hexis");
  assert.equal(syndicates.ArbitersSyndicate?.nameZh, "均衡仲裁者");

  // 裂缝 modifier：由官方遗物 tier 前缀推导
  const fissure = JSON.parse(String(output.find((f) => f.path === "worldstate/fissure-modifiers.json")?.content)) as Record<string, Record<string, unknown>>;
  assert.equal(fissure.VoidT1?.name, "Lith");
  assert.equal(fissure.VoidT1?.nameZh, "古纪");
  assert.equal(fissure.VoidT5?.name, "Requiem");
  assert.equal(fissure.VoidT5?.nameZh, "安魂");
  assert.equal(fissure.VoidT6?.name, "Omnia");
  assert.equal(fissure.VoidT6?.nameZh, "全能");
  assert.equal(fissure.VoidT6?.tier, 6);

  // 星系索引 + 升级类型（一手推导）
  assert.equal(output.some((f) => f.path === "worldstate/regions.json"), false);
  assert.equal(output.some((f) => f.path === "worldstate/nodes.json"), false);
  const upgradeTypes = JSON.parse(String(output.find((f) => f.path === "worldstate/upgrade-types.json")?.content)) as Record<string, Record<string, unknown>>;
  assert.equal(upgradeTypes.GAMEPLAY_KILL_XP_AMOUNT?.name, "AFFINITY FROM KILLS");
  assert.equal(upgradeTypes.GAMEPLAY_KILL_XP_AMOUNT?.nameZh, "击杀经验");
  assert.equal(upgradeTypes.GAMEPLAY_DAMAGE_TO_POWER?.name, "DAMAGE TO POWER");
  assert.equal(upgradeTypes.GAMEPLAY_DAMAGE_TO_POWER?.nameZh, "伤害转能量");

  assert.equal(worldMap.nodeCount, 3);
  assert.equal(worldMap.systemCount, 2);
  assert.equal(worldMap.systems.length, 2);
  assert.equal(worldMap.systems.find((system) => system.systemIndex === 0)?.name, "Mercury");
  assert.equal(worldMap.systems.find((system) => system.systemIndex === 0)?.nodes.find((node) => node.nodeKey === "SolNode94")?.nodeKey, "SolNode94");
  assert.equal(worldMap.systems.find((system) => system.systemIndex === 20)?.name, "Earth Proxima");
  assert.equal(worldMap.systems.find((system) => system.systemIndex === 20)?.nameZh, "地球比邻星");
  const ferrite = worldMap.systems.find((system) => system.systemIndex === 0)?.resources[0]?.item as Record<string, unknown>;
  assert.equal(ferrite.name, "Ferrite");
  assert.equal(ferrite.nameZh, "铁氧体");
  assert.equal(ferrite.iconUrl, "https://content.warframe.com/PublicExport/Lotus/Interface/Icons/StoreItems/Ferrite.png");
  assert.equal(output.some((f) => f.path === "catalog/world/nodes.json"), false);
  assert.equal(output.some((f) => f.path === "catalog/i18n/nodes.json"), false);
});

test("rejects missing codebook inputs", () => {
  assert.throws(
    () => projectWorldstateCodebook([], [], []),
    /Worldstate codebook input is missing/u,
  );
});
