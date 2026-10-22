import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { config } from "../core/config.js";
import { fetchBytes } from "../core/http.js";
import type { DatasetFileInput } from "../domain/contracts.js";

/**
 * warframe-languages-bin-data：Pluto 从游戏资源提取的游戏内语言字符串表（一手数据）。
 * 每语言 140,358 条，键形如 /Lotus/Language/Locations/Apollodorus，值是该语言文本。
 * 官方 HTTP 只暴露 MOTD（每日消息），全量语言表只能由 Pluto 从游戏 B.Cache.Windows_<lang>.bin 提取。
 *
 * 语言表产物不写死在 pluto/（那里只有提取脚本），走与 plus 一致的降级链：
 * GitHub Raw 拉取 → tmp/cache 解压兜底。产物同时提升到 data/languages 作翻译兜底。
 */
const UPSTREAM_REPOSITORY = "https://github.com/calamity-inc/warframe-languages-bin-data";

/** 代码簿当前只需中英两种语言（官方 Export 已覆盖 en 主名，zh 用于本地化名）。 */
const LOCALES = ["en", "zh"] as const;

export async function collectLanguagesBinData(now = new Date()): Promise<DatasetFileInput[]> {
  const capturedAt = now.toISOString();
  const output: DatasetFileInput[] = [];
  for (const locale of LOCALES) {
    const bytes = await acquireLanguages(locale);
    const records = parseLanguages(bytes, locale);
    const upstreamRevision = createHash("sha256").update(bytes).digest("hex");
    output.push({
      stage: "raw",
      path: `languages/${locale}.json`,
      content: bytes,
      source: {
        project: "warframe-languages-bin-data",
        dataset: `languages/${locale}`,
        url: `${UPSTREAM_REPOSITORY}/blob/master/${locale}.json`,
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
        url: `${UPSTREAM_REPOSITORY}/blob/master/${locale}.json`,
        capturedAt,
        upstreamRevision,
        transformer: "warframe-datasource-nnm/languages-pass-through@1",
      },
    });
  }
  return output;
}

/** 降级获取语言表：GitHub Raw 拉取 → tmp/cache 解压兜底（与 plus 一致）。 */
async function acquireLanguages(locale: string): Promise<Buffer> {
  const url = `${config.languagesRawBaseUrl}/${locale}.json`;
  try {
    return await fetchBytes(url, {
      timeoutMs: config.requestTimeoutMs,
      maxBytes: config.maxResponseBytes,
      retries: config.requestRetries,
    });
  } catch {
    // 降级到 tmp/cache
  }
  return readLanguagesFromCache(locale);
}

async function readLanguagesFromCache(locale: string): Promise<Buffer> {
  const cachePath = join(config.tmpDirectory, "cache", "languages", `${locale}.json.gz`);
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
  return value as Record<string, string>;
}
