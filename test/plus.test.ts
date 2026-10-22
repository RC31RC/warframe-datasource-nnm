import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectPlusExports } from "../src/collectors/plus.js";

test("passes exclusive Plus domains through with source lineage", async () => {
  const root = await mkdtemp(join(tmpdir(), "warframe-datasource-plus-"));
  const rawPlus = join(root, "raw-plus");
  await mkdir(rawPlus, { recursive: true });
  await writeFile(join(rawPlus, "ExportEnemies.json"), JSON.stringify({ agents: { "A": { uniqueName: "A" } } }));
  await writeFile(join(rawPlus, "ExportVendors.json"), JSON.stringify([{ a: 1 }, { b: 2 }]));

  try {
    const output = await collectPlusExports(new Date("2026-10-22T00:00:00.000Z"), rawPlus, ["Enemies", "Vendors"]);
    const enemies = output.find((f) => f.path === "plus/enemies.json");
    const vendors = output.find((f) => f.path === "plus/vendors.json");
    assert.ok(enemies);
    assert.ok(vendors);
    assert.equal(enemies.recordCount, 1);
    assert.equal(vendors.recordCount, 2);
    assert.equal(enemies.source.project, "warframe-public-export-plus");
    assert.equal(enemies.source.transformer, "warframe-datasource-nnm/plus-exclusive-pass-through@1");
    assert.deepEqual(JSON.parse(String(enemies.content)), { agents: { "A": { uniqueName: "A" } } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects missing or invalid raw-plus inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "warframe-datasource-plus-"));
  const rawPlus = join(root, "raw-plus");
  await mkdir(rawPlus, { recursive: true });
  try {
    await assert.rejects(collectPlusExports(new Date(), rawPlus, ["Enemies"]), /Missing raw-plus input/u);
    await writeFile(join(rawPlus, "ExportEnemies.json"), "not json");
    await assert.rejects(collectPlusExports(new Date(), rawPlus, ["Enemies"]), /Invalid raw-plus JSON/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
