/** Network access. Tests replace http.fetchBytes. */
export const USER_AGENT = "strompreise-schweiz-tariff-core/3.0 (+https://github.com/Strompreise-Schweiz/tariff-core)";

export class HttpError extends Error {
  readonly status: number;

  constructor(url: string, status: number, statusText: string) {
    super(`HTTP ${status} ${statusText} for ${url}`);
    this.status = status;
  }
}

export const http = {
  async fetchBytes(url: string, timeoutMs = 30_000): Promise<Buffer> {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new HttpError(url, response.status, response.statusText);
    return Buffer.from(await response.arrayBuffer());
  },
};
