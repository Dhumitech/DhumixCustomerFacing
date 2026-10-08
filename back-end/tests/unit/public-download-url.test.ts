import { describe, expect, it } from "vitest";
import { publicDownloadUrl } from "../../src/services/storage/publicDownloadUrl.js";
describe("hosted demo result proxy", () => {
  const source = "http://127.0.0.1:10000/devstoreaccount1/results/object.json?sp=r&sig=unit%2Bsignature";
  it("preserves the signed path and SAS byte encoding with HTTPS", () => {
    expect(publicDownloadUrl(source, "https://demo.example/blob")).toEqual({ downloadUrl: "https://demo.example/blob/devstoreaccount1/results/object.json?sp=r&sig=unit%2Bsignature", transport: "https" });
  });
  it("keeps existing loopback behavior without a proxy", () => { expect(publicDownloadUrl(source)).toEqual({ downloadUrl: source, transport: "loopback-http" }); });
  it.each(["http://remote.example/blob", "https://demo.example/other", "https://user:pass@demo.example/blob", "https://demo.example/blob?extra=1"])("rejects unsafe proxy %s", url => { expect(() => publicDownloadUrl(source, url)).toThrow(); });
  it("cannot launder a provider or arbitrary remote URL", () => { expect(() => publicDownloadUrl("https://remote.example/private?unit=1", "https://demo.example/blob")).toThrow(); });
});
