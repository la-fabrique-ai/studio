// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readlinkSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "studio-env-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync("scripts/setup-local-env.mjs", join(root, "scripts/setup-local-env.mjs"));
  copyFileSync(".env.example", join(root, ".env.example"));
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("shares one local env between Next.js and scripts, preserving secrets on rerun", () => {
  const root = fixture();
  const run = () => execFileSync(process.execPath, [join(root, "scripts/setup-local-env.mjs")], { encoding: "utf8" });
  const output = run();
  const first = readFileSync(join(root, ".env"), "utf8");
  expect(readlinkSync(join(root, ".env"))).toBe(".infra/local/.env");
  expect(first).toContain("127.0.0.1:5434/jiroo");
  const secret = first.match(/^BETTER_AUTH_SECRET=([a-f0-9]{64})$/m)?.[1];
  expect(secret).toBeDefined();
  expect(output).not.toContain(secret);
  expect(statSync(join(root, ".infra/local/.env")).mode & 0o777).toBe(0o600);
  run();
  expect(readFileSync(join(root, ".env"), "utf8")).toBe(first);
});

it.each([".env", ".env.local", ".env.development", ".env.development.local"])("refuses to overwrite or shadow existing %s", (name) => {
  const root = fixture();
  writeFileSync(join(root, name), "DATABASE_URL=existing-private-configuration\n");
  const result = spawnSync(process.execPath, [join(root, "scripts/setup-local-env.mjs")], { encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(readFileSync(join(root, name), "utf8")).toBe("DATABASE_URL=existing-private-configuration\n");
  expect(result.stderr).not.toContain("existing-private-configuration");
});
