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

/** Resolve the current branch head for each acquisition, then share immutable CDN URLs within it. */
export function createGitHubCdnFallback(
  rawBase: string,
  fetcher: typeof fetchBytes = fetchBytes,
  cdnBases: readonly string[] = config.githubCdnBaseUrls,
) {
  const match = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)(\/data)?\/?$/u.exec(rawBase);
  let revision: Promise<string> | undefined;
  return async (fileName: string, validate: (bytes: Buffer) => void): Promise<Buffer> => {
    if (!match || !cdnBases.length) throw new Error("GitHub CDN fallback is not configured for this source");
    const [, owner, repository, branch, directory = ""] = match;
    if (!owner || !repository || !branch) throw new Error(`Unsupported GitHub Raw base: ${rawBase}`);
    const request = { timeoutMs: config.requestTimeoutMs, maxBytes: config.maxResponseBytes, retries: config.requestRetries };
    revision ??= (async () => {
      if (/^[a-f0-9]{40}$/iu.test(branch)) return branch;
      const url = `https://api.github.com/repos/${owner}/${repository}/commits/${encodeURIComponent(branch)}`;
      try {
        const bytes = await fetcher(url, { ...request, headers: { ...githubApiHeaders(), "cache-control": "no-cache" } });
        const value = JSON.parse(bytes.toString("utf8")) as { sha?: unknown };
        if (typeof value.sha !== "string" || !/^[a-f0-9]{40}$/iu.test(value.sha)) throw new Error("Response has no commit SHA");
        console.log(`[github-cdn] ${owner}/${repository}: ${branch} latest commit ${value.sha}`);
        return value.sha;
      } catch (error) {
        throw new Error(`Cannot confirm latest commit for ${owner}/${repository}@${branch}; refusing unverified branch CDN data: ${describeError(error)}`, { cause: error });
      }
    })();
    const ref = await revision;
    const failures: Error[] = [];
    for (const base of cdnBases) {
      const url = `${base}/${owner}/${repository}@${ref}${directory}/${fileName}`;
      try {
        const bytes = await fetcher(url, request);
        validate(bytes);
        console.log(`[github-cdn] ${url} (${bytes.length} bytes; commit pinned)`);
        return bytes;
      } catch (error) {
        failures.push(new Error(`${url}: ${describeError(error)}`, { cause: error }));
      }
    }
    throw new AggregateError(failures, `GitHub CDN failed for ${fileName}: ${failures.map((error) => error.message).join(" | ")}`);
  };
}
