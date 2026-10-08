/** Preserve the SAS and account/object path through the owner's HTTPS proxy. */
export function publicDownloadUrl(signedUrl: string, publicBaseUrl?: string): { downloadUrl: string; transport: "https" | "loopback-http" } {
  const signed = new URL(signedUrl);
  const local = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host);
  if (signed.protocol !== "http:" || !local(signed.hostname) || signed.username || signed.password) throw new Error("Only loopback storage URLs may be proxied");
  if (!publicBaseUrl) return { downloadUrl: signedUrl, transport: "loopback-http" };
  const base = new URL(publicBaseUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/blob" || (base.protocol !== "https:" && !(base.protocol === "http:" && local(base.hostname))))
    throw new Error("Result download proxy must be HTTPS with the /blob prefix");
  return { downloadUrl: `${base.origin}/blob${signed.pathname}${signed.search}`, transport: base.protocol === "https:" ? "https" : "loopback-http" };
}
