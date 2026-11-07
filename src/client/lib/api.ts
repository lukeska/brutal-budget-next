import { markOffline, markOnline } from "./online";

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

/** Receives the login URL (with `next`) when the session has expired. */
type UnauthorizedHandler = (loginHref: string) => void;

let onUnauthorized: UnauthorizedHandler = (href) => window.location.assign(href);

/**
 * The root layout swaps in a router navigation so the SPA (and any open drawer draft) survives
 * the trip to the login screen. The default is a full page load.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  onUnauthorized = handler;
}

/** Auth endpoints answer 401 as a normal result (wrong password, not logged in yet). */
function redirectsOn401(path: string): boolean {
  return !path.startsWith("/api/auth/");
}

function currentPath(): string {
  const { pathname, search, hash } = window.location;
  return `${pathname}${search}${hash}`;
}

export function loginHref(next: string = currentPath()): string {
  return next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
}

function sendToLogin() {
  const path = window.location.pathname;
  if (path === "/login" || path === "/setup") return;
  onUnauthorized(loginHref());
}

export async function apiFetch<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
  } catch (err) {
    // fetch rejects with a TypeError only when the request never got a response.
    if (err instanceof TypeError) markOffline();
    throw err;
  }
  markOnline();
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
    if (res.status === 401 && redirectsOn401(path)) sendToLogin();
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
