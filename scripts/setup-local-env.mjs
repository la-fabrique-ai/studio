import { randomBytes } from "node:crypto";
import { mkdir, readFile, lstat, readlink, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = ".infra/local/.env";

async function statIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function main() {
  // Next.js overrides .env with these files; dotenv-based DB scripts do not.
  for (const name of [".env.local", ".env.development", ".env.development.local"]) {
    if (await statIfPresent(resolve(root, name))) {
      throw new Error(`${name} exists. Reconcile it manually before setting up the shared local environment.`);
    }
  }
  const envPath = resolve(root, ".env");
  const existing = await statIfPresent(envPath);
  if (existing && (!existing.isSymbolicLink() || await readlink(envPath) !== target)) {
    throw new Error(".env already exists. Preserve it and reconcile it manually; no file was overwritten.");
  }

  await mkdir(resolve(root, ".infra/local"), { recursive: true });
  if (!await statIfPresent(resolve(root, target))) {
    const template = await readFile(resolve(root, ".env.example"), "utf8");
    const content = template
      .replace("change-me-openssl-rand-base64-32", randomBytes(32).toString("hex"))
      .replace("ChangeMe!2026", randomBytes(24).toString("hex"));
    await writeFile(resolve(root, target), content, { flag: "wx", mode: 0o600 });
  }
  if (!existing) await symlink(target, envPath);
  console.log("Local environment ready: .env -> .infra/local/.env (existing secrets preserved).");
  console.log("Next: pnpm services:start, pnpm db:migrate, then pnpm dev.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
