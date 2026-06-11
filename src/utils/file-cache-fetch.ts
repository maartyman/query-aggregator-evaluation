import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

type FetchLike = typeof fetch;

interface CachedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export class FileCacheFetch {
  public constructor(
    private readonly sourceFetch: FetchLike,
    private readonly cacheDirectory = path.join(process.cwd(), ".file-cache"),
  ) {}

  public fetch: FetchLike = async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET") {
      return this.sourceFetch(input, init);
    }

    const url = input instanceof Request ? input.url : String(input);
    const cachePath = this.getCachePath(url);
    const cached = await this.read(cachePath);
    if (cached) {
      return new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers: cached.headers,
      });
    }

    const response = await this.sourceFetch(input, init);
    if (!response.ok) {
      return response;
    }

    const body = await response.text();
    const headers = Object.fromEntries(response.headers.entries());
    await this.write(cachePath, {
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  private getCachePath(url: string): string {
    const digest = crypto.createHash("sha256").update(url).digest("hex");
    return path.join(this.cacheDirectory, `${digest}.json`);
  }

  private async read(cachePath: string): Promise<CachedResponse | undefined> {
    try {
      return JSON.parse(await fsp.readFile(cachePath, "utf8")) as CachedResponse;
    } catch {
      return;
    }
  }

  private async write(cachePath: string, cached: CachedResponse): Promise<void> {
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await fsp.writeFile(cachePath, JSON.stringify(cached), "utf8");
  }
}
