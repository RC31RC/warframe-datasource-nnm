import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupCollectedInputs } from "../src/pipeline/acquire.js";
import { extractAttributes, projectAttributes, projectItems } from "../src/collectors/market.js";
import { decompressIndex, fetchPublicExportIndex, parsePublicExportIndex, REQUIRED_EXPORTS } from "../src/collectors/public-export.js";
import { projectMarketItems } from "../src/projections/linked.js";

test("parses localized Public Export index references without losing hashes", () => {
  const entries = parsePublicExportIndex([
    "ExportWarframes_en.json!sha256:deadbeef",
    "ExportRecipes_en.json!revision-2",
    "ExportManifest.json!revision-3",
    "not-a-reference",
  ].join("\r\n"));

  assert.equal(entries.size, 3);
  assert.equal(entries.get("ExportWarframes_en.json")?.upstreamRevision, "sha256:deadbeef");
  assert.equal(entries.get("ExportManifest.json")?.upstreamRevision, "revision-3");
  assert.deepEqual(REQUIRED_EXPORTS, [
    "ExportWarframes",
    "ExportWeapons",
    "ExportUpgrades",
    "ExportRelicArcane",
    "ExportRegions",
    "ExportRecipes",
  ]);
});

test("rejects malformed and duplicate Public Export index entries", () => {
  assert.throws(() => parsePublicExportIndex("nothing useful"), /no valid file entries/u);
  assert.throws(() => parsePublicExportIndex([
    "ExportWarframes_en.json!one",
    "ExportWarframes_en.json!two",
  ].join("\n")), /Duplicate/u);
});

test("retries an official index on the alternate host after HTTP 403", async (context) => {
  const urls: string[] = [];
  const fixture = await readFile(new URL("./fixtures/public-export-index-en.lzma", import.meta.url));
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    return url.includes("content.warframe.com")
      ? new Response("blocked", { status: 403 })
      : new Response(fixture, { status: 200 });
  });
  const { compressed, indexUrl } = await fetchPublicExportIndex("en");
  assert.deepEqual(compressed, fixture);
  assert.equal(indexUrl, "https://origin.warframe.com/PublicExport/index_en.txt.lzma");
  assert.deepEqual(urls, [
    "https://content.warframe.com/PublicExport/index_en.txt.lzma",
    "https://origin.warframe.com/PublicExport/index_en.txt.lzma",
  ]);
});

test("a corrupt HTTP 200 index falls back only to a fully validated official response", async (context) => {
  const fixture = await readFile(new URL("./fixtures/public-export-index-en.lzma", import.meta.url));
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => new Response(
    String(input).includes("content.warframe.com") ? "invalid compressed response" : fixture,
  ));
  const result = await fetchPublicExportIndex("en");
  assert.equal(result.indexUrl, "https://origin.warframe.com/PublicExport/index_en.txt.lzma");
  assert.ok(result.entries.has("ExportWeapons_en.json"));
});

test("index errors identify the locale, URLs and received header when both hosts fail", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response("invalid compressed response"));
  await assert.rejects(fetchPublicExportIndex("zh"), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /index zh/u);
    assert.equal(error.errors.length, 2);
    assert.match(error.errors[0].message, /content\.warframe\.com.*bytes=27; header=/u);
    assert.match(error.errors[1].message, /origin\.warframe\.com/u);
    return true;
  });
});

test("decodes the real known-size DE index with an end marker without mutating its bytes", async () => {
  const fixture = await readFile(new URL("./fixtures/public-export-index-en.lzma", import.meta.url));
  const original = Buffer.from(fixture);
  const text = await decompressIndex(fixture);
  assert.equal(Buffer.byteLength(text), Number(fixture.readBigUInt64LE(5)));
  assert.equal(parsePublicExportIndex(text).size, 16);
  assert.deepEqual(fixture, original);
  const wrongSize = Buffer.from(fixture);
  wrongSize.writeBigUInt64LE(797n, 5);
  await assert.rejects(decompressIndex(wrongSize), /size mismatch/u);
  const truncated = fixture.subarray(0, Math.floor(fixture.length / 2));
  await assert.rejects(decompressIndex(truncated));
});

test("decompresses XZ and legacy LZMA-alone containers", async () => {
  const native = (await import("lzma-native")).default;
  const expected = "ExportWarframes_en.json!revision-1\nExportRecipes_en.json!revision-2\n";
  const xz = await compressXz(native, expected);
  const alone = await encodeLegacyLzma(Buffer.from(expected));

  assert.equal(await decompressIndex(xz), expected);
  assert.equal(await decompressIndex(alone), expected);
});

test("rejects empty, unsupported, and corrupted compressed indexes", async () => {
  await assert.rejects(decompressIndex(Buffer.alloc(0)), /too short/u);
  await assert.rejects(decompressIndex(Buffer.from("not compressed data")), /unsupported compression header/u);

  const native = (await import("lzma-native")).default;
  const compressed = await compressXz(native, "ExportWarframes_en.json!revision-1\n");
  compressed[compressed.length - 1] = (compressed[compressed.length - 1] ?? 0) ^ 0xff;
  await assert.rejects(decompressIndex(compressed));
});

test("validates Market riven attribute identifiers and duplicates", () => {
  const records = extractAttributes({ data: [{ slug: "damage" }, { slug: "critical_chance" }] });
  assert.equal(records.length, 2);
  assert.equal(records[0]?.url_name, "damage");
  assert.equal(records[0]?.recordKey, "damage");
  assert.throws(() => extractAttributes({ data: [] }), /no data records/u);
  assert.throws(() => extractAttributes({ data: [{ slug: "damage" }, { slug: "damage" }] }), /Duplicate/u);
});

test("projects checked-in Market v2 JSON to NnmBot's registered fields without losing source fields", async () => {
  const v2 = JSON.parse(await readFile(new URL("./fixtures/market-riven-attributes-v2.json", import.meta.url), "utf8")) as unknown;
  const legacy = JSON.parse(await readFile(new URL("./fixtures/market-riven-attributes-reference.json", import.meta.url), "utf8")) as Array<Record<string, unknown>>;
  const [projected] = extractAttributes(v2);
  const reference = legacy[0];

  assert.ok(projected);
  assert.ok(reference);
  assert.equal(projected.url_name, reference.url_name);
  assert.equal(projected.recordKey, reference.url_name);
  assert.equal(projected.group, reference.group);
  assert.equal(projected.prefix, reference.prefix);
  assert.equal(projected.suffix, reference.suffix);
  assert.equal(projected.units, reference.units);
  assert.equal(projected.negative_only, false);
  assert.equal(projected.positive_is_negative, false);
  assert.deepEqual(JSON.parse(String(projected.exclusive_to)), ["archgun", "kitgun", "pistol", "rifle", "shotgun"]);
  assert.equal(projected.id, "5c5ca81a96e8d2003834fe63");
  assert.equal(projected.slug, "ammo_maximum");
  assert.equal(typeof projected.ids, "number");
});

test("projects Market items with stable slugs and gameRef bridge keys", () => {
  const records = projectItems({ data: [
    {
      id: "54aae292e7798909064f1575",
      slug: "secura_dual_cestra",
      gameRef: "/Lotus/Weapons/Syndicates/PerrinSequence/Pistols/PSDualCestra",
      tags: ["syndicate", "weapon", "secondary"],
      i18n: { en: { name: "Secura Dual Cestra", icon: "items/images/en/x.png", thumb: "items/images/en/thumbs/x.png" } },
    },
    { slug: "ancient_fusion_core", gameRef: "", tags: [], i18n: { en: { name: "Ancient Fusion Core" } } },
  ] });
  assert.equal(records.length, 2);
  assert.equal(records[0]?.recordKey, "secura_dual_cestra");
  assert.equal(records[0]?.url_name, "secura_dual_cestra");
  assert.equal(records[0]?.name, "Secura Dual Cestra");
  assert.equal(records[0]?.gameRef, "/Lotus/Weapons/Syndicates/PerrinSequence/Pistols/PSDualCestra");
  assert.deepEqual(records[0]?.tags, ["syndicate", "weapon", "secondary"]);
  assert.equal(records[1]?.gameRef, "");
  assert.throws(() => projectItems({ data: [{ slug: "a" }, { slug: "a" }] }), /Duplicate/u);
  assert.throws(() => projectItems({ data: [] }), /no data records/u);
});

test("cleans successful auto-collected input workspaces while preserving explicit keep requests", async (context) => {
  const root = join(process.cwd(), `.test-input-cleanup-${Date.now()}`);
  const tmp = join(root, "tmp");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(tmp, "inputs-success", "raw"), { recursive: true });
  await writeFile(join(tmp, "inputs-success", "inputs.json"), "[]");

  await cleanupCollectedInputs(join(tmp, "inputs-success"), tmp);
  await assert.rejects(access(join(tmp, "inputs-success")), { code: "ENOENT" });

  await mkdir(join(tmp, "inputs-kept", "raw"), { recursive: true });
  await cleanupCollectedInputs(join(tmp, "inputs-kept"), tmp, true);
  await assert.doesNotReject(access(join(tmp, "inputs-kept")));

  await mkdir(join(root, "explicit-inputs"), { recursive: true });
  await cleanupCollectedInputs(join(root, "explicit-inputs"), tmp);
  await assert.doesNotReject(access(join(root, "explicit-inputs")));
});

test("enriches Market records in place and retains records without catalog identities", () => {
  const capturedAt = "2026-10-22T00:00:00.000Z";
  const source = { project: "test", dataset: "test", url: "https://example.invalid", capturedAt };
  const output = projectMarketItems([
    {
      stage: "cleaned",
      path: "catalog/i18n/items.json",
      content: JSON.stringify({
        "/Lotus/Types/Recipes/TestBlueprint": {
          en: { name: "Test Blueprint" },
          zh: { name: "测试蓝图" },
          iconUrl: "https://content.warframe.com/test.png",
        },
      }),
      source,
    },
  ], [
    { stage: "raw", path: "warframe-market/items-v2.json", content: "{}", source },
    {
      stage: "cleaned",
      path: "market/items.json",
      content: JSON.stringify([
        { slug: "test_blueprint", gameRef: "/Lotus/Types/Recipes/TestBlueprint", name: "Test Blueprint", icon: "items/test.png" },
        { slug: "community_only", gameRef: "", name: "Community Only" },
        { slug: "unknown_game_ref", gameRef: "/Lotus/Unknown/Item", name: "Unknown Item" },
      ]),
      recordCount: 3,
      source,
    },
  ]);

  const projected = output.find((file) => file.path === "market/items.json");
  assert.ok(projected);
  const items = JSON.parse(String(projected.content)) as Array<Record<string, unknown>>;
  assert.equal(items.length, 3);
  assert.deepEqual(items[0]?.gameItem, {
    uniqueName: "/Lotus/Types/Recipes/TestBlueprint",
    name: "Test Blueprint",
    nameZh: "测试蓝图",
    iconUrl: "https://content.warframe.com/test.png",
    resolution: "catalog_match",
  });
  assert.equal(items[1]?.gameRefStatus, "missing_game_ref");
  assert.equal(items[1]?.gameItem, null);
  assert.equal(items[2]?.gameRefStatus, "unresolved_catalog_identity");
  assert.equal(output.some((file) => file.path === "linked/items.json"), false);
  assert.equal(output.some((file) => file.stage === "raw" && file.path === "warframe-market/items-v2.json"), true);
});

test("does not mutate raw Market records while adding the NnmBot projection", () => {
  const value = {
    apiVersion: "fixture",
    data: [{
      slug: "positive_only",
      negativeOnly: true,
      positiveIsNegative: true,
      unit: "percent",
      exclusiveTo: ["rifle"],
      i18n: { en: { name: "Positive Only" } },
    }],
  };
  const rawBefore = JSON.stringify(value);
  const projected = projectAttributes(value);
  assert.equal(JSON.stringify(value), rawBefore);
  assert.equal(projected[0]?.negative_only, true);
  assert.equal(projected[0]?.positive_is_negative, true);
});

async function encodeLegacyLzma(input: Buffer): Promise<Buffer> {
  const native = (await import("lzma-native")).default;
  const encoder = native.createStream("aloneEncoder");
  const chunks: Buffer[] = [];
  const complete = new Promise<void>((resolve, reject) => {
    encoder.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    encoder.once("error", reject);
    encoder.once("end", resolve);
  });
  encoder.end(input);
  await complete;
  return Buffer.concat(chunks);
}

async function compressXz(native: typeof import("lzma-native"), text: string): Promise<Buffer> {
  const compress = native.compress as unknown as (
    input: Buffer,
    options: object,
    callback: (result: Buffer, error?: Error) => void,
  ) => void;
  return new Promise((resolve, reject) => {
    compress(Buffer.from(text), {}, (result, error) => error ? reject(error) : resolve(result));
  });
}
