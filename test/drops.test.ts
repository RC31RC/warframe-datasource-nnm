import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatasetFileInput, SourceMetadata } from "../src/domain/contracts.js";
import { projectDropTables } from "../src/projections/drops.js";

const capturedAt = "2026-10-22T00:00:00.000Z";
const source: SourceMetadata = { project: "test", dataset: "test", url: "https://example.invalid", capturedAt };

test("groups bilingual rewards and reconciles reverse indexes without conflating probabilities", () => {
  const catalog: DatasetFileInput[] = [clean("catalog/i18n/items.json", {
    "/Lotus/Types/Mods/MeleeProwess": {
      en: { name: "Melee Prowess" }, zh: { name: "近战技巧" }, iconUrl: "https://content.warframe.com/melee.png",
    },
  })];
  const languages: DatasetFileInput[] = [
    raw("languages/en.json", { "/Lotus/Language/Enemies/ScrofaProvisor": "Scrofa Provisor" }),
    raw("languages/zh.json", { "/Lotus/Language/Enemies/ScrofaProvisor": "斯克罗法补给者" }),
  ];
  const drops: DatasetFileInput[] = [
    raw("droptables/droptables.html", "<html></html>"),
    clean("drop/mod-drops-by-source.json", [{
      category: "Mod Drops by Source",
      source: "Scrofa Provisor",
      sourceDropChancePercent: 20,
      groups: [],
      item: "Melee Prowess",
      rarity: "Uncommon",
      chance: 25.29,
    }]),
    clean("drop/mod-drops-by-mod.json", [{
      category: "Mod Drops by Mod",
      source: "Melee Prowess",
      sourceDropChancePercent: 10,
      groups: [],
      item: "Scrofa Provisor",
      rarity: "Uncommon",
      chance: 25.29,
    }]),
    clean("drop/missions.json", [{
      category: "Missions",
      source: "Earth Excavation",
      groups: ["Rotation A", "Stage 1"],
      item: "Melee Prowess",
      rarity: "Rare",
      chance: 5,
    }]),
  ];

  const [file] = projectDropTables(drops, catalog, languages);
  assert.ok(file);
  assert.equal(file.path, "drop/tables.json");
  const result = JSON.parse(String(file.content)) as {
    contexts: Array<Record<string, unknown>>;
    quality: {
      rewardCount: number;
      reverseIndexReconciliation: Record<string, Record<string, number>>;
    };
  };
  const modContext = result.contexts.find((context) => context.category === "Mod Drops by Source");
  assert.ok(modContext);
  assert.equal(modContext.sourceDropChancePercent, 20);
  const mod = (modContext.rewards as Array<Record<string, unknown>>)[0];
  assert.ok(mod);
  assert.equal(mod.dropChancePercent, 25.29);
  assert.deepEqual(mod.reverseIndex, { status: "both_indexes", sourceDropChancePercent: 10 });
  assert.deepEqual(mod.item, {
    uniqueName: "/Lotus/Types/Mods/MeleeProwess",
    name: "Melee Prowess",
    nameZh: "近战技巧",
    iconUrl: "https://content.warframe.com/melee.png",
    identityResolution: "unique",
  });
  const mission = result.contexts.find((context) => context.category === "Missions");
  const rotation = (mission?.groups as Array<Record<string, unknown>>)[0];
  assert.equal(rotation?.name, "Rotation A");
  assert.equal((rotation?.groups as Array<Record<string, unknown>>)[0]?.name, "Stage 1");
  assert.equal(result.quality.rewardCount, 2);
  assert.equal(result.quality.reverseIndexReconciliation.mods?.matchedRows, 1);
  assert.equal(result.quality.reverseIndexReconciliation.mods?.sourceDropChanceDisagreements, 1);
});

function raw(path: string, value: unknown): DatasetFileInput {
  return { stage: "raw", path, content: JSON.stringify(value), source };
}

function clean(path: string, value: unknown): DatasetFileInput {
  return { stage: "cleaned", path, content: JSON.stringify(value), source };
}

test("keeps distinct same-name pools and separates repeated draws, quantities, currencies and region rules", () => {
  const id = "/Lotus/Types/Items/MiscItems/PolymerBundle";
  const catalog = [clean("catalog/i18n/items.json", {
    [id]: { en: { name: "Polymer Bundle" }, zh: { name: "聚合物束" } },
    [id + "240TutorialQuest"]: { en: { name: "Polymer Bundle" }, zh: { name: "聚合物束" } },
  }), clean("catalog/world/map.json", { systems: [{ systemIndex: 0, name: "Mercury", nameZh: "水星", resources: [{ uniqueName: id }] }] })];
  const entries = [
    { category: "Resource Drops by Source", source: "Enemy", sourceTableIndex: 0, sourceDropChancePercent: 400, groups: [], item: "2 x Polymer Bundle", chance: 25, rarity: "Common" },
    { category: "Resource Drops by Source", source: "Enemy", sourceTableIndex: 1, sourceDropChancePercent: 400, groups: [], item: "2 x 1,000 Endo", chance: 25, rarity: "Common" },
    { category: "Missions", source: "Mission", groups: [], item: "Region Resource", chance: 20, rarity: "Common" },
    { category: "Missions", source: "Mission", groups: [], item: "Unknown", chance: null, rarity: "Under Review", sourceChanceText: "Under Review" },
  ];
  const [output] = projectDropTables([raw("droptables/droptables.html", ""), clean("drop/test.json", entries)], catalog, []);
  const value = JSON.parse(String(output!.content));
  const pools = value.contexts.filter((context: any) => context.category === "Resource Drops by Source");
  assert.equal(pools.length, 2);
  assert.equal(pools[0].drawCount, 4);
  assert.equal(pools[0].activationProbability, 1);
  assert.equal(pools[0].rewards[0].probability, 0.25);
  assert.equal(pools[0].rewards[0].item.uniqueName, id);
  assert.equal(pools[0].rewards[0].item.count, 2);
  assert.equal(pools[1].rewards[0].item.quantity, 2000);
  const mission = value.contexts.find((context: any) => context.category === "Missions");
  assert.equal(mission.rewards[0].item.identityResolution, "rule");
  assert.equal(mission.rewards[0].item.probability, undefined);
  assert.equal(mission.rewards[1].probability, null);
  assert.equal(mission.rewards[1].sourceChanceText, "Under Review");
  assert.equal(value.regionResources[0].resources[0].uniqueName, id);
});


test("reward matching excludes same-name noninventory definitions, preserves source identities and resolves exact text tokens and refinements", () => {
  const resource = "/Lotus/Types/Items/MiscItems/Kuva", enemy = "/Lotus/Types/Enemies/KuvaAvatar";
  const shard = "/Lotus/Types/Gameplay/Shard", relic = "/Lotus/Types/Game/Projections/T1A";
  const catalog = [
    clean("catalog/i18n/items.json", {
      [resource]: { en: { name: "Kuva" }, zh: { name: "赤毒" } },
      [enemy]: { en: { name: "Kuva" }, zh: { name: "赤毒敌人" } },
      [shard]: { en: { name: "<SHARD_RED_SIMPLE> Crimson Archon Shard" }, zh: { name: "深红源力石" } },
      [relic + "Bronze"]: { en: { name: "Lith A1 Relic" }, zh: { name: "古纪 A1 遗物" } },
      [relic + "Platinum"]: { en: { name: "Lith A1 Relic" }, zh: { name: "古纪 A1 遗物" } },
    }),
    clean("resources/items.json", { [resource]: { uniqueName: resource }, [shard]: { uniqueName: shard } }),
    clean("plus/enemies.json", { [enemy]: { name: "Kuva" } }),
  ];
  const rows = ["Kuva", "Crimson Archon Shard", "Lith A1 Relic (Radiant)", "15,000 Credits"].map((item) => ({ category: "Missions", source: "Enemy", groups: [], item, chance: 25, rarity: "Common" }));
  rows.push({ category: "Resource Drops by Source", source: "Kuva", groups: [], item: "Kuva", chance: 100, rarity: "Common" });
  const [file] = projectDropTables([raw("droptables/droptables.html", ""), clean("drop/test.json", rows)], catalog, []);
  const value = JSON.parse(String(file!.content));
  const rewards = value.contexts.find((entry: any) => entry.category === "Missions").rewards;
  assert.equal(rewards[0].item.uniqueName, resource);
  assert.equal(rewards[1].item.uniqueName, shard);
  assert.equal(rewards[2].item.uniqueName, relic + "Platinum");
  assert.equal(rewards[2].item.refinement, "Radiant");
  assert.equal(rewards[3].item.currency, "credits");
  assert.equal(rewards[3].item.quantity, 15000);
  // Both names stay indexed for sources; inventory narrowing is exclusive to reward slots.
  assert.equal(value.contexts.find((entry: any) => entry.category === "Resource Drops by Source").source.identityResolution, "ambiguous");
});
