import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { config } from "../core/config.js";
import { describeError, fetchBytes } from "../core/http.js";
import { createGitHubCdnFallback } from "../core/github-cdn.js";
import { runPluto } from "../core/pluto.js";
import type { DatasetFileInput } from "../domain/contracts.js";

/**
 * warframe-languages-bin-data：Pluto 从游戏资源提取的游戏内语言字符串表（一手数据）。
 * 每语言 140,358 条，键形如 /Lotus/Language/Locations/Apollodorus，值是该语言文本。
 * 官方 HTTP 只暴露 MOTD（每日消息），全量语言表只能由 Pluto 从游戏 B.Cache.Windows_<lang>.bin 提取。
 *
 * 语言表产物走 Pluto → GitHub Raw → CDN → tmp/cache 降级链。
 */
const UPSTREAM_REPOSITORY = "https://github.com/calamity-inc/warframe-languages-bin-data";

/** 代码簿当前只需中英两种语言（官方 Export 已覆盖 en 主名，zh 用于本地化名）。 */
const LOCALES = ["en", "zh"] as const;
const MIN_LANGUAGE_RECORDS = 10_000;

export async function collectLanguagesBinData(now = new Date()): Promise<DatasetFileInput[]> {
  const capturedAt = now.toISOString();
  const output: DatasetFileInput[] = [];
  const files = await acquireLanguagePair();
  validateLanguagePair(files);
  for (const locale of LOCALES) {
    const bytes = files.get(locale);
    if (!bytes) throw new Error(`Missing language snapshot: ${locale}.json`);
    const records = parseLanguages(bytes, locale);
    const upstreamRevision = createHash("sha256").update(bytes).digest("hex");
    output.push({
      stage: "raw",
      path: `languages/${locale}.json`,
      content: bytes,
      source: {
        project: "warframe-languages-bin-data",
        dataset: `languages/${locale}`,
        url: `${UPSTREAM_REPOSITORY}/blob/senpai/${locale}.json`,
        capturedAt,
        upstreamRevision,
      },
    });
    // 提升到 data 作为翻译兜底：任何成品未内联翻译的实体，下游都可用本语言表兜底翻译。
    output.push({
      stage: "cleaned",
      path: `languages/${locale}.json`,
      content: bytes,
      recordCount: Object.keys(records).length,
      source: {
        project: "warframe-languages-bin-data",
        dataset: `languages/${locale}`,
        url: `${UPSTREAM_REPOSITORY}/blob/senpai/${locale}.json`,
        capturedAt,
        upstreamRevision,
        transformer: "warframe-datasource-nnm/languages-pass-through@1",
      },
    });
  }
  return output;
}

async function acquireLanguagePair(): Promise<Map<(typeof LOCALES)[number], Buffer>> {
  const pluto = await tryCollectLanguagesWithPluto();
  if (pluto) {
    console.log("[languages] sources: pluto=2");
    return pluto;
  }
  return fetchLanguagePairWithOptions();
}

interface LanguageFetchOptions {
  baseUrl?: string;
  cacheDirectory?: string;
  fetcher?: typeof fetchBytes;
  cdnBaseUrls?: readonly string[];
}

export async function fetchLanguagePairWithOptions(options: LanguageFetchOptions = {}): Promise<Map<(typeof LOCALES)[number], Buffer>> {
  const baseUrl = (options.baseUrl ?? config.languagesRawBaseUrl).replace(/\/+$/u, "");
  const fetcher = options.fetcher ?? fetchBytes;
  const cdn = createGitHubCdnFallback(baseUrl, fetcher, options.cdnBaseUrls);
  // Treat the two locales as a single snapshot. Mixing one Raw version with
  // another commit's CDN file can silently create a mismatched translation pair.
  try {
    const raw = new Map<(typeof LOCALES)[number], Buffer>();
    for (const locale of LOCALES) {
      const bytes = await fetcher(`${baseUrl}/${locale}.json`, {
        timeoutMs: config.requestTimeoutMs,
        maxBytes: config.maxResponseBytes,
        retries: config.requestRetries,
      });
      parseLanguages(bytes, locale);
      raw.set(locale, bytes);
    }
    validateLanguagePair(raw);
    console.log('[languages] sources: {"raw":2,"cdn":0,"cache":0}');
    return raw;
  } catch (error) {
    console.warn(`[languages] Raw pair failed: ${describeError(error)}; trying commit-pinned CDN pair`);
  }

  try {
    const fromCdn = new Map<(typeof LOCALES)[number], Buffer>();
    for (const locale of LOCALES) {
      fromCdn.set(locale, await cdn(`${locale}.json`, (bytes) => { parseLanguages(bytes, locale); }));
    }
    validateLanguagePair(fromCdn);
    console.log('[languages] sources: {"raw":0,"cdn":2,"cache":0}');
    return fromCdn;
  } catch (error) {
    console.warn(`获取 languages Raw/CDN 失败（${describeError(error)}），整对语言表降级为 cache 快照`);
  }

  const cached = new Map<(typeof LOCALES)[number], Buffer>();
  for (const locale of LOCALES) cached.set(locale, await readLanguagesFromCache(locale, options.cacheDirectory));
  validateLanguagePair(cached);
  console.log('[languages] sources: {"raw":0,"cdn":0,"cache":2}');
  return cached;
}

async function tryCollectLanguagesWithPluto(): Promise<Map<(typeof LOCALES)[number], Buffer> | undefined> {
  if (!config.warframeGameDir || !config.packagesBinDir
    || !await hasWarframeClient(config.warframeGameDir)
    || !await isDirectory(config.packagesBinDir)) {
    return undefined;
  }

  const scriptDirectory = join(config.plutoDirectory, "languages");
  const script = join(scriptDirectory, "_download_and_extract.pluto");
  const cacheLibrary = join(config.plutoDirectory, "warframe-cache-tools", "lib", "cachelib.pluto");
  if (!await exists(script) || !await exists(cacheLibrary)) return undefined;
  let extractionDirectory: string | undefined;
  try {
    extractionDirectory = await mkdtemp(join(scriptDirectory, ".extract-"));
    await runPluto(config.plutoRuntime ?? "pluto", script, extractionDirectory, config.plutoTimeoutMs, {
      ...process.env, WF_CACHELIB_PATH: cacheLibrary,
    });
    const files = new Map<(typeof LOCALES)[number], Buffer>();
    for (const locale of LOCALES) files.set(locale, await readFile(join(extractionDirectory, `${locale}.json`)));
    validateLanguagePair(files);
    return files;
  } catch (error) {
    console.warn(`Pluto 语言提取未通过校验，改用 Raw 降级：${error instanceof Error ? error.message : error}`);
    return undefined;
  } finally {
    if (extractionDirectory) await rm(extractionDirectory, { recursive: true, force: true });
  }
}

async function readLanguagesFromCache(locale: string, cacheDirectory = join(config.tmpDirectory, "cache", "languages")): Promise<Buffer> {
  const cachePath = join(cacheDirectory, `${locale}.json.gz`);
  const bytes = await readFile(cachePath);
  return gunzipSync(bytes);
}

function parseLanguages(bytes: Buffer, locale: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Invalid warframe-languages-bin-data JSON: ${locale}.json`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`warframe-languages-bin-data ${locale}.json must be an object`);
  }
  const records = value as Record<string, unknown>;
  if (Object.keys(records).length < MIN_LANGUAGE_RECORDS) {
    throw new Error(`warframe-languages-bin-data ${locale}.json is incomplete: ${Object.keys(records).length} records`);
  }
  for (const [key, record] of Object.entries(records)) {
    if (key === "__order") continue;
    if (typeof record !== "string") throw new Error(`warframe-languages-bin-data ${locale}.json has a non-string value: ${key}`);
  }
  return records as Record<string, string>;
}

function validateLanguagePair(files: Map<(typeof LOCALES)[number], Buffer>): void {
  const parsed = LOCALES.map((locale) => {
    const bytes = files.get(locale);
    if (!bytes) throw new Error(`Missing language snapshot: ${locale}.json`);
    return parseLanguages(bytes, locale);
  });
  const englishKeys = new Set(Object.keys(parsed[0] ?? {}).filter((key) => key !== "__order"));
  const localizedKeys = new Set(Object.keys(parsed[1] ?? {}).filter((key) => key !== "__order"));
  const common = [...englishKeys].filter((key) => localizedKeys.has(key)).length;
  const coverage = common / Math.min(englishKeys.size, localizedKeys.size);
  if (coverage < 0.8) throw new Error(`Language table key overlap is too low: ${(coverage * 100).toFixed(2)}%`);
}

async function hasWarframeClient(gameDir: string): Promise<boolean> {
  for (const marker of ["Warframe.x64.exe", "Launcher.exe", "Cache.Windows", "Tools"]) {
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
