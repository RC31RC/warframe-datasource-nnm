import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { fetchLanguagePairWithOptions } from "../src/collectors/languages.js";
import { config } from "../src/core/config.js";

const baseUrl = "https://raw.githubusercontent.com/calamity-inc/warframe-languages-bin-data/senpai";
test("default languages upstream targets the existing senpai branch", () => {
  if (!process.env.WF_LANGUAGES_RAW_BASE_URL) assert.equal(config.languagesRawBaseUrl, baseUrl);
});

const table = (text: string) => Buffer.from(JSON.stringify(Object.fromEntries(
  Array.from({ length: 10_000 }, (_, i) => [`/Language/Key${i}`, `${text}${i}`]),
)));

test("language tables use GitHub Raw directly when both validated downloads succeed", async () => {
  const urls: string[] = [];
  const pair = await fetchLanguagePairWithOptions({
    baseUrl,
    fetcher: async (url) => { urls.push(url); return table(url.endsWith("en.json") ? "English" : "中文"); },
  });
  assert.deepEqual(urls, [`${baseUrl}/en.json`, `${baseUrl}/zh.json`]);
  assert.equal(pair.size, 2);
});

test("language CDN fallback pins both locales to one commit before any cache fallback", async () => {
  const sha = "c".repeat(40);
  const urls: string[] = [];
  const pair = await fetchLanguagePairWithOptions({
    baseUrl,
    cdnBaseUrls: ["https://testingcf.jsdelivr.net/gh"],
    fetcher: async (url) => {
      urls.push(url);
      if (url.includes("/commits/senpai")) return Buffer.from(JSON.stringify({ sha }));
      if (url.includes(`@${sha}/`)) return table(url.endsWith("en.json") ? "English" : "中文");
      throw new Error("Raw connection reset");
    },
  });
  assert.equal(pair.size, 2);
  assert.equal(urls.filter((url) => url.includes("/commits/senpai")).length, 1);
  assert.equal(urls.filter((url) => url.includes(`@${sha}/`)).length, 2);
});

test("partial Raw language downloads are replaced by one commit-pinned CDN pair", async () => {
  const sha = "d".repeat(40);
  const urls: string[] = [];
  const pair = await fetchLanguagePairWithOptions({
    baseUrl,
    cdnBaseUrls: ["https://testingcf.jsdelivr.net/gh"],
    fetcher: async (url) => {
      urls.push(url);
      if (url.includes("/commits/senpai")) return Buffer.from(JSON.stringify({ sha }));
      if (url.includes(`@${sha}/`)) return table(url.endsWith("en.json") ? "pinned English" : "pinned Chinese");
      if (url.endsWith("en.json")) return table("unmatched Raw English");
      throw new Error("Raw zh reset");
    },
  });
  assert.deepEqual(pair.get("en"), table("pinned English"));
  assert.deepEqual(pair.get("zh"), table("pinned Chinese"));
  assert.equal(urls.filter((url) => url.includes(`@${sha}/`)).length, 2);
});

test("if a locale fails in Raw and CDN, the entire validated cache pair is used", async (context) => {
  const root = await mkdtemp(join(resolve(import.meta.dirname, ".."), ".test-languages-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cacheDirectory = join(root, "cache");
  await mkdir(cacheDirectory);
  const english = table("cached English"), chinese = table("缓存中文");
  await writeFile(join(cacheDirectory, "en.json.gz"), gzipSync(english));
  await writeFile(join(cacheDirectory, "zh.json.gz"), gzipSync(chinese));
  const pair = await fetchLanguagePairWithOptions({
    baseUrl,
    cacheDirectory,
    cdnBaseUrls: [],
    fetcher: async (url) => {
      if (url.endsWith("en.json")) return table("new English");
      throw new Error("Chinese download unavailable");
    },
  });
  assert.deepEqual(pair.get("en"), english);
  assert.deepEqual(pair.get("zh"), chinese);
});
