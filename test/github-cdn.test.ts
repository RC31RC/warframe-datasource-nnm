import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitHubCdnFallback } from "../src/core/github-cdn.js";
import { describeError, fetchBytes } from "../src/core/http.js";

const base = "https://raw.githubusercontent.com/calamity-inc/warframe-public-export-plus/senpai";
const sha = "a".repeat(40);

test("CDN requests share a resolved commit and never forward API credentials to the CDN", async () => {
  const urls: string[] = [];
  const cdn = createGitHubCdnFallback(base, async (url, options) => {
    urls.push(url);
    if (url.includes("api.github.com")) return Buffer.from(JSON.stringify({ sha }));
    assert.ok(url.includes(`@${sha}/`));
    assert.equal(options.headers?.authorization, undefined);
    return Buffer.from('{"fresh":true}');
  }, ["https://cdn.jsdelivr.net/gh"]);
  const parse = (bytes: Buffer) => { JSON.parse(bytes.toString()); };
  await Promise.all([cdn("ExportBounties.json", parse), cdn("ExportRewards.json", parse)]);
  assert.equal(urls.filter((url) => url.includes("api.github.com")).length, 1);
  assert.equal(urls.filter((url) => url.includes(`@${sha}/`)).length, 2);
});

test("CDN rejects invalid JSON and tries the alternate CDN before using cache", async () => {
  const cdn = createGitHubCdnFallback(base, async (url) => {
    if (url.includes("api.github.com")) return Buffer.from(JSON.stringify({ sha }));
    return Buffer.from(url.includes("testingcf") ? '{"good":true}' : "upstream error page");
  }, ["https://cdn.jsdelivr.net/gh", "https://testingcf.jsdelivr.net/gh"]);
  const result = await cdn("ExportBounties.json", (bytes) => { JSON.parse(bytes.toString()); });
  assert.deepEqual(JSON.parse(result.toString()), { good: true });
});

test("an unresolved branch never downloads potentially stale branch CDN data", async () => {
  const urls: string[] = [];
  const cdn = createGitHubCdnFallback(base, async (url) => {
    urls.push(url);
    if (url.includes("api.github.com")) throw new Error("HTTP 403: API rate limit exceeded");
    throw new Error("Unexpected CDN request");
  }, ["https://testingcf.jsdelivr.net/gh"]);
  await assert.rejects(cdn("ExportBounties.json", () => {}), /Cannot confirm latest commit.*refusing unverified branch CDN data/u);
  assert.equal(urls.length, 1);
  assert.ok(urls[0]?.includes("api.github.com"));
});

test("each new acquisition resolves the latest branch head again", async () => {
  let apiRequests = 0;
  const revisions = ["a".repeat(40), "b".repeat(40)];
  const fetcher: typeof fetchBytes = async (url, options) => {
    if (url.includes("api.github.com")) {
      assert.equal(options.headers?.["cache-control"], "no-cache");
      return Buffer.from(JSON.stringify({ sha: revisions[apiRequests++] }));
    }
    assert.ok(url.includes(`@${revisions[apiRequests - 1]}/`));
    return Buffer.from("{}");
  };
  for (let run = 0; run < 2; run += 1) {
    await createGitHubCdnFallback(base, fetcher, ["https://testingcf.jsdelivr.net/gh"])("ExportBounties.json", () => {});
  }
  assert.equal(apiRequests, 2);
});

test("HTTP failures retain their URL and low-level socket/DNS cause", async (context) => {
  const cause = Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" });
  context.mock.method(globalThis, "fetch", async () => { throw new Error("fetch failed", { cause }); });
  await assert.rejects(fetchBytes("https://example.invalid/test.json", { retries: 1, timeoutMs: 100, maxBytes: 100 }),
    /example\.invalid\/test\.json: fetch failed <- lookup failed \[ENOTFOUND\]/u);
  assert.match(describeError(new Error("request", { cause })), /ENOTFOUND/u);
});
