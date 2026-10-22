import assert from "node:assert/strict";
import { test } from "node:test";
import { projectPublicExport } from "../src/projections/public-export.js";
import type { DatasetFileInput, SourceMetadata } from "../src/domain/contracts.js";

test("projects official files into separate stable datasets and preserves lineage", () => {
  const output = projectPublicExport(makeRawFiles());
  const json = (path: string): unknown => {
    const file = output.find((candidate) => candidate.path === path);
    assert.ok(file, `missing projection ${path}`);
    return JSON.parse(String(file.content)) as unknown;
  };

  const warframes = json("catalog/equipment/warframes.json") as Array<Record<string, unknown>>;
  const archwings = json("catalog/equipment/archwings.json") as Array<Record<string, unknown>>;
  const abilities = json("catalog/equipment/abilities.json") as Array<Record<string, unknown>>;
  const slots = json("catalog/equipment/ability-slots.json") as Array<Record<string, unknown>>;
  const modRanks = json("catalog/upgrades/mods-rank-stats.json") as Array<Record<string, unknown>>;
  const setRanks = json("catalog/upgrades/mod-set-rank-stats.json") as Array<Record<string, unknown>>;
  const recipes = json("catalog/craft/recipes.json") as Record<string, Record<string, unknown>>;
  const ingredients = json("catalog/craft/recipe-ingredients.json") as Array<Record<string, unknown>>;
  const translations = json("catalog/i18n/items.json") as Record<string, Record<string, Record<string, unknown>>>;
  const nodeTranslations = json("catalog/i18n/nodes.json") as Record<string, Record<string, Record<string, unknown>>>;

  assert.equal(warframes.length, 2);
  assert.equal(archwings.length, 1);
  assert.equal(abilities.length, 3);
  assert.equal(slots.length, 4);
  assert.equal(slots[0]?.recordKey, "/Lotus/Powersuits/Excalibur#ability:0");
  assert.equal(slots[3]?.ownerType, "archwing");
  assert.equal((modRanks[0]?.stats as Record<string, unknown>).stats instanceof Array, true);
  assert.equal(modRanks[0]?.rankNumber, 0);
  assert.equal(setRanks[0]?.rankNumber, 1);
  assert.deepEqual(setRanks[0]?.stats, "set rank one");
  assert.equal(Object.keys(recipes)[0], "/Lotus/Types/Recipes/TestBlueprint");
  assert.equal(ingredients[0]?.parentBkey, "/Lotus/Types/Recipes/TestBlueprint");
  assert.deepEqual(translations["/Lotus/Powersuits/Excalibur"]?.en?.abilities, [{
    abilityUniqueName: "/Lotus/PowersuitAbilities/TestAbility",
    abilityName: "Test Skill",
    description: "Skill text en",
  }]);
  assert.equal(translations["/Lotus/Powersuits/Excalibur"]?.zh?.name, "圣剑");
  assert.equal(nodeTranslations.SolNode94?.en?.systemName, "Mercury");

  const slotFile = output.find((candidate) => candidate.path === "catalog/equipment/ability-slots.json");
  assert.ok(slotFile);
  assert.deepEqual(slotFile.source.derivedFrom, ["public-export/en/ExportWarframes_en.json"]);
  assert.equal(slotFile.source.transformer, "warframe-datasource-nnm/public-export-projection@1");
});

test("rejects conflicting same-build ability definitions instead of selecting one", () => {
  assert.throws(() => projectPublicExport(makeRawFiles(true)), /Conflicting same-build ability/u);
});

function makeRawFiles(conflictingAbility = false): DatasetFileInput[] {
  const capturedAt = "2026-10-21T00:00:00.000Z";
  const locales = ["en", "de", "es", "fr", "it", "ja", "ko", "pl", "pt", "ru", "tc", "th", "tr", "uk", "zh"] as const;
  // 仅 en/zh 断言本地化名，其余语言用英文名占位即可。
  const pick = (locale: string, en: string, zh: string): string => (locale === "zh" ? zh : en);
  const abilities = (language: string) => [{
    abilityUniqueName: "/Lotus/PowersuitAbilities/TestAbility",
    abilityName: pick(language, "Test Skill", "测试技能"),
    description: pick(language, "Skill text en", "技能说明"),
  }];
  const files: DatasetFileInput[] = [];
  for (const locale of locales) {
    const warframes = {
      ExportWarframes: [
        {
          uniqueName: "/Lotus/Powersuits/Excalibur",
          productCategory: "Warframes",
          name: pick(locale, "Excalibur", "圣剑"),
          description: pick(locale, "Frame text", "战甲说明"),
          abilities: abilities(locale),
        },
        {
          uniqueName: "/Lotus/Powersuits/Mag",
          productCategory: "Warframes",
          name: "Mag",
          abilities: [
            { ...abilities(locale)[0], ...(conflictingAbility ? { description: "conflict" } : {}) },
            { abilityUniqueName: "/Lotus/PowersuitAbilities/SecondAbility", abilityName: "Second", description: "Second" },
          ],
        },
        {
          uniqueName: "/Lotus/Powersuits/Archwing/Test",
          productCategory: "SpaceSuits",
          name: "Test Wing",
          abilities: [{ abilityUniqueName: "/Lotus/PowersuitAbilities/Flight", abilityName: "Flight", description: "Fly" }],
        },
      ],
      ExportAbilities: [],
    };
    const weapons = { ExportWeapons: [{ uniqueName: "/Lotus/Weapons/Test", name: "Test Weapon" }], ExportRailjackWeapons: [] };
    const upgrades = {
      ExportUpgrades: [{ uniqueName: "/Lotus/Upgrades/TestMod", levelStats: [{ stats: ["rank zero"] }] }],
      ExportFocusUpgrades: [{ uniqueName: "/Lotus/Upgrades/TestFocus", levelStats: [{ stats: ["focus rank"] }] }],
      ExportAvionics: [{ uniqueName: "/Lotus/Upgrades/TestAvionic", levelStats: [{ stats: ["avionic rank"] }] }],
      ExportModSet: [{ uniqueName: "/Lotus/Upgrades/TestSet", stats: ["set rank one", "set rank two"] }],
    };
    const relicArcane = {
      ExportRelicArcane: [
        { uniqueName: "/Lotus/Types/Game/Projections/TestRelic", name: "Test Relic" },
        { uniqueName: "/Lotus/Upgrades/CosmeticEnhancers/TestArcane", name: "Test Arcane", levelStats: [{ stats: ["arcane rank"] }] },
      ],
    };
    const regions = { ExportRegions: [{ uniqueName: "SolNode94", name: pick(locale, "Apollodorus", "阿波罗多洛斯"), systemName: pick(locale, "Mercury", "水星") }] };
    const recipes = {
      ExportRecipes: [{
        uniqueName: "/Lotus/Types/Recipes/TestBlueprint",
        resultType: "/Lotus/Types/Items/Test",
        buildPrice: 100,
        ingredients: [{ ItemType: "/Lotus/Types/Items/Component", ItemCount: 2 }],
      }],
    };
    for (const [name, payload] of [
      ["ExportWarframes", warframes],
      ["ExportWeapons", weapons],
      ["ExportUpgrades", upgrades],
      ["ExportRelicArcane", relicArcane],
      ["ExportRegions", regions],
      ["ExportRecipes", recipes],
    ] as const) {
      files.push(rawFile(locale, name, payload, capturedAt));
    }
  }
  return files;
}

function rawFile(locale: string, exportName: string, content: object, capturedAt: string): DatasetFileInput {
  const path = `public-export/${locale}/${exportName}_${locale}.json`;
  const source: SourceMetadata = {
    project: "Digital Extremes Public Export",
    dataset: `${exportName}/${locale}`,
    url: `https://content.warframe.com/PublicExport/Manifest/${exportName}_${locale}.json!hash`,
    capturedAt,
    upstreamRevision: "hash",
  };
  return { stage: "raw", path, content: JSON.stringify(content), source };
}
