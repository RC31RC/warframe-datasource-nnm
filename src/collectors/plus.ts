import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join, sep } from "node:path";
import { config } from "../core/config.js";
import { fetchBytes } from "../core/http.js";
import { runPluto } from "../core/pluto.js";
import type { DatasetFileInput } from "../domain/contracts.js";

/**
 * Plus 数据族：官方 Public Export 没有、需 Pluto 工具链从游戏资源提取的数据。
 *
 * 输出分两阶段：
 * - raw：所有 Export*.json 原样快照，写入 tmp/<ts>/plus/（含重叠域，作输入素材）。
 * - cleaned：官方 Export 没有的独有域透传发布，写入 data/<date>/plus/。
 *
 * 数据获取采用降级链（生产路径，见 acquirePlusFiles）：
 *   1. 有 Warframe 游戏与包数据 → Pluto 从本地游戏包提取
 *   2. 无游戏 → 从成品仓库 GitHub Raw 拉取
 *   3. Raw 失败 → 从 tmp 最近一次含 plus 的快照拷贝（上一次采集的数据）
 */

/** 官方 Export 没有的独有域，直接透传发布。 */
const EXCLUSIVE_EXPORTS = [
  "Achievements",
  "Animals",
  "BoosterPacks",
  "Boosters",
  "Bounties",
  "Bundles",
  "Challenges",
  "Codex",
  "CreditBundles",
  "EmailItems",
  "Enemies",
  "Images",
  "Intrinsics",
  "Nightwave",
  "Rewards",
  "TextIcons",
  "Tilesets",
  "Vendors",
  "Virtuals",
] as const;

/** plus 仓库全部 Export 数据族（独有域 + 与官方重叠域），作 raw 快照的完整清单。 */
const ALL_PLUS_EXPORTS = [
  "Abilities", "Achievements", "Animals", "Arcanes", "Avionics",
  "BoosterPacks", "Boosters", "Bounties", "Bundles", "Challenges",
  "Codex", "CreditBundles", "Customs", "DojoRecipes", "Drones",
  "EmailItems", "Enemies", "Factions", "Flavour", "FocusUpgrades",
  "FusionBundles", "Gear", "Images", "Intrinsics", "Keys",
  "MissionTypes", "ModSet", "Nightwave", "RailjackWeapons", "Recipes",
  "Regions", "Relics", "Resources", "Rewards", "Sentinels",
  "Syndicates", "Systems", "TextIcons", "Tilesets", "Upgrades",
  "Vendors", "Virtuals", "Warframes", "Weapons",
] as const;

const UPSTREAM_REPOSITORY = "https://github.com/calamity-inc/warframe-public-export-plus";

export async function collectPlusExports(
  now = new Date(),
  sourceDirectory?: string,
  exclusiveNames: readonly string[] = EXCLUSIVE_EXPORTS,
): Promise<DatasetFileInput[]> {
  const capturedAt = now.toISOString();
  const output: DatasetFileInput[] = [];

  // 测试可注入 sourceDirectory 直接读本地目录；生产走降级链。
  const dataFiles = sourceDirectory !== undefined
    ? await readDirectoryFiles(sourceDirectory)
    : await acquirePlusFiles();
  validatePlusFiles(dataFiles, sourceDirectory === undefined ? ALL_PLUS_EXPORTS : exclusiveNames);

  // raw 阶段：快照全部 Export*.json。
  for (const fileName of [...dataFiles.keys()].sort()) {
    const name = fileName.slice("Export".length, -".json".length);
    const bytes = dataFiles.get(fileName);
    if (!bytes) throw new Error(`Missing raw-plus input for ${name}: ${fileName}`);
    parsePlusJson(bytes, name);
    output.push({
      stage: "raw",
      path: `plus/${fileName}`,
      content: bytes,
      source: {
        project: "warframe-public-export-plus",
        dataset: `plus/raw/${name}`,
        url: `${UPSTREAM_REPOSITORY}/blob/senpai/${fileName}`,
        capturedAt,
        upstreamRevision: createHash("sha256").update(bytes).digest("hex"),
      },
    });
  }

  // 新客户端导出域可选；旧 Raw 兜底缺少该域时不制造空定义。
  const cleanedNames = [...exclusiveNames, ...["ActivityResources"].filter((name) => dataFiles.has(`Export${name}.json`) && !exclusiveNames.includes(name))];
  // cleaned 阶段：独有域透传发布。
  for (const name of cleanedNames) {
    const fileName = `Export${name}.json`;
    const bytes = dataFiles.get(fileName);
    if (!bytes) throw new Error(`Missing raw-plus input for ${name}: ${fileName}`);
    const value = parsePlusJson(bytes, name);
    output.push({
      stage: "cleaned",
      path: `plus/${name.toLowerCase()}.json`,
      content: bytes,
      recordCount: countRecords(value, name),
      source: {
        project: "warframe-public-export-plus",
        dataset: `plus/${name}`,
        url: `${UPSTREAM_REPOSITORY}/blob/senpai/${fileName}`,
        capturedAt,
        upstreamRevision: createHash("sha256").update(bytes).digest("hex"),
        transformer: "warframe-datasource-nnm/plus-exclusive-pass-through@1",
        derivedFrom: [`plus/${fileName}`],
      },
    });
  }

  return output;
}

/**
 * 降级链获取 plus 数据文件。
 * 返回 Map<fileName, Buffer>，fileName 形如 `ExportEnemies.json`。
 */
async function acquirePlusFiles(): Promise<Map<string, Buffer>> {
  const plutoFiles = await tryCollectPlusWithPluto();
  if (plutoFiles) return plutoFiles;

  // Pluto 不可用时从成品 Raw 获取。
  try {
    return await fetchPlusFromRaw();
  } catch (error) {
    console.warn(`获取 Plus Raw 失败（${error instanceof Error ? error.message : error}），降级为 cache 快照`);
  }

  // Raw 失败时从最近一次经过校验的 plus cache 恢复。
  return copyPlusFromCache();
}

async function tryCollectPlusWithPluto(): Promise<Map<string, Buffer> | undefined> {
  if (!config.warframeGameDir || !config.packagesBinDir
    || !await hasWarframeClient(config.warframeGameDir)
    || !await isDirectory(config.packagesBinDir)) {
    return undefined;
  }

  const script = join(config.plutoDirectory, "plus-gen", "index.pluto");
  if (!await exists(script)) return undefined;
  let outputDirectory: string | undefined;
  try {
    outputDirectory = await mkdtemp(join(config.plutoDirectory, ".plus-output-"));
    await runPluto(
      config.plutoRuntime ?? "pluto",
      script,
      join(config.plutoDirectory, "plus-gen"),
      config.plutoTimeoutMs,
      {
        ...process.env,
        WF_PACKAGES_BIN_DIR: config.packagesBinDir,
        WF_PLUTO_PLUS_OUTPUT_DIR: `${outputDirectory}${sep}`,
      },
    );
    const files = await readDirectoryFiles(outputDirectory);
    validatePlusFiles(files, ALL_PLUS_EXPORTS);
    return files;
  } catch (error) {
    console.warn(`Pluto Plus 提取未通过校验，改用 Raw 降级：${error instanceof Error ? error.message : error}`);
    return undefined;
  } finally {
    if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
  }
}

async function fetchPlusFromRaw(): Promise<Map<string, Buffer>> {
  return fetchPlusFromRawWithOptions();
}

interface PlusRawFetchOptions {
  baseUrls?: readonly string[];
  cacheDirectory?: string;
  fetcher?: typeof fetchBytes;
  requiredNames?: readonly string[];
}

/**
 * 按文件获取 Plus Raw。单个导出文件失败时只回退该文件，避免一个大文件
 * 的 CDN 超时把其余已经更新成功的导出全部降级为旧快照。
 *
 * 该函数保留为导出函数，方便在没有游戏客户端的环境中对降级链做离线测试。
 */
export async function fetchPlusFromRawWithOptions(options: PlusRawFetchOptions = {}): Promise<Map<string, Buffer>> {
  const requiredNames = options.requiredNames ?? ALL_PLUS_EXPORTS;
  const baseUrls = plusRawBaseUrls(options.baseUrls ?? [config.plusRawBaseUrl]);
  const cacheDirectory = options.cacheDirectory ?? join(config.tmpDirectory, "cache", "plus");
  const fetcher = options.fetcher ?? fetchBytes;
  const githubRepository = parseGitHubRepository(baseUrls);
  let githubTreePromise: Promise<Map<string, string>> | undefined;
  const files = new Map<string, Buffer>();
  const missing: string[] = [];

  await mapLimit(requiredNames, 4, async (name) => {
    const fileName = `Export${name}.json`;
    let lastError: unknown;
    const failures: string[] = [];
    for (const baseUrl of baseUrls) {
      const url = `${baseUrl}/${fileName}`;
      try {
        const bytes = await fetcher(url, {
          timeoutMs: config.requestTimeoutMs,
          maxBytes: config.maxResponseBytes,
          retries: config.requestRetries,
        });
        countRecords(parsePlusJson(bytes, name), name);
        files.set(fileName, bytes);
        return;
      } catch (error) {
        lastError = error;
        failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Raw/CDN 失败时使用 GitHub Git API。该接口通过 blob SHA 读取，兼容超过
    // Contents API 1 MB 限制的 ExportRewards 等大文件。
    if (githubRepository) {
      try {
        githubTreePromise ??= fetchGitHubTree(githubRepository, fetcher);
        const tree = await githubTreePromise;
        const sha = tree.get(fileName);
        if (!sha) throw new Error(`file is not present in branch tree: ${fileName}`);
        const blobUrl = `https://api.github.com/repos/${githubRepository.owner}/${githubRepository.repository}/git/blobs/${sha}`;
        const blobResponse = await fetcher(blobUrl, githubApiOptions());
        const bytes = decodeGitHubBlob(blobResponse, fileName);
        countRecords(parsePlusJson(bytes, name), name);
        files.set(fileName, bytes);
        return;
      } catch (error) {
        failures.push(`GitHub Git API: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const cached = await readCachedPlusFile(cacheDirectory, fileName, name);
    if (cached) {
      files.set(fileName, cached);
      console.warn(`[plus] ${fileName} 的 Raw 拉取失败，使用该文件的 cache 快照；尝试记录：${failures.join(" | ")}`);
      return;
    }

    const reason = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
    missing.push(`${fileName}: ${reason}; attempts=${failures.join(" | ")}`);
  });

  if (missing.length > 0) {
    throw new Error(`Plus Raw and cache are unavailable for ${missing.join("; ")}`);
  }
  validatePlusFiles(files, requiredNames);
  return files;
}

interface GitHubRepository {
  owner: string;
  repository: string;
  ref: string;
}

function parseGitHubRepository(baseUrls: readonly string[]): GitHubRepository | undefined {
  for (const rawBase of baseUrls) {
    const match = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)(?:\/data)?$/u.exec(rawBase.replace(/\/+$/u, ""));
    if (match?.[1] && match[2] && match[3]) return { owner: match[1], repository: match[2], ref: match[3] };
  }
  return undefined;
}

async function fetchGitHubTree(
  repository: GitHubRepository,
  fetcher: typeof fetchBytes,
): Promise<Map<string, string>> {
  const treeUrl = `https://api.github.com/repos/${repository.owner}/${repository.repository}/git/trees/${encodeURIComponent(repository.ref)}?recursive=1`;
  const response = await fetcher(treeUrl, githubApiOptions());
  let value: unknown;
  try {
    value = JSON.parse(response.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Invalid GitHub tree JSON: ${treeUrl}`, { cause: error });
  }
  const entries = Array.isArray((value as { tree?: unknown } | null)?.tree)
    ? (value as { tree: unknown[] }).tree
    : [];
  const result = new Map<string, string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const path = (entry as { path?: unknown }).path;
    const sha = (entry as { sha?: unknown }).sha;
    const type = (entry as { type?: unknown }).type;
    if (type === "blob" && typeof path === "string" && typeof sha === "string") result.set(path, sha);
  }
  if (result.size === 0) throw new Error(`GitHub tree has no files: ${treeUrl}`);
  return result;
}

function decodeGitHubBlob(bytes: Buffer, fileName: string): Buffer {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Invalid GitHub blob JSON for ${fileName}`, { cause: error });
  }
  const content = (value as { content?: unknown } | null)?.content;
  const encoding = (value as { encoding?: unknown } | null)?.encoding;
  if (encoding !== "base64" || typeof content !== "string") {
    throw new Error(`GitHub blob has no base64 content for ${fileName}`);
  }
  return Buffer.from(content.replace(/\s/gu, ""), "base64");
}

function githubApiOptions() {
  return {
    timeoutMs: config.requestTimeoutMs,
    maxBytes: config.maxResponseBytes,
    retries: config.requestRetries,
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "warframe-datasource-nnm",
    },
  };
}

/** 返回仓库根目录、兼容旧布局的 data/ 目录，以及 GitHub raw 页面入口。 */
function plusRawBaseUrls(baseUrls: readonly string[]): string[] {
  const candidates: string[] = [];
  for (const rawBase of baseUrls) {
    const base = rawBase.replace(/\/+$/u, "");
    candidates.push(base);
    if (!base.endsWith("/data")) candidates.push(`${base}/data`);

    const match = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)(?:\/data)?$/u.exec(base);
    if (match) {
      const [, owner, repository, ref] = match;
      if (owner && repository && ref) {
        const githubRaw = `https://github.com/${owner}/${repository}/raw/refs/heads/${ref}`;
        candidates.push(githubRaw, `${githubRaw}/data`);
      }
    }
  }
  return [...new Set(candidates)];
}

async function readCachedPlusFile(cacheDirectory: string, fileName: string, name: string): Promise<Buffer | undefined> {
  try {
    const compressed = await readFile(join(cacheDirectory, `${fileName}.gz`));
    const bytes = gunzipSync(compressed);
    countRecords(parsePlusJson(bytes, name), name);
    return bytes;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    console.warn(`[plus] cache 文件 ${fileName} 无法读取或校验：${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

async function copyPlusFromCache(): Promise<Map<string, Buffer>> {
  const cacheDir = join(config.tmpDirectory, "cache", "plus");
  let names: string[];
  try {
    names = (await readdir(cacheDir)).filter((name) => name.endsWith(".gz"));
  } catch (error) {
    throw new Error(`tmp cache is missing plus snapshot: ${cacheDir}`, { cause: error });
  }
  if (names.length === 0) throw new Error(`tmp cache plus snapshot is empty: ${cacheDir}`);
  const files = new Map<string, Buffer>();
  for (const name of names) {
    const bytes = await readFile(join(cacheDir, name));
    files.set(name.slice(0, -".gz".length), gunzipSync(bytes));
  }
  validatePlusFiles(files, ALL_PLUS_EXPORTS);
  return files;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

export function validatePlusFiles(files: Map<string, Buffer>, requiredNames: readonly string[] = ALL_PLUS_EXPORTS): void {
  for (const name of requiredNames) {
    const fileName = `Export${name}.json`;
    const bytes = files.get(fileName);
    if (!bytes) throw new Error(`Missing raw-plus input: ${fileName}`);
    countRecords(parsePlusJson(bytes, name), name);
  }
}

async function readDirectoryFiles(directory: string): Promise<Map<string, Buffer>> {
  let names: string[];
  try {
    names = (await readdir(directory))
      .filter((name) => /^Export[A-Za-z0-9]+\.json$/u.test(name))
      .sort();
  } catch (error) {
    throw new Error(`Missing raw-plus input directory: ${directory}`, { cause: error });
  }
  const files = new Map<string, Buffer>();
  for (const name of names) {
    files.set(name, await readFile(join(directory, name)));
  }
  return files;
}

async function hasWarframeClient(gameDir: string): Promise<boolean> {
  const markers = ["Warframe.x64.exe", "Launcher.exe", "Cache.Windows", "Tools"];
  for (const marker of markers) {
    if (await exists(join(gameDir, marker))) return true;
  }
  return false;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function mapLimit<T>(items: readonly T[], limit: number, mapper: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) throw new Error("Concurrent collection index out of range");
      await mapper(item);
    }
  });
  await Promise.all(workers);
}

function parsePlusJson(bytes: Buffer, name: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Invalid raw-plus JSON for ${name}`, { cause: error });
  }
}

function countRecords(value: unknown, name: string): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "object" && value !== null) {
    return Object.keys(value as Record<string, unknown>).length;
  }
  throw new Error(`raw-plus payload for ${name} must be an object or array`);
}
