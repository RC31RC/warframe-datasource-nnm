import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { DatasetFileInput, DatasetStage } from "../src/domain/contracts.js";
import { DatasetPublisher } from "../src/publish/dataset-publisher.js";

const now = new Date(2026, 9, 21, 0, 0, 0);
const capturedAt = now.toISOString();
const date = "latest";
const timestamp = "2026-10-21T00-00-00";
const source = {
  project: "test",
  dataset: "test",
  url: "https://example.invalid/test.json",
  capturedAt,
};

// 测试临时目录落在项目内，规避工作目录外的 fs shim rename 拦截。
const projectRoot = resolve(import.meta.dirname, "..");

function file(path = "catalog/test.json", content = "{}", stage: DatasetStage = "cleaned"): DatasetFileInput {
  return { stage, path, content, recordCount: 1, source };
}

async function makeRoots() {
  const base = await mkdtemp(join(projectRoot, ".test-tmp-"));
  return { base, data: join(base, "data"), tmp: join(base, "tmp") };
}

test("archives raw plus snapshot to tmp/cache and clears raw workspace", async (context) => {
  const { base, data, tmp } = await makeRoots();
  context.after(() => rm(base, { recursive: true, force: true }));
  const publisher = new DatasetPublisher(data, tmp);
  const result = await publisher.publish([
    file("plus/ExportEnemies.json", '{"raw":true}', "raw"),
    file("catalog/test.json", '{"cleaned":true}'),
  ], new Date(capturedAt));

  assert.equal(result.manifest.producer, "warframe-datasource-nnm");
  assert.equal(result.manifest.schemaVersion, 3);
  assert.deepEqual(result.manifest.files.map(({ path }) => path), ["catalog/test.json.gz"]);
  assert.equal(result.manifest.files[0]?.source, undefined);
  assert.equal(result.manifest.files[0]?.mediaType, "application/gzip");
  assert.equal(result.dataDirectory, join(data, date));
  assert.equal(result.tmpDirectory, join(tmp, timestamp));

  // cleaned 树在 data/latest/，带 manifest
  assert.deepEqual(JSON.parse(gunzipSync(await readFile(join(data, date, "catalog/test.json.gz"))).toString("utf8")), { cleaned: true });
  assert.deepEqual(JSON.parse(gunzipSync(await readFile(join(data, date, "manifest.json.gz"))).toString("utf8")), result.manifest);
  await assert.rejects(access(join(data, date, "catalog/test.json")), { code: "ENOENT" });
  // raw 工作区被清理，仅剩 tmp/cache
  await assert.rejects(access(join(tmp, timestamp)), { code: "ENOENT" });
  const cacheBytes = await readFile(join(tmp, "cache", "plus", "ExportEnemies.json.gz"));
  assert.deepEqual(JSON.parse(gunzipSync(cacheBytes).toString("utf8")), { raw: true });

  // verify 定位 data/latest
  const verified = await publisher.verify();
  assert.equal(verified.buildId, result.manifest.buildId);
  assert.equal(verified.verifiedFiles, 1);
  assert.equal(verified.directory, join(data, date));
});

test("replaces the same-date cleaned tree and removes stale datasets", async (context) => {
  const { base, data, tmp } = await makeRoots();
  context.after(() => rm(base, { recursive: true, force: true }));
  const publisher = new DatasetPublisher(data, tmp);
  await publisher.publish([file("old.json"), file("catalog/test.json", '["before"]')], new Date(capturedAt));
  await publisher.publish([file("catalog/test.json", '["after"]')], new Date(capturedAt));
  assert.equal((await publisher.verify()).verifiedFiles, 1);
  assert.deepEqual(JSON.parse(gunzipSync(await readFile(join(data, date, "catalog/test.json.gz"))).toString("utf8")), ["after"]);
  await assert.rejects(access(join(data, date, "old.json.gz")), { code: "ENOENT" });
});

test("keeps previous output intact when inputs fail validation", async (context) => {
  const { base, data, tmp } = await makeRoots();
  context.after(() => rm(base, { recursive: true, force: true }));
  const publisher = new DatasetPublisher(data, tmp);
  const result = await publisher.publish([file()], new Date(capturedAt));
  const before = await readFile(join(data, date, "manifest.json.gz"));
  await assert.rejects(publisher.publish([]), /empty dataset/u);
  await assert.rejects(publisher.publish([file("x.json", "{}", "raw")]), /without cleaned files/u);
  for (const path of ["../escape.json", "/absolute.json", "a/../b.json", "a\\b.json", "a//b.json", "a.js"]) {
    await assert.rejects(publisher.publish([file(path)]), /Invalid dataset path/u);
  }
  await assert.rejects(publisher.publish([file("manifest.json")]), /Reserved/u);
  await assert.rejects(publisher.publish([file("test.json", "not json")]), /Invalid JSON/u);
  await assert.rejects(publisher.publish([file("test.json", "")]), /empty file/u);
  await assert.rejects(publisher.publish([file(), file()]), /Duplicate/u);
  await assert.rejects(publisher.publish([file("TEST.json"), file("test.json")]), /Duplicate/u);
  await assert.rejects(publisher.publish([file("file.json"), file("file.json.gz/child.json")]), /Conflicting/u);
  await assert.rejects(publisher.publish([{ ...file(), recordCount: -1 }]), /Invalid dataset manifest entry/u);
  assert.deepEqual(await readFile(join(data, date, "manifest.json.gz")), before);
  assert.equal((await publisher.verify()).buildId, result.manifest.buildId);
});

test("allows cleaned files to reference raw inputs across trees and rejects dangling lineage", async (context) => {
  const { base, data, tmp } = await makeRoots();
  context.after(() => rm(base, { recursive: true, force: true }));
  const publisher = new DatasetPublisher(data, tmp);
  const derived = {
    ...file("catalog/derived.json"),
    source: { ...source, derivedFrom: ["public-export/en/ExportTest_en.json"] },
  };
  await assert.rejects(publisher.publish([derived]), /Missing dataset input/u);
  await publisher.publish([derived, file("public-export/en/ExportTest_en.json", "{}", "raw")]);
  assert.equal((await publisher.verify()).verifiedFiles, 1);
});

test("locks generation so concurrent writers cannot replace each other's outputs", async (context) => {
  const { base, data, tmp } = await makeRoots();
  context.after(() => rm(base, { recursive: true, force: true }));
  const publisher = new DatasetPublisher(data, tmp);
  await publisher.publish([file()], new Date(capturedAt));
  await mkdir(join(data, ".gen-lock"));
  await assert.rejects(publisher.publish([file("new.json")]), /locked by another run/u);
  await access(join(data, ".gen-lock"));
  assert.equal((await publisher.verify()).verifiedFiles, 1);
});

test("reproduces identical output for the same timestamp and inputs", async (context) => {
  const { base, data, tmp } = await makeRoots();
  context.after(() => rm(base, { recursive: true, force: true }));
  const publisher = new DatasetPublisher(data, tmp);
  const first = await publisher.publish([file("b.json"), file("a.json")], new Date(capturedAt));
  const firstBytes = await readFile(join(data, date, "a.json.gz"));
  const second = await publisher.publish([file("a.json"), file("b.json")], new Date(capturedAt));
  assert.deepEqual(second.manifest, first.manifest);
  assert.deepEqual(await readFile(join(data, date, "a.json.gz")), firstBytes);
});

test("detects corrupted, missing, unlisted, and symlinked files", async (context) => {
  const { base, data, tmp } = await makeRoots();
  context.after(() => rm(base, { recursive: true, force: true }));
  const publisher = new DatasetPublisher(data, tmp);
  await publisher.publish([file()], new Date(capturedAt));
  await writeFile(join(data, date, "catalog/test.json.gz"), '{"tampered":true}');
  await assert.rejects(publisher.verify(), /Checksum mismatch/u);
  await publisher.publish([file()], new Date(capturedAt));
  await rm(join(data, date, "catalog/test.json.gz"));
  await assert.rejects(publisher.verify(), /missing or unexpected/u);
  await publisher.publish([file()], new Date(capturedAt));
  await writeFile(join(data, date, "extra.json"), "{}");
  await assert.rejects(publisher.verify(), /missing or unexpected/u);
  await publisher.publish([file()], new Date(capturedAt));
  await rm(join(data, date, "catalog/test.json.gz"));
  await writeFile(join(data, "external.json"), "{}");
  await symlink(join(data, "external.json"), join(data, date, "catalog/test.json.gz"));
  await assert.rejects(publisher.verify(), /links are not allowed/u);
});

test("detects edited manifest metadata", async (context) => {
  const { base, data, tmp } = await makeRoots();
  context.after(() => rm(base, { recursive: true, force: true }));
  const publisher = new DatasetPublisher(data, tmp);
  const result = await publisher.publish([file()], new Date(capturedAt));
  result.manifest.files[0]!.sha256 = "0".repeat(64);
  await writeFile(join(data, date, "manifest.json.gz"), gzipSync(Buffer.from(JSON.stringify(result.manifest))));
  await assert.rejects(publisher.verify(), /identity mismatch/u);
});

test("rejects source metadata in a cleaned manifest", async (context) => {
  const { base, data, tmp } = await makeRoots();
  context.after(() => rm(base, { recursive: true, force: true }));
  const publisher = new DatasetPublisher(data, tmp);
  const result = await publisher.publish([file()], new Date(capturedAt));
  const manifest = result.manifest as unknown as { files: Array<Record<string, unknown>> };
  manifest.files[0]!.source = source;
  await writeFile(join(data, date, "manifest.json.gz"), gzipSync(Buffer.from(JSON.stringify(manifest))));
  await assert.rejects(publisher.verify(), /must not expose source metadata/u);
});

test("CLI verifies local output and refuses the removed serve command", async (context) => {
  const { base, data, tmp } = await makeRoots();
  context.after(() => rm(base, { recursive: true, force: true }));
  await new DatasetPublisher(data, tmp).publish([file()], new Date(capturedAt));
  const run = promisify(execFile);
  const options = { env: { ...process.env, DATASOURCE_DATA_DIR: data, DATASOURCE_TMP_DIR: tmp }, timeout: 10_000 };
  const result = await run(process.execPath, ["--import", "tsx", "src/cli.ts", "verify"], options);
  assert.match(result.stdout, /Verified 1 files/u);
  await assert.rejects(run(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], options),
    (error: unknown) => error instanceof Error && error.message.includes("Unknown command: serve"));
});

test("publisher maps business aliases atomically and rejects colliding public paths", async (context) => {
  const { base, data, tmp } = await makeRoots();
  context.after(() => rm(base, { recursive: true, force: true }));
  const publisher = new DatasetPublisher(data, tmp);
  const result = await publisher.publish([file("plus/vendors.json", '{"vendor":true}'), file("languages/en.json", '{"key":"English"}')], new Date(capturedAt));
  assert.deepEqual(result.manifest.files.map(({ path }) => path), ["reference/language-en.json.gz", "world/vendors.json.gz"]);
  assert.equal((await publisher.verify()).verifiedFiles, 2);
  await assert.rejects(access(join(data, date, "plus/vendors.json")), { code: "ENOENT" });
  await assert.rejects(publisher.publish([file("plus/vendors.json"), file("world/vendors.json")]), /Duplicate/u);
  await assert.rejects(publisher.publish([file("unmapped/deep/file.json")]), /one business directory/u);
  assert.equal((await publisher.verify()).verifiedFiles, 2);
});
