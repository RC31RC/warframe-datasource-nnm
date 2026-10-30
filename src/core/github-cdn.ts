import { config } from "./config.js";
import { describeError, fetchBytes } from "./http.js";

export function githubApiHeaders(): Record<string, string> {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  return {
    accept: "application/vnd.github+json",
    "user-agent": "warframe-datasource-nnm",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** A per-acquisition fallback: resolve the branch once, then request immutable CDN URLs. */
export function createGitHubCdnFallback(
  rawBase: string,
  fetcher: typeof fetchBytes = fetchBytes,
  cdnBases: readonly string[] = config.githubCdnBaseUrls,
) {
  const match = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)(\/data)?\/?$/u.exec(rawBase);
  let revision: Promise<{ ref: string; pinned: boolean }> | undefined;
  return async (fileName: string, validate: (bytes: Buffer) => void): Promise<Buffer> => {
    if (!match || !cdnBases.length) throw new Error("GitHub CDN fallback is not configured for this source");
    const [, owner, repository, branch, directory = ""] = match;
    if (!owner || !repository || !branch) throw new Error(`Unsupported GitHub Raw base: ${rawBase}`);
    const request = { timeoutMs: config.requestTimeoutMs, maxBytes: config.maxResponseBytes, retries: config.requestRetries };
    revision ??= (async () => {
      if (/^[a-f0-9]{40}$/iu.test(branch)) return { ref: branch, pinned: true };
      const url = `https://api.github.com/repos/${owner}/${repository}/commits/${encodeURIComponent(branch)}`;
      try {
        const bytes = await fetcher(url, { ...request, headers: githubApiHeaders() });
        const value = JSON.parse(bytes.toString("utf8")) as { sha?: unknown };
        if (typeof value.sha !== "string" || !/^[a-f0-9]{40}$/iu.test(value.sha)) throw new Error("Response has no commit SHA");
        return { ref: value.sha, pinned: true };
      } catch (error) {
        console.warn(`[github-cdn] ${owner}/${repository}: cannot resolve ${branch}: ${describeError(error)}; branch CDN freshness is unverified`);
        return { ref: branch, pinned: false };
      }
    })();
    const { ref, pinned } = await revision;
    const failures: Error[] = [];
    for (const base of cdnBases) {
      const url = `${base}/${owner}/${repository}@${ref}${directory}/${fileName}`;
      try {
        const bytes = await fetcher(url, request);
        validate(bytes);
        console.log(`[github-cdn] ${url} (${bytes.length} bytes; ${pinned ? "commit pinned" : "branch cache, freshness unverified"})`);
        return bytes;
      } catch (error) {
        failures.push(new Error(`${url}: ${describeError(error)}`, { cause: error }));
      }
    }
    throw new AggregateError(failures, `GitHub CDN failed for ${fileName}: ${failures.map((error) => error.message).join(" | ")}`);
  };
}
