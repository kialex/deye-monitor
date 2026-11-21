import { REQUEST_TIMEOUT_MS } from "./constants";

export class HttpError extends Error {
  constructor(readonly status: number, readonly retryAfterSeconds?: number) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
  }
}

export async function post<T>(url: string, body: object, token?: string): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    let retryAfter: number | undefined;
    try {
      const body = await response.json() as { parameters?: { retry_after?: unknown } };
      const value = body.parameters?.retry_after;
      if (typeof value === "number" && Number.isFinite(value) && value > 0) retryAfter = value;
    } catch { /* Non-JSON error responses still retain their HTTP status. */ }
    throw new HttpError(response.status, retryAfter);
  }
  return (await response.json()) as T;
}
