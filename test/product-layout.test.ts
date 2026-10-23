import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatasetFileInput } from "../src/domain/contracts.js";
import { organizeEntityOwnership } from "../src/projections/entity-ownership.js";
import { canonicalProductPath, PRODUCT_PATH_ALIASES, PRODUCT_DIRECTORIES } from "../src/publish/product-layout.js";

const file = (path: string, value: unknown): DatasetFileInput => ({ stage: "cleaned", path, content: JSON.stringify(value),
  source: { project: "test", dataset: path, url: "https://example.invalid", capturedAt: "2026-10-23T00:00:00Z" } });
const objects = (files: DatasetFileInput[]) => Object.fromEntries(files.map((file) => [file.path, JSON.parse(String(file.content)) as Record<string, unknown>]));

test("all product aliases are single-level, in the twelve business domains, and idempotent", () => {
  assert.equal(PRODUCT_DIRECTORIES.length, 12);
  for (const [old, target] of Object.entries(PRODUCT_PATH_ALIASES)) {
    assert.equal(canonicalProductPath(old), target);
    assert.equal(canonicalProductPath(target), target);
    assert.equal(target.split("/").length, 2);
    assert.ok((PRODUCT_DIRECTORIES as readonly string[]).includes(target.split("/")[0]!));
  }
  assert.equal(canonicalProductPath("usage/2025.json"), "statistics/usage-2025.json");
  assert.equal(canonicalProductPath("catalog/equipment/weapons.json"), "equipment/weapons.json");
});

test("resource ownership follows official categories without rewriting any record", () => {
  const records = {
    "/Lotus/Decor": { productCategory: "ShipDecorations", nameZh: "装饰", iconAsset: "/internal.png" },
    "/Lotus/Ship": { productCategory: "Ships", nameEn: "Ship" },
    "/Lotus/Railjack": { productCategory: "CrewShips" },
    "/Lotus/Treasure": { productCategory: "FusionTreasures", value: 0.25 },
    "/Lotus/Supply": { productCategory: "SupplyDrop" },
    "/Lotus/Unknown": { productCategory: "NewUnknownCategory", GAMEPLAY_DAMAGE_TO_POWER: 1, child: { raw: "?" } },
  };
  const result = objects(organizeEntityOwnership([file("resources/items.json", records)]));
  assert.deepEqual(result["items/decorations.json"]?.["/Lotus/Decor"], records["/Lotus/Decor"]);
  assert.deepEqual(result["equipment/ships.json"], { "/Lotus/Railjack": records["/Lotus/Railjack"], "/Lotus/Ship": records["/Lotus/Ship"] });
  assert.deepEqual(result["items/ayatan-treasures.json"]?.["/Lotus/Treasure"], records["/Lotus/Treasure"]);
  assert.deepEqual(result["items/supply-drops.json"]?.["/Lotus/Supply"], records["/Lotus/Supply"]);
  assert.deepEqual(result["items/misc-items.json"]?.["/Lotus/Unknown"], records["/Lotus/Unknown"]);
});

test("missing categories resolve through exact inherited types; abstract definitions remain separate", () => {
  const virtuals = { "/Lotus/Derived": { parentName: "/Lotus/Types/Items/MiscItems/PhotoboothTile" } };
  const records = { "/Lotus/Scene": { parentName: "/Lotus/Derived", nameEn: "Scene", nameZh: "场景" },
    "/Lotus/Part": { parentName: "/Lotus/Types/Items/MiscItems/WarframeComponentItem" },
    "/Lotus/Resource": { parentName: "/Lotus/Types/Items/MiscItems/ResourceItem" },
    "/Lotus/Song": { parentName: "/Lotus/Types/Game/SongItem" } };
  const result = objects(organizeEntityOwnership([file("resources/items.json", records), file("plus/virtuals.json", virtuals)]));
  assert.deepEqual(result["items/captura-scenes.json"]?.["/Lotus/Scene"], records["/Lotus/Scene"]);
  assert.deepEqual(result["items/components.json"]?.["/Lotus/Part"], records["/Lotus/Part"]);
  assert.deepEqual(result["items/resources.json"]?.["/Lotus/Resource"], records["/Lotus/Resource"]);
  assert.deepEqual(result["items/songs.json"]?.["/Lotus/Song"], records["/Lotus/Song"]);
  assert.deepEqual(result["plus/virtuals.json"], virtuals);
});

test("cyclic or conflicting inheritance and misleading names never cause guessed material ownership", () => {
  const result = objects(organizeEntityOwnership([file("resources/items.json", {
    "/Lotus/A": { parentName: "/Lotus/B", name: "Ship Decoration Resource" },
    "/Lotus/B": { parentName: "/Lotus/A" },
    "/Lotus/Conflict": { parentName: "/Lotus/Types/Game/SongItem", base: "/Lotus/Types/Items/MiscItems/ResourceItem" },
  })]));
  assert.deepEqual(Object.keys(result["items/misc-items.json"]!), ["/Lotus/A", "/Lotus/B", "/Lotus/Conflict"]);
  assert.equal(result["items/resources.json"], undefined);
});

test("official exterior-skin inheritance merges into skins; unresolved customizations retain their values", () => {
  const skin = { uniqueName: "/Lotus/Original", nameZh: "原有外观" };
  const shipSkin = { base: "/Lotus/Types/Items/ShipExteriorSkinItem", nameEn: "Ship Skin", nameZh: "飞船外观" };
  const mystery = { name: "/Lotus/Language/Unknown", enabled: false };
  const result = objects(organizeEntityOwnership([file("cosmetics/catalog.json", { "/Lotus/Original": skin }),
    file("cosmetics/flavour.json", { "/Lotus/ShipSkin": shipSkin, "/Lotus/Mystery": mystery })]));
  assert.deepEqual(result["items/skins.json"], { "/Lotus/Original": skin, "/Lotus/ShipSkin": shipSkin });
  assert.deepEqual(result["items/customizations.json"], { "/Lotus/Mystery": mystery });
});

test("ownership grouping is independent of file/record ordering and preserves empty collection contracts", () => {
  const a = file("resources/items.json", { "/Lotus/Z": { productCategory: "Ships" }, "/Lotus/A": { productCategory: "Ships" } });
  const b = file("cosmetics/catalog.json", {});
  const first = organizeEntityOwnership([a, b]);
  const reversed = organizeEntityOwnership([b, file(a.path, { "/Lotus/A": { productCategory: "Ships" }, "/Lotus/Z": { productCategory: "Ships" } })]);
  assert.deepEqual(first, reversed);
  assert.deepEqual(objects(first)["items/skins.json"], {});
});

test("ownership conflicts and malformed entity collections are rejected rather than overwritten", () => {
  assert.throws(() => organizeEntityOwnership([file("resources/items.json", [])]), /keyed entity collection/u);
  assert.throws(() => organizeEntityOwnership([file("resources/items.json", { "/Lotus/X": "invalid" })]), /entity object/u);
  assert.throws(() => organizeEntityOwnership([file("cosmetics/catalog.json", { "/Lotus/X": { name: "A" } }),
    file("cosmetics/flavour.json", { "/Lotus/X": { base: "/Lotus/Types/Items/ShipExteriorSkinItem", name: "B" } })]), /Conflicting entity ownership record/u);
  assert.throws(() => organizeEntityOwnership([file("resources/items.json", { "/Lotus/Ship": { productCategory: "Ships" } }),
    file("equipment/ships.json", {})]), /Conflicting entity ownership destination/u);
});
