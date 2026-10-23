import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import type { DatasetFileEntry, DatasetFileInput, DatasetManifest, DatasetStage } from "../domain/contracts.js";
import { canonicalProductPath } from "./product-layout.js";
export { canonicalProductPath } from "./product-layout.js";

export interface PublishResult {
  manifest: DatasetManifest;
  /** 清洗产物目录：data/latest */
  dataDirectory: string;
  /** 采集原始目录：tmp/<YYYY-MM-DDTHH-mm-ss> */
  tmpDirectory: string;
}

export interface VerifyResult {
  buildId: string;
  verifiedFiles: number;
  directory: string;
}

interface PreparedFile {
  entry: DatasetFileEntry;
  bytes: Buffer;
}

/**
 * 把一次采集流水线的产物按阶段落到两棵目录树：
 * - raw（采集到的原始输入）→ `tmp/<时间戳>/<来源>/`
 * - cleaned（清洗后的发布产物）→ `data/latest/<业务域>/`
 * 两棵树各带一份 manifest，记录文件相对各自根目录的路径。
 */
export class DatasetPublisher {
  constructor(
    private readonly dataDirectory: string,
    private readonly tmpDirectory: string,
  ) {}

  async publish(files: DatasetFileInput[], now = new Date()): Promise<PublishResult> {
    if (files.length === 0) throw new Error("Refusing to generate an empty dataset");

    const rawInputs = files.filter((file) => file.stage === "raw");
    const cleanedInputs = files.filter((file) => file.stage === "cleaned");
    if (cleanedInputs.length === 0) throw new Error("Refusing to generate a dataset without cleaned files");

    const rawPrepared = rawInputs.map((file) => prepare(file, "raw"));
    const publishedPaths = new Map(cleanedInputs.map((file) => [file.path, canonicalProductPath(file.path)]));
    const cleanedPrepared = cleanedInputs.map((file) => prepare({
      ...file,
      path: publishedPaths.get(file.path) ?? file.path,
      source: {
        ...file.source,
        ...(file.source.derivedFrom ? { derivedFrom: file.source.derivedFrom.map((path) => publishedPaths.get(path) ?? path) } : {}),
      },
    }, "cleaned"));
    // 按路径排序，保证相同输入（无论顺序）产生相同 manifest / buildId（幂等可复现）。
    const rawEntries = rawPrepared.map(({ entry }) => entry).sort((a, b) => a.path.localeCompare(b.path));
    const cleanedEntries = cleanedPrepared.map(({ entry }) => entry).sort((a, b) => a.path.localeCompare(b.path));

    // derivedFrom 可跨阶段引用（cleaned 引用 raw 的路径），故用全量路径集合校验。
    const allPaths = new Set([...rawEntries, ...cleanedEntries].map((entry) => entry.path.toLowerCase()));
    validateEntries(rawEntries, allPaths, "raw");
    validateEntries(cleanedEntries, allPaths, "cleaned");

    const createdAt = now.toISOString();
    const rawManifest = buildManifest(rawEntries, createdAt, "raw");
    const cleanedManifest = buildManifest(cleanedEntries, createdAt, "cleaned");

    const rawRoot = resolve(this.tmpDirectory, timestampDirectory(now));
    // 覆盖式发布：cleaned 固定写到 data/latest/，只保留一份成品（历史靠 Git 提交追溯）。
    const dataRoot = resolve(this.dataDirectory, "latest");
    await mkdir(this.dataDirectory, { recursive: true });
    await mkdir(this.tmpDirectory, { recursive: true });

    // 清理上次残留的 .gen-backup/.gen-staging（覆盖式备份删除失败时的兜底，见 cleanupLeftovers）。
    await cleanupLeftovers(this.dataDirectory);

    const lock = join(this.dataDirectory, ".gen-lock");
    try {
      await mkdir(lock);
    } catch (error) {
      if (hasCode(error, "EEXIST")) throw new Error("Dataset generation is locked by another run", { cause: error });
      throw error;
    }

    try {
      // raw 树：时间戳目录天然不冲突，staging 写全后原子改名即可。
      // 仅在有原始数据时写（空 raw 不应产生空 manifest，避免校验拒绝）。
      if (rawPrepared.length > 0) {
        await writeTree(this.tmpDirectory, rawRoot, rawPrepared, rawManifest, false, "raw");
      }
      // cleaned 树：同一天重跑需整树替换（先备份旧日期目录）。
      await writeTree(this.dataDirectory, dataRoot, cleanedPrepared, cleanedManifest, true, "cleaned");
    } finally {
      await rm(lock, { recursive: true, force: true });
    }

    // 归档本次 raw 的 plus 与 languages 快照到 cache（兜底），并清理本次 raw 工作区。
    // 冻结输入目录由 acquire 管理并保留，供相同输入重复构建；这里只清理发布原始工作区。
    if (rawPrepared.length > 0) await archiveToCache(this.tmpDirectory, rawRoot);

    return { manifest: cleanedManifest, dataDirectory: dataRoot, tmpDirectory: rawRoot };
  }

  async verify(): Promise<VerifyResult> {
    const directory = latestDataDirectory(this.dataDirectory);
    const result = await verifyDirectory(directory, "cleaned");
    return { ...result, directory };
  }
}

async function writeTree(
  root: string,
  destination: string,
  prepared: PreparedFile[],
  manifest: DatasetManifest,
  replaceExisting: boolean,
  stage: DatasetStage,
): Promise<void> {
  const staging = join(root, `.gen-staging-${randomUUID()}`);
  const backup = join(root, `.gen-backup-${randomUUID()}`);
  await mkdir(staging);
  try {
    for (const { entry, bytes } of prepared) {
      const target = join(staging, ...entry.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeSynced(target, bytes);
    }
    await writeSynced(join(staging, "manifest.json"), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    await verifyDirectory(staging, stage);
    await syncTree(staging);

    if (replaceExisting) {
      let backedUp = false;
      // 显式检查目标是否存在，而非依赖 rename 抛 ENOENT：
      // 某些环境（WorkBuddy 的 brokered-fs-shim）会把"rename 不存在的源"包装成 deny，
      // 导致下面的 ENOENT 捕获失效。先探测存在性可彻底规避。
      if (await exists(destination)) {
        await rename(destination, backup);
        backedUp = true;
      }
      try {
        await rename(staging, destination);
      } catch (error) {
        if (backedUp) {
          try {
            await rename(backup, destination);
          } catch (restoreError) {
            throw new AggregateError([error, restoreError], `Restore the previous dataset from ${backup}`);
          }
        }
        throw error;
      }
      await syncDirectory(root);
      if (backedUp) {
        try {
          await rm(backup, { recursive: true, force: true });
        } catch (error) {
          // 备份删除失败不阻断发布；下次 publish 的 cleanupLeftovers 会清理残留。
          console.warn(`Failed to remove backup ${backup}: ${error instanceof Error ? error.message : error}`);
        }
      }
    } else {
      await rename(staging, destination);
      await syncDirectory(root);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function verifyDirectory(directory: string, stage: DatasetStage): Promise<{ buildId: string; verifiedFiles: number }> {
  const actualPaths = await listFiles(directory);
  const manifest = parseJson(await readFile(join(directory, "manifest.json")), "manifest.json") as DatasetManifest;
  if (manifest?.schemaVersion !== 2 || manifest.producer !== "warframe-datasource-nnm"
    || typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))
    || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("Invalid dataset manifest");
  }
  validateEntries(manifest.files, null, stage);
  if (stage === "cleaned" && manifest.files.some((entry) => entry.source !== undefined)) {
    throw new Error("Cleaned manifests must not expose source metadata");
  }
  if (manifest.buildId !== buildId(manifest.files, manifest.createdAt)) {
    throw new Error("Dataset manifest identity mismatch");
  }
  const expectedPaths = ["manifest.json", ...manifest.files.map((entry) => entry.path)].sort();
  if (JSON.stringify(actualPaths.sort()) !== JSON.stringify(expectedPaths)) {
    throw new Error("Dataset files do not match manifest (missing or unexpected files)");
  }
  for (const entry of manifest.files) {
    const bytes = await readFile(join(directory, ...entry.path.split("/")));
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new Error(`Checksum mismatch: ${entry.path}`);
    }
    if (entry.path.endsWith(".json")) parseJson(bytes, entry.path);
  }
  return { buildId: manifest.buildId, verifiedFiles: manifest.files.length };
}

function prepare(file: DatasetFileInput, stage: DatasetStage): PreparedFile {
  validateRelativePath(file.path, stage);
  if (stage === "cleaned" && file.path.split("/").length > 2) {
    throw new Error(`Cleaned product path exceeds one folder level: ${file.path}`);
  }
  const bytes = Buffer.from(file.content);
  if (bytes.length === 0) throw new Error(`Refusing to generate empty file: ${file.path}`);
  if (file.path.endsWith(".json")) parseJson(bytes, file.path);
  const entry: DatasetFileEntry = {
    path: file.path,
    sha256: sha256(bytes),
    bytes: bytes.length,
    mediaType: mediaTypeFor(file.path),
    source: file.source,
    ...(file.recordCount === undefined ? {} : { recordCount: file.recordCount }),
  };
  return { entry, bytes };
}

function validateEntries(entries: DatasetFileEntry[], allPaths: Set<string> | null, stage: DatasetStage): void {
  const paths = new Set<string>();
  for (const entry of entries) {
    validateRelativePath(entry.path, stage);
    if (stage === "cleaned" && entry.path.split("/").length > 2) throw new Error(`Cleaned product path exceeds one folder level: ${entry.path}`);
    const normalized = entry.path.toLowerCase();
    if (paths.has(normalized)) throw new Error(`Duplicate dataset path: ${entry.path}`);
    paths.add(normalized);
    if (!/^[a-f0-9]{64}$/u.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0
      || (entry.mediaType !== "application/json" && entry.mediaType !== "text/plain" && entry.mediaType !== "text/html")
      || (entry.recordCount !== undefined && (!Number.isSafeInteger(entry.recordCount) || entry.recordCount < 0))
      || (stage === "raw" && !entry.source)
      || (entry.source !== undefined && (typeof entry.source.project !== "string" || typeof entry.source.dataset !== "string"
        || typeof entry.source.url !== "string" || !Number.isFinite(Date.parse(entry.source.capturedAt))))) {
      throw new Error(`Invalid dataset manifest entry: ${entry.path}`);
    }
  }
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      if (paths.has(parts.slice(0, i).join("/").toLowerCase())) {
        throw new Error(`Conflicting dataset paths: ${entry.path}`);
      }
    }
    for (const input of entry.source?.derivedFrom ?? []) {
      validateRelativePath(input, "raw");
      if (input.toLowerCase() === entry.path.toLowerCase()) {
        throw new Error(`Self-referencing dataset input: ${input}`);
      }
      // 发布时校验引用存在（含跨阶段），离线校验时跳过（raw 在另一棵目录树）。
      if (allPaths !== null && !allPaths.has(input.toLowerCase())) {
        throw new Error(`Missing dataset input: ${input}`);
      }
    }
  }
}

function validateRelativePath(path: string, stage: DatasetStage): void {
  if (typeof path !== "string"
    || !(path.endsWith(".json") || (stage === "raw" && (path.endsWith(".txt") || path.endsWith(".html"))))
    || path.split("/").some((part) => !/^[a-z0-9][a-z0-9._-]*$/iu.test(part) || part === "." || part === "..")) {
    throw new Error(`Invalid dataset path: ${path}`);
  }
  if (path.toLowerCase() === "manifest.json") throw new Error(`Reserved dataset path: ${path}`);
  if (stage === "cleaned" && path.split("/").length > 2) throw new Error(`Published dataset path exceeds one business directory: ${path}`);
}

function mediaTypeFor(path: string): "application/json" | "text/plain" | "text/html" {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".txt")) return "text/plain";
  if (path.endsWith(".html")) return "text/html";
  throw new Error(`Unsupported dataset media type: ${path}`);
}

function buildManifest(entries: DatasetFileEntry[], createdAt: string, stage: DatasetStage): DatasetManifest {
  const publishedEntries = stage === "raw"
    ? entries
    : entries.map(({ source: _source, ...entry }) => entry);
  return {
    schemaVersion: 2,
    buildId: buildId(publishedEntries, createdAt),
    createdAt,
    producer: "warframe-datasource-nnm",
    files: publishedEntries,
  };
}

function buildId(entries: DatasetFileEntry[], createdAt: string): string {
  return `${createdAt.replace(/[-:.]/gu, "")}-${sha256(Buffer.from(JSON.stringify(entries))).slice(0, 12)}`;
}

function timestampDirectory(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

/** 清理 data/ 下残留的 .gen-backup-* / .gen-staging-*（覆盖式备份删除失败时兜底）。 */
async function cleanupLeftovers(dataDirectory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dataDirectory, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".gen-backup-") || entry.name.startsWith(".gen-staging-")) {
      await rm(join(dataDirectory, entry.name), { recursive: true, force: true });
    }
  }
}

/** 把本次 raw 快照的 plus/ 与 languages/ 目录 gzip 压缩到 tmp/cache/，然后清理时间戳工作区（WF_KEEP_TMP=1 时保留）。 */
async function archiveToCache(tmpDirectory: string, rawRoot: string): Promise<void> {
  const cacheDir = join(tmpDirectory, "cache");
  await rm(cacheDir, { recursive: true, force: true });
  await mkdir(cacheDir, { recursive: true });
  await archiveDirectory(join(rawRoot, "plus"), join(cacheDir, "plus"));
  await archiveDirectory(join(rawRoot, "languages"), join(cacheDir, "languages"));
  if (process.env.WF_KEEP_TMP !== "1") {
    await pruneTmpWorkspaces(tmpDirectory);
  }
}

/** 把某个来源目录下的 .json 文件 gzip 到目标目录；来源不存在则跳过。 */
async function archiveDirectory(sourceDir: string, destDir: string): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(sourceDir)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  await mkdir(destDir, { recursive: true });
  for (const name of names) {
    const bytes = await readFile(join(sourceDir, name));
    await writeFile(join(destDir, `${name}.gz`), gzipSync(bytes));
  }
}

/** 清理 tmp 下所有时间戳工作区目录（保留 cache/）。 */
async function pruneTmpWorkspaces(tmpDirectory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(tmpDirectory, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/u.test(entry.name)) {
      await rm(join(tmpDirectory, entry.name), { recursive: true, force: true });
    }
  }
}

/** cleaned 采用覆盖式发布，固定目录 data/latest，无需按日期挑选。 */
function latestDataDirectory(dataDirectory: string): string {
  return join(dataDirectory, "latest");
}

function parseJson(bytes: Buffer, path: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON: ${path}`, { cause: error });
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasCode(error: unknown, code: string): boolean {
  if (!(error instanceof Error)) return false;
  if ("code" in error && error.code === code) return true;
  // 兼容 WorkBuddy 的 brokered-fs-shim：它把文件操作错误包装成 CODEBUDDY_BROKER_DENY，
  // 但 message 里保留原始错误码（如 "EEXIST: file already exists"）。
  return error.message.startsWith(`${code}:`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported dataset entry (links are not allowed): ${relative}`);
  }
  return files;
}

async function writeSynced(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await syncTree(join(root, entry.name));
  }
  await syncDirectory(root);
}
