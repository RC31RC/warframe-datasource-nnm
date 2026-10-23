import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatasetFileInput, SourceMetadata } from "../src/domain/contracts.js";
import { projectRivenWeapons } from "../src/projections/riven-weapons.js";

const source: SourceMetadata = {
  project: "test", dataset: "test", url: "https://example.invalid", capturedAt: "2026-10-22T00:00:00.000Z",
};

test("consolidates disposition, Market metadata, and uniquely matched platform records", () => {
  const files: DatasetFileInput[] = [
    raw("public-export/en/ExportWeapons_en.json"),
    raw("warframe-market/riven-weapons-v2.json"),
    raw("weekly-rivens/PC.txt"),
    raw("weekly-rivens/PS4.txt"),
    raw("weekly-rivens/SWI.txt"),
    raw("weekly-rivens/XB1.txt"),
    clean("riven/disposition.json", [
      { uniqueName: "/Lotus/Weapons/TestWeapon", name: "Test Weapon", nameZh: "测试武器", disposition: 1.1 },
      { uniqueName: "/Lotus/Weapons/Other", name: "Other", nameZh: "其他", disposition: 0.8 },
    ]),
    clean("market/riven-weapons.json", [{ gameRef: "/Lotus/Weapons/TestWeapon", name: "Test Weapon", slug: "test_weapon" }]),
    clean("riven/weekly-pc.json", [
      { compatibility: "Test Weapon", itemType: "Rifle Riven Mod", avg: 50, rerolled: false },
      { compatibility: "Unknown Weapon", itemType: "Rifle Riven Mod", avg: 10, rerolled: false },
      { compatibility: null, itemType: "Rifle Riven Mod", avg: 20 },
    ]),
    clean("riven/weekly-ps4.json", []),
    clean("riven/weekly-swi.json", []),
    clean("riven/weekly-xb1.json", []),
  ];
  const [file] = projectRivenWeapons(files);
  assert.ok(file);
  assert.equal(file.path, "riven/weapons.json");
  const result = JSON.parse(String(file.content)) as {
    weapons: Array<Record<string, unknown>>;
    categorySummaries: Array<Record<string, unknown>>;
    unresolvedWeeklyRows: Array<Record<string, unknown>>;
    quality: Record<string, number>;
  };
  const weapon = result.weapons.find((row) => row.uniqueName === "/Lotus/Weapons/TestWeapon");
  assert.ok(weapon);
  assert.equal(weapon.nameZh, "测试武器");
  assert.equal(weapon.disposition, 1.1);
  assert.equal((weapon.marketListings as unknown[]).length, 1);
  assert.equal((weapon.weeklyByPlatform as Record<string, unknown[]>).PC?.length, 1);
  assert.equal(result.categorySummaries.length, 1);
  assert.equal(result.unresolvedWeeklyRows.length, 1);
  assert.equal(result.quality.weeklyRows, 3);
  assert.equal(result.quality.weeklyRowsAttached, 1);
  assert.equal(result.quality.marketListingsWithDisposition, 1);
  assert.equal(result.quality.marketListingsWithoutDisposition, 0);
});

function clean(path: string, value: unknown): DatasetFileInput {
  return { stage: "cleaned", path, content: JSON.stringify(value), source };
}

function raw(path: string): DatasetFileInput {
  return { stage: "raw", path, content: "{}", source };
}
