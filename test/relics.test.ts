import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatasetFileInput, SourceMetadata } from "../src/domain/contracts.js";
import { projectRelics } from "../src/projections/relics.js";

const capturedAt = "2026-10-22T00:00:00.000Z";
const source: SourceMetadata = {
  project: "test",
  dataset: "test",
  url: "https://example.invalid",
  capturedAt,
};

test("consolidates relic states, rewards, rates, bilingual items, and explicit unresolved rows", () => {
  const refinements = ["Bronze", "Silver", "Gold", "Platinum"] as const;
  const publicExportFiles: DatasetFileInput[] = [];
  const englishRelics = [];
  const chineseRelics = [];
  const itemTranslations: Record<string, unknown> = {};
  for (const family of ["LithM1", "LithM1Alt"]) {
    for (const refinement of refinements) {
      const uniqueName = `/Lotus/Types/Game/Projections/T1VoidProjection${family}${refinement}`;
      englishRelics.push({
        uniqueName,
        name: "Lith M1 Relic",
        relicRewards: [
          { rewardName: "/Lotus/StoreItems/Types/Recipes/TestPartA", rarity: "COMMON", tier: 0, itemCount: 2 },
          { rewardName: "/Lotus/StoreItems/Types/Recipes/TestPartB", rarity: "RARE", tier: 0, itemCount: 1 },
        ],
      });
      chineseRelics.push({ uniqueName, name: "古纪 M1 遗物" });
      itemTranslations[uniqueName] = {
        en: { name: "Lith M1 Relic" },
        zh: { name: "古纪 M1 遗物" },
        iconUrl: `https://content.warframe.com/${family}-${refinement}.png`,
      };
    }
  }
  itemTranslations["/Lotus/Types/Recipes/TestPartA"] = {
    en: { name: "Test Part A" },
    zh: { name: "测试部件甲" },
    iconUrl: "https://content.warframe.com/test-part-a.png",
  };
  itemTranslations["/Lotus/Types/Recipes/TestPartB"] = {
    en: { name: "Test Part B" },
    zh: { name: "测试部件乙" },
  };
  publicExportFiles.push(
    raw("public-export/en/ExportRelicArcane_en.json", { ExportRelicArcane: englishRelics }),
    raw("public-export/zh/ExportRelicArcane_zh.json", { ExportRelicArcane: chineseRelics }),
  );

  const catalogFiles: DatasetFileInput[] = [clean("catalog/i18n/items.json", itemTranslations)];
  const dropFiles: DatasetFileInput[] = [
    raw("droptables/droptables.html", "<html></html>"),
    clean("drop/relics.json", [
      { category: "Relics", source: "lith m1 relic (iNtAcT)", groups: [], item: "2X Test Part A", rarity: "Common", chance: 25 },
      { category: "Relics", source: "Lith M1 Relic (Intact)", groups: [], item: "Unindexed Part", rarity: "Uncommon", chance: 11, itemZh: "未建立索引的部件" },
      { category: "Relics", source: "Requiem Relic (Intact)", groups: [], item: "Legacy Reward", rarity: "Rare", chance: 2 },
    ]),
    clean("drop/missions.json", [
      { category: "Missions", source: "Earth/Node (Excavation)", groups: ["Rotation A"], item: "Lith M1 Relic", rarity: "Uncommon", chance: 2 },
    ]),
    clean("drop/relic-drops-by-source.json", [
      {
        category: "Relic Drops by Source", source: "Hemocyte", sourceDropChancePercent: 20,
        groups: [], item: "Lith M1 Relic", rarity: "Uncommon", chance: 12.91,
      },
    ]),
  ];
  const marketFiles: DatasetFileInput[] = [
    raw("warframe-market/items-v2.json", "{}"),
    clean("market/items.json", [
      { slug: "test_part_a", gameRef: "/Lotus/Types/Recipes/TestPartA", name: "Test Part A", icon: "items/test-part-a.png", i18n: { en: { name: "Test Part A" } } },
      { slug: "test_part_b", gameRef: "/Lotus/Types/Recipes/TestPartB", name: "Test Part B", icon: "items/test-part-b.png", i18n: { en: { name: "Test Part B" } } },
    ]),
  ];
  const languagesFiles = [raw("languages/en.json", {}), raw("languages/zh.json", {})];

  const plusFiles = [raw("plus/ExportRelics.json", {
    "/Lotus/Types/Game/Projections/T1VoidProjectionLithM1Bronze": {
      quality: "VPQ_BRONZE", rewardManifest: "/Lotus/Types/Game/MissionDecks/TestRewards", description: "/Lotus/Language/Relics/TestDescription",
    },
  })];
  const [file] = projectRelics(publicExportFiles, catalogFiles, dropFiles, marketFiles, languagesFiles, plusFiles);
  assert.ok(file);
  assert.equal(file.path, "catalog/loot/relics.json");
  const value = JSON.parse(String(file.content)) as {
    relics: Array<Record<string, unknown>>;
    unresolvedDropRows: Array<Record<string, unknown>>;
    quality: Record<string, number>;
  };
  assert.equal(value.relics.length, 2);
  const relic = value.relics[0] as {
    states: Record<string, Record<string, unknown>>;
    locations: Array<Record<string, unknown>>;
    nameZh: string;
  };
  const intact = relic.states.Intact as {
    quality: string;
    rewardManifest: string;
    rewards: Array<Record<string, unknown>>;
    unresolvedDropRewards: Array<Record<string, unknown>>;
  };
  assert.equal(relic.nameZh, "古纪 M1 遗物");
  assert.equal(intact.quality, "VPQ_BRONZE");
  assert.equal(intact.rewardManifest, "/Lotus/Types/Game/MissionDecks/TestRewards");
  assert.equal(intact.rewards[0]?.dropChancePercent, 25);
  assert.equal((intact.rewards[0]?.item as Record<string, unknown>).name, "Test Part A");
  assert.equal((intact.rewards[0]?.item as Record<string, unknown>).nameZh, "测试部件甲");
  const dropEntries = intact.rewards[0]?.dropTableEntries as Array<Record<string, unknown>>;
  assert.equal(((dropEntries[0]?.item as Record<string, unknown>).itemCount), 2);
  assert.equal((intact.rewards[0]?.item as Record<string, unknown>).iconUrl, "https://content.warframe.com/test-part-a.png");
  assert.equal(intact.unresolvedDropRewards.length, 1);
  assert.equal(intact.unresolvedDropRewards[0]?.item && (intact.unresolvedDropRewards[0]?.item as Record<string, unknown>).nameZh, "未建立索引的部件");
  assert.equal(relic.locations.length, 2);
  assert.equal(relic.locations[1]?.source, "Hemocyte");
  assert.equal(relic.locations[1]?.sourceDropChancePercent, 20);
  assert.equal(value.unresolvedDropRows.length, 2);
  assert.equal(value.quality.dropTableRows, 3);
  assert.equal(value.quality.matchedDropRows, 1);
  assert.equal(value.quality.unresolvedDropRows, 2);
});

function raw(path: string, content: unknown): DatasetFileInput {
  return { stage: "raw", path, content: typeof content === "string" ? content : JSON.stringify(content), source };
}

function clean(path: string, content: unknown): DatasetFileInput {
  return { stage: "cleaned", path, content: JSON.stringify(content), source };
}

test("infers a missing relic number only from a complete unique reward set and deduplicates rates", () => {
  const build = (names: string[]) => {
    const items = { "/Lotus/Part": { en: { name: "Part" }, zh: { name: "部件" } } };
    const official = names.map((name, i) => ({ uniqueName: `/Lotus/Types/Game/Projections/T1VoidProj${i}Bronze`, name, relicRewards: [{ rewardName: "/Lotus/StoreItems/Part", itemCount: 1, rarity: "COMMON" }] }));
    const table = [...names, "Lith Relic"].map((name) => ({ category: "Relics", source: `${name} (Intact)`, groups: [], item: "Part", rarity: "Common", chance: 100 }));
    const [output] = projectRelics(
      [raw("public-export/en/ExportRelicArcane_en.json", { ExportRelicArcane: official }), raw("public-export/zh/ExportRelicArcane_zh.json", { ExportRelicArcane: [] })],
      [clean("catalog/i18n/items.json", items)],
      [raw("droptables/droptables.html", ""), clean("drop/relics.json", table), clean("drop/missions.json", []), clean("drop/relic-drops-by-source.json", [])],
      [raw("warframe-market/items-v2.json", {}), clean("market/items.json", [])],
      [raw("languages/en.json", {}), raw("languages/zh.json", {})],
    );
    return JSON.parse(String(output!.content));
  };
  const unique = build(["Lith A1 Relic"]);
  assert.equal(unique.quality.inferredSourceGroups, 1);
  assert.equal(unique.quality.matchedDropRows, 2);
  assert.equal(unique.quality.deduplicatedRows, 1);
  const reward = unique.relics[0].states.Intact.rewards[0];
  assert.equal(reward.probability, 1);
  assert.equal(reward.dropTableEntries.length, 1);
  const ambiguous = build(["Lith A1 Relic", "Lith B1 Relic"]);
  assert.equal(ambiguous.quality.inferredSourceGroups, 0);
  assert.equal(ambiguous.quality.unresolvedDropRows, 1);
});
