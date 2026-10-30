export interface HttpOptions {
  timeoutMs: number;
  maxBytes: number;
  retries: number;
  headers?: Record<string, string>;
}

export class HttpStatusError extends Error {
  constructor(readonly status: number, url: string, detail = "") {
    super(`HTTP ${status} for ${url}${detail ? ` (${detail})` : ""}`);
  }
}

export async function fetchBytes(url: string, options: HttpOptions): Promise<Buffer> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...(options.headers ? { headers: options.headers } : {}),
        signal: AbortSignal.timeout(options.timeoutMs),
        redirect: "follow",
      });
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (!retryable || attempt === options.retries) {
          const rateLimited = new URL(url).hostname === "api.github.com"
            && response.headers.get("x-ratelimit-remaining") === "0";
          throw new HttpStatusError(response.status, url,
            rateLimited ? `GitHub API rate limit exhausted; reset=${response.headers.get("x-ratelimit-reset")}` : "");
        }
        const retryAfter = Number(response.headers.get("retry-after"));
        await delay(Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 30_000)
          : attempt * 500);
        continue;
      }

      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
        throw new Error(`Response exceeds ${options.maxBytes} bytes: ${url}`);
      }
      if (!response.body) throw new Error(`Empty response body: ${url}`);

      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > options.maxBytes) {
          await reader.cancel();
          throw new Error(`Response exceeds ${options.maxBytes} bytes: ${url}`);
        }
        chunks.push(Buffer.from(value));
      }
      if (total === 0) throw new Error(`Empty response body: ${url}`);
      return Buffer.concat(chunks, total);
    } catch (error) {
      lastError = error;
      if (attempt === options.retries
        || (error instanceof HttpStatusError && error.status < 500 && error.status !== 408 && error.status !== 429)) break;
      // 指数退避：网络抖动（fetch failed）时逐步拉长重试间隔，提高间歇性故障下的成功率。
      await delay(Math.min(1000 * 2 ** (attempt - 1), 10_000));
    }
  }

  if (lastError instanceof HttpStatusError) throw lastError;
  throw new Error(`Request failed for ${url}: ${describeError(lastError)}`, { cause: lastError });
}

/** Keep DNS/socket/TLS causes visible instead of reporting only "fetch failed". */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  const visited = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !visited.has(current) && visited.size < 5) {
    visited.add(current);
    const code = "code" in current ? ` [${String(current.code)}]` : "";
    parts.push(`${current.message}${code}`);
    if (current instanceof AggregateError) parts.push(current.errors.map((item) => describeError(item)).join("; "));
    current = current.cause;
  }
  return parts.length ? parts.join(" <- ") : String(error);
}

export async function fetchJson(url: string, options: HttpOptions): Promise<{ bytes: Buffer; value: unknown }> {
  const bytes = await fetchBytes(url, {
    ...options,
    headers: { accept: "application/json", ...options.headers },
  });
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) as unknown };
  } catch (error) {
    throw new Error(`Invalid JSON response from ${url}`, { cause: error });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
