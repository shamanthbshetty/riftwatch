import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] === "dev" ? "dev" : "build";
const extraArgs = process.argv.slice(3);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host:\s*(.+)$/m)[1].trim();
const isWindows = process.platform === "win32";
const ext = isWindows ? ".exe" : "";
const sidecarPath = path.join(root, "src-tauri", "binaries", `riftwatch-backend-${host}${ext}`);

console.log(`[tauri] building Rust backend for ${host}`);
run("cargo", ["build", "--release", "--manifest-path", path.join("rust-backend", "Cargo.toml")]);

const built = path.join(root, "rust-backend", "target", "release", `riftwatch-backend${ext}`);
if (!existsSync(built)) {
  console.error(`[tauri] backend binary not found at ${built}`);
  process.exit(1);
}
mkdirSync(path.dirname(sidecarPath), { recursive: true });
copyFileSync(built, sidecarPath);
console.log(`[tauri] sidecar ready: ${path.relative(root, sidecarPath)}`);

const env = { ...process.env };
const args = ["tauri", mode, ...extraArgs];

if (mode === "dev") {
  // The production window loads the custom `riftwatch://` protocol. In dev,
  // point it at the Next dev server instead so hot reload works.
  args.push("--config", "src-tauri/tauri.dev.conf.json");
}

if (mode === "build") {
  const keyPath = path.join(root, "src-tauri", "keys", "riftwatch.key");
  const passwordPath = `${keyPath}.password`;
  const hasKeyFile = existsSync(keyPath);
  if (hasKeyFile || env.TAURI_SIGNING_PRIVATE_KEY) {
    if (hasKeyFile && !env.TAURI_SIGNING_PRIVATE_KEY) {
      env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, "utf8").trim();
      if (existsSync(passwordPath)) {
        env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = readFileSync(passwordPath, "utf8").trim();
      }
    }
    args.push("--config", "src-tauri/tauri.updater.conf.json");
    console.log(
      hasKeyFile
        ? "[tauri] signing updater artifacts with src-tauri/keys/riftwatch.key"
        : "[tauri] signing updater artifacts with TAURI_SIGNING_PRIVATE_KEY",
    );
  } else {
    console.warn("[tauri] no signing key - building installer without updater artifacts");
  }
}

// The GNU Windows toolchain breaks tauri-winres when the checkout path has
// spaces (windres receives unquoted paths). Point Cargo at a space-free target
// dir for the Tauri crate only; the backend build above is unaffected.
if (isWindows && host.includes("windows-gnu") && /\s/.test(root)) {
  const targetDir = path.join(path.parse(root).root, "riftwatch-target", "app");
  env.CARGO_TARGET_DIR = targetDir;
  console.log(`[tauri] GNU toolchain + spaces in path; CARGO_TARGET_DIR=${targetDir}`);
}

run("npx", args, { env });
