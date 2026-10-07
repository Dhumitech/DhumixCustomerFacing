import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "win32")("0072 approval boundary", () => {
  it("qualifies review refusals, pinned evidence, single-phase transactions and failure recovery offline", () => {
    const script = fileURLToPath(new URL("../../scripts/refactor-review/Test-0072-Offline.ps1", import.meta.url));
    const result = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script], {
      encoding: "utf8", windowsHide: true, timeout: 30000,
    });
    if (result.error) throw result.error;
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/PASSED: \d+ offline 0072 checks/);
  }, 35000);
});
