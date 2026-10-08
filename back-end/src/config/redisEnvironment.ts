/** Local tests stay on loopback; Azure leases require authenticated, verified TLS. */
export function redisConnectionKind(
  value: string,
  nodeEnv: "development" | "test" | "production" = "development",
): "local" | "azure" {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("REDIS_URL must be a valid Redis URL"); }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol === "redis:" && local && !url.username && !url.password && !url.search && !url.hash &&
      ["", "/", "/0"].includes(url.pathname)) {
    if (nodeEnv === "production") throw new Error("Loopback Redis is forbidden in production");
    return "local";
  }
  let password = "";
  try { password = decodeURIComponent(url.password); } catch { /* reject malformed credential encoding */ }
  if (url.protocol === "rediss:" && /^[a-z][a-z0-9-]*\.[a-z0-9-]+\.redis\.azure\.net$/.test(url.hostname) &&
      url.port === "10000" && ["", "default"].includes(url.username) && password.length >= 32 &&
      !url.search && !url.hash && ["", "/"].includes(url.pathname)) return "azure";
  throw new Error("REDIS_URL must use unauthenticated loopback Redis or authenticated Azure Managed Redis TLS on port 10000");
}
