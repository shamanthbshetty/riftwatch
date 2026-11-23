// Prune Rust build debris that cargo never garbage-collects.
//
// `cargo build` writes a new `deps/riftwatch_backend-<hash>.exe` on every
// relink and keeps old ones forever; incremental sessions likewise pile up
// under `incremental/`. Those are regenerable, so this script deletes them
// while keeping dependency `.rlib`/`.rmeta` (fast rebuilds) and the release
// profile (the shipped binary).
//
// Default: debug incremental state + stale debug deps binaries.
// `--all`:  also drop build-script output (`target/*/build`) and prune release.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { C } from "./lib.mjs";

const root = process.cwd();
const targetDir = path.join(root, "rust-backend", "target");
const all = process.argv.includes("--all");

const log = (m) => console.log(`${C.dim}[clean:rust]${C.reset} ${m}`);
const fmt = (bytes) => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
};

function sizeOf(p) {
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const name of readdirSync(p)) total += sizeOf(path.join(p, name));
    return total;
  } catch {
    return 0;
  }
}

function remove(p, freed) {
  if (!existsSync(p)) return;
  // Cargo hardlinks the newest deps binary to target/<profile>/riftwatch-backend.exe.
  // Deleting that link frees nothing and would force a needless relink.
  try {
    if (statSync(p).nlink > 1) {
      log(`kept ${path.relative(root, p)} (hardlinked to the runnable binary)`);
      return;
    }
  } catch {
    /* fall through to the delete path */
  }
  const bytes = sizeOf(p);
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    freed.push({ path: path.relative(root, p), bytes });
    log(`removed ${path.relative(root, p)} (${fmt(bytes)})`);
  } catch (err) {
    log(`skipped ${path.relative(root, p)}: ${err.code ?? err.message}`);
  }
}

if (!existsSync(targetDir)) {
  log("no rust-backend/target — nothing to prune");
  process.exit(0);
}

const profiles = readdirSync(targetDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => all || name === "debug");

const freed = [];
for (const profile of profiles) {
  const dir = path.join(targetDir, profile);
  remove(path.join(dir, "incremental"), freed);
  if (all) remove(path.join(dir, "build"), freed);

  const deps = path.join(dir, "deps");
  if (existsSync(deps)) {
    for (const name of readdirSync(deps)) {
      if (/\.(exe|pdb)$/i.test(name)) remove(path.join(deps, name), freed);
    }
  }
}

const total = freed.reduce((sum, f) => sum + f.bytes, 0);
const remaining = sizeOf(targetDir);
log(`freed ${fmt(total)} — target is now ${fmt(remaining)}`);
if (!all) log("tip: `npm run clean:rust -- --all` also prunes build-script output and release debris");
