import assert from "node:assert/strict";
import { test } from "node:test";
import { projectPublicExport } from "../src/projections/public-export.js";
import type { DatasetFileInput, SourceMetadata } from "../src/domain/contracts.js";

test("projects bilingual entities with parent-owned nested children", () => {
  const output = projectPublicExport(makeRawFiles());
  const json = (path: string): unknown => {
    const file = output.find((candidate) => candidate.path === path);
    assert.ok(file, `missing projection ${path}`);
    return JSON.parse(String(file.content)) as unknown;
  };

  const warframes = json("catalog/equipment/warframes.json") as Array<Record<string, unknown>>;
  const archwings = json("catalog/equipment/archwings.json") as Array<Record<string, unknown>>;
  const abilities = json("catalog/equipment/abilities.json") as Array<Record<string, unknown>>;
  const mods = json("catalog/upgrades/mods.json") as Array<Record<string, unknown>>;
  const sets = json("catalog/upgrades/mod-sets.json") as Array<Record<string, unknown>>;
  const arcanes = json("catalog/upgrades/arcanes.json") as Array<Record<string, unknown>>;
  const recipes = json("catalog/craft/recipes.json") as Record<string, Record<string, unknown>>;
  const translations = json("catalog/i18n/items.json") as Record<string, Record<string, Record<string, unknown>>>;

  assert.equal(warframes.length, 2);
  assert.equal(archwings.length, 1);
  assert.equal(abilities.length, 4);
  const standaloneAbility = abilities.find((ability) => ability.recordKey === "/Lotus/PowersuitAbilities/HelminthAbility");
  assert.equal(standaloneAbility?.nameZh, "感染者技能");
  assert.equal(standaloneAbility?.abilityNameZh, "感染者技能");
  assert.deepEqual(standaloneAbility?.ownerBkeys, []);
  const frameAbilities = warframes[0]?.abilities as Array<Record<string, unknown>>;
  assert.equal(frameAbilities[0]?.recordKey, "/Lotus/PowersuitAbilities/TestAbility");
  assert.equal(frameAbilities[0]?.abilityNameZh, "测试技能");
  assert.deepEqual((mods[0]?.ranks as Array<Record<string, unknown>>)[0]?.stats, { stats: ["rank zero"] });
  assert.deepEqual((sets[0]?.ranks as Array<Record<string, unknown>>)[0]?.stats, "set rank one");
  assert.equal((arcanes[0]?.ranks as Array<Record<string, unknown>>)[0]?.rank, 0);
  assert.equal(output.filter((candidate) => candidate.path === "catalog/upgrades/arcanes.json").length, 1);
  assert.equal(Object.keys(recipes)[0], "/Lotus/Types/Recipes/TestBlueprint");
  const recipe = recipes["/Lotus/Types/Recipes/TestBlueprint"];
  const ingredients = recipe?.ingredients as Array<Record<string, unknown>>;
  assert.equal((ingredients[0]?.item as Record<string, unknown>).name, "Component");
  assert.equal((ingredients[0]?.item as Record<string, unknown>).nameZh, "组件");
  assert.equal((recipe?.resultItem as Record<string, unknown>).nameZh, "测试物品");
  assert.deepEqual(translations["/Lotus/Powersuits/Excalibur"]?.en?.abilities, [{
    abilityUniqueName: "/Lotus/PowersuitAbilities/TestAbility",
    abilityName: "Test Skill",
    description: "Skill text en",
  }]);
  assert.equal(translations["/Lotus/Powersuits/Excalibur"]?.zh?.name, "圣剑");

  assert.equal(output.some((candidate) => candidate.path === "catalog/equipment/ability-slots.json"), false);
  assert.equal(output.some((candidate) => candidate.path === "catalog/craft/recipe-ingredients.json"), false);
  assert.equal(output.some((candidate) => candidate.path === "catalog/i18n/nodes.json"), false);
  const modFile = output.find((candidate) => candidate.path === "catalog/upgrades/mods.json");
  assert.ok(modFile);
  assert.deepEqual(modFile.source.derivedFrom, ["public-export/en/ExportUpgrades_en.json"]);
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
      ExportAbilities: [{
        abilityUniqueName: "/Lotus/PowersuitAbilities/HelminthAbility",
        abilityName: pick(locale, "Infested Ability", "感染者技能"),
        description: pick(locale, "Infested ability text", "感染者技能说明"),
      }],
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
    files.push(rawFile(locale, "ExportResources", {
      ExportResources: [
        { uniqueName: "/Lotus/Types/Items/Test", name: pick(locale, "Test Product", "测试物品") },
        { uniqueName: "/Lotus/Types/Items/Component", name: pick(locale, "Component", "组件") },
      ],
    }, capturedAt));
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
