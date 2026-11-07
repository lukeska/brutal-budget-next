/** A non-2xx API response. `code` is the server's `error` field when it sent one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: unknown,
  ) {
    super(`${status} ${code}`);
    this.name = "ApiError";
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function apiFetch<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const code =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : "http_error";
    throw new ApiError(res.status, code, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => apiFetch<T>("GET", path),
  post: <T>(path: string, body?: unknown) => apiFetch<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => apiFetch<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>("PATCH", path, body),
  delete: <T>(path: string) => apiFetch<T>("DELETE", path),
};
