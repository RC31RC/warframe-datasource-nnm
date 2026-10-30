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

test("an unresolved branch is explicitly reported as having unverified freshness", async (context) => {
  const warnings: string[] = [];
  context.mock.method(console, "warn", (message: string) => { warnings.push(message); });
  const cdn = createGitHubCdnFallback(base, async (url) => {
    if (url.includes("api.github.com")) throw new Error("HTTP 403: API rate limit exceeded");
    assert.ok(url.includes("@senpai/"));
    return Buffer.from("{}");
  }, ["https://testingcf.jsdelivr.net/gh"]);
  await cdn("ExportBounties.json", () => {});
  assert.ok(warnings.some((warning) => warning.includes("freshness is unverified")));
});

test("HTTP failures retain their URL and low-level socket/DNS cause", async (context) => {
  const cause = Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" });
  context.mock.method(globalThis, "fetch", async () => { throw new Error("fetch failed", { cause }); });
  await assert.rejects(fetchBytes("https://example.invalid/test.json", { retries: 1, timeoutMs: 100, maxBytes: 100 }),
    /example\.invalid\/test\.json: fetch failed <- lookup failed \[ENOTFOUND\]/u);
  assert.match(describeError(new Error("request", { cause })), /ENOTFOUND/u);
});
