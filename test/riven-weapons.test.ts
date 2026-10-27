import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatasetFileInput, SourceMetadata } from "../src/domain/contracts.js";
import { projectRivenWeapons } from "../src/projections/riven-weapons.js";

const source: SourceMetadata = {
  project: "test", dataset: "test", url: "https://example.invalid", capturedAt: "2026-10-22T00:00:00.000Z",
};

test("consolidates static disposition and Market catalog metadata", () => {
  const files: DatasetFileInput[] = [
    raw("public-export/en/ExportWeapons_en.json"),
    raw("warframe-market/riven-weapons-v2.json"),
    clean("riven/disposition.json", [
      { uniqueName: "/Lotus/Weapons/TestWeapon", name: "Test Weapon", nameZh: "测试武器", disposition: 1.1 },
      { uniqueName: "/Lotus/Weapons/Other", name: "Other", nameZh: "其他", disposition: 0.8 },
    ]),
    clean("market/riven-weapons.json", [
      { gameRef: "/Lotus/Weapons/TestWeapon", name: "Test Weapon", slug: "test_weapon" },
      { name: "Unresolved Weapon", slug: "unresolved_weapon" },
    ]),
  ];
  const [file] = projectRivenWeapons(files);
  assert.ok(file);
  assert.equal(file.path, "riven/weapons.json");
  const result = JSON.parse(String(file.content)) as {
    weapons: Array<Record<string, unknown>>;
    unresolvedMarketWeapons: Array<Record<string, unknown>>;
    quality: Record<string, number>;
  };
  const weapon = result.weapons.find((row) => row.uniqueName === "/Lotus/Weapons/TestWeapon");
  assert.ok(weapon);
  assert.equal(weapon.nameZh, "测试武器");
  assert.equal(weapon.disposition, 1.1);
  assert.equal((weapon.marketListings as unknown[]).length, 1);
  assert.equal(Object.hasOwn(weapon, "weeklyByPlatform"), false);
  assert.deepEqual(Object.keys(result).sort(), ["quality", "unresolvedMarketWeapons", "weapons"]);
  assert.equal(result.unresolvedMarketWeapons.length, 1);
  assert.equal(result.quality.marketListingsWithDisposition, 1);
  assert.equal(result.quality.marketListingsWithoutDisposition, 1);
});

function clean(path: string, value: unknown): DatasetFileInput {
  return { stage: "cleaned", path, content: JSON.stringify(value), source };
}

function raw(path: string): DatasetFileInput {
  return { stage: "raw", path, content: "{}", source };
}
