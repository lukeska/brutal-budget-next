/**
 * The post-login redirect target, accepted only as a same-site path starting with a single "/".
 * Anything else (protocol-relative "//host", backslash tricks, schemes, non-strings) becomes "/".
 */
export function safeNext(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/")) return "/";
  // Browsers treat "\" like "/", so "/\host" is protocol-relative too.
  if (raw[1] === "/" || raw[1] === "\\") return "/";
  // Browsers drop tabs and newlines from URLs, so "/\t/host" would become "//host".
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return "/";
  }
  return raw;
}
