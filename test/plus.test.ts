import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { DatasetFileInput, SourceMetadata } from "../src/domain/contracts.js";
import { fetchPlusFromRawWithOptions } from "../src/collectors/plus.js";
import { enrichPlusReferences } from "../src/projections/plus.js";

const source: SourceMetadata = {
  project: "test", dataset: "test", url: "https://example.invalid", capturedAt: "2026-10-22T00:00:00.000Z",
};

test("adds bilingual catalog item references to Plus sub-entities without replacing identities", () => {
  const plus: DatasetFileInput[] = [
    { stage: "raw", path: "plus/ExportBundles.json", content: "{}", source },
    {
      stage: "cleaned",
      path: "plus/bundles.json",
      content: JSON.stringify({ components: [{ typeName: "/Lotus/StoreItems/Types/Items/MiscItems/Kuva", purchaseQuantity: 20000 }] }),
      source,
    },
  ];
  const catalog: DatasetFileInput[] = [{
    stage: "cleaned",
    path: "catalog/i18n/items.json",
    content: JSON.stringify({
      "/Lotus/Types/Items/MiscItems/Kuva": {
        en: { name: "Kuva" },
        zh: { name: "赤毒" },
        iconUrl: "https://content.warframe.com/kuva.png",
      },
    }),
    source,
  }];
  const output = enrichPlusReferences(plus, catalog);
  assert.equal(output[0], plus[0]);
  const result = JSON.parse(String(output[1]?.content)) as {
    components: Array<Record<string, unknown>>;
  };
  assert.equal(result.components[0]?.typeName, "/Lotus/StoreItems/Types/Items/MiscItems/Kuva");
  assert.deepEqual(result.components[0]?.itemReferences, [{
    field: "typeName",
    uniqueName: "/Lotus/Types/Items/MiscItems/Kuva",
    name: "Kuva",
    nameZh: "赤毒",
    iconUrl: "https://content.warframe.com/kuva.png",
    domain: "catalog",
    resolution: "localized_identity",
  }]);
});

test("uses the repository root Raw path without probing the fallback path after success", async () => {
  const requests: string[] = [];
  const files = await fetchPlusFromRawWithOptions({
    baseUrls: ["https://raw.example.invalid/senpai"],
    requiredNames: ["Bounties"],
    fetcher: async (url) => {
      requests.push(url);
      return Buffer.from('{"fresh":true}');
    },
  });

  assert.deepEqual(requests, ["https://raw.example.invalid/senpai/ExportBounties.json"]);
  assert.deepEqual(JSON.parse(String(files.get("ExportBounties.json"))), { fresh: true });
});

test("tries the compatible data path when the repository root path fails", async () => {
  const requests: string[] = [];
  const files = await fetchPlusFromRawWithOptions({
    baseUrls: ["https://raw.example.invalid/senpai"],
    requiredNames: ["Bounties"],
    fetcher: async (url) => {
      requests.push(url);
      if (url.endsWith("/data/ExportBounties.json")) return Buffer.from('{"fromData":true}');
      throw new Error("simulated root failure");
    },
  });

  assert.equal(requests[0], "https://raw.example.invalid/senpai/ExportBounties.json");
  assert.equal(requests[1], "https://raw.example.invalid/senpai/data/ExportBounties.json");
  assert.deepEqual(JSON.parse(String(files.get("ExportBounties.json"))), { fromData: true });
});

test("uses the GitHub Git API blob fallback after Raw failures", async () => {
  const requests: string[] = [];
  const blob = Buffer.from('{"fromGitApi":true}');
  const files = await fetchPlusFromRawWithOptions({
    baseUrls: ["https://raw.githubusercontent.com/calamity-inc/warframe-public-export-plus/senpai"],
    requiredNames: ["Rewards"],
    fetcher: async (url) => {
      requests.push(url);
      if (url.includes("api.github.com/repos/calamity-inc/warframe-public-export-plus/git/trees/")) {
        return Buffer.from(JSON.stringify({ tree: [{ path: "ExportRewards.json", type: "blob", sha: "deadbeef" }] }));
      }
      if (url.endsWith("/git/blobs/deadbeef")) {
        return Buffer.from(JSON.stringify({ encoding: "base64", content: blob.toString("base64") }));
      }
      throw new Error("simulated Raw/CDN failure");
    },
  });

  assert.ok(requests.some((url) => url.includes("/git/trees/")));
  assert.ok(requests.some((url) => url.endsWith("/git/blobs/deadbeef")));
  assert.deepEqual(JSON.parse(String(files.get("ExportRewards.json"))), { fromGitApi: true });
});

test("falls back per file so successful Raw files are kept and failed files use cache", async (context) => {
  const root = await mkdtemp(join(resolve(import.meta.dirname, ".."), ".test-plus-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cacheDirectory = join(root, "cache", "plus");
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(join(cacheDirectory, "ExportRewards.json.gz"), gzipSync(Buffer.from('{"cached":true}')));

  const files = await fetchPlusFromRawWithOptions({
    baseUrls: ["https://raw.example.invalid/senpai"],
    cacheDirectory,
    requiredNames: ["Bounties", "Rewards"],
    fetcher: async (url) => {
      if (url.endsWith("/ExportBounties.json")) return Buffer.from('{"fresh":true}');
      throw new Error("simulated rewards failure");
    },
  });

  assert.deepEqual(JSON.parse(String(files.get("ExportBounties.json"))), { fresh: true });
  assert.deepEqual(JSON.parse(String(files.get("ExportRewards.json"))), { cached: true });
  assert.equal((await readFile(join(cacheDirectory, "ExportRewards.json.gz"))).length > 0, true);
});

test("Plus uses a commit-pinned CDN response after GitHub failures before falling back to cache", async () => {
  const sha = "b".repeat(40);
  const files = await fetchPlusFromRawWithOptions({
    baseUrls: ["https://raw.githubusercontent.com/calamity-inc/warframe-public-export-plus/senpai"],
    requiredNames: ["Bounties"],
    cdnBaseUrls: ["https://testingcf.jsdelivr.net/gh"],
    fetcher: async (url) => {
      if (url.includes("/commits/senpai")) return Buffer.from(JSON.stringify({ sha }));
      if (url.includes(`@${sha}/ExportBounties.json`)) return Buffer.from('{"fromCdn":true}');
      throw new Error("Raw and Git API are unavailable");
    },
  });
  assert.deepEqual(JSON.parse(String(files.get("ExportBounties.json"))), { fromCdn: true });
});

test("uses GitHub Git API data/ tree entry when upstream files move", async () => {
  const files = await fetchPlusFromRawWithOptions({
    baseUrls: ["https://raw.githubusercontent.com/calamity-inc/warframe-public-export-plus/senpai"],
    requiredNames: ["Rewards"],
    fetcher: async (url) => {
      if (url.includes("/git/trees/")) return Buffer.from(JSON.stringify({
        tree: [{ path: "data/ExportRewards.json", type: "blob", sha: "data-sha" }],
      }));
      if (url.endsWith("/git/blobs/data-sha")) return Buffer.from(JSON.stringify({
        encoding: "base64", content: Buffer.from('{"via":"data tree"}').toString("base64"),
      }));
      throw new Error("Raw unavailable");
    },
  });
  assert.deepEqual(JSON.parse(String(files.get("ExportRewards.json"))), { via: "data tree" });
});

test("tries the upstream data/ directory on a commit-pinned CDN before cache", async () => {
  const sha = "e".repeat(40);
  const urls: string[] = [];
  const files = await fetchPlusFromRawWithOptions({
    baseUrls: ["https://raw.githubusercontent.com/calamity-inc/warframe-public-export-plus/senpai"],
    cdnBaseUrls: ["https://testingcf.jsdelivr.net/gh"],
    requiredNames: ["Bounties"],
    fetcher: async (url) => {
      urls.push(url);
      if (url.includes("/commits/senpai")) return Buffer.from(JSON.stringify({ sha }));
      if (url.includes(`@${sha}/data/ExportBounties.json`)) return Buffer.from('{"via":"cdn data"}');
      throw new Error("Raw, API and root CDN unavailable");
    },
  });
  assert.deepEqual(JSON.parse(String(files.get("ExportBounties.json"))), { via: "cdn data" });
  assert.ok(urls.some((url) => url.includes(`@${sha}/ExportBounties.json`)));
});
