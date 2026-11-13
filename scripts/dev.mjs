import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { C, isPortFree, killByPort, killProc, portHolders, wait, wirePrefixed } from "./lib.mjs";

const root = process.cwd();
const rustDir = path.join(root, "rust-backend");
const skipBuild = process.env.RIFTWATCH_SKIP_BUILD === "1";
const openAfterReady = process.argv.includes("--open");

const tag = (m) => `${C.dim}[dev]${C.reset} ${m}`;
const log = (m) => console.log(tag(m));
const warn = (m) => console.warn(tag(`${C.yellow}${m}${C.reset}`));
const fail = (m) => console.error(tag(`${C.red}${m}${C.reset}`));

if (!existsSync(path.join(root, "node_modules"))) {
  log("node_modules missing — running `npm install` ...");
  const r = spawnSync("npm install", { shell: true, stdio: "inherit", cwd: root, env: process.env });
  if (r.status !== 0) {
    fail("npm install failed — aborting.");
    process.exit(1);
  }
}

const candidates = [
  [path.join(rustDir, "target", "debug", "riftwatch-backend.exe"), "debug"],
  [path.join(rustDir, "target", "debug", "riftwatch-backend"), "debug"],
  [path.join(rustDir, "target", "release", "riftwatch-backend.exe"), "release"],
  [path.join(rustDir, "target", "release", "riftwatch-backend"), "release"],
];
const findBin = () => candidates.find(([p]) => existsSync(p)) ?? null;

let bin = findBin();
let buildFailed = false;
if (!bin && !skipBuild) {
  const cargo = spawnSync("cargo", ["--version"], { stdio: "ignore" });
  if (cargo.status === 0) {
    log("Rust binary missing — building debug profile (cargo build) ...");
    const r = spawnSync("cargo", ["build"], { cwd: rustDir, stdio: "inherit", env: process.env });
    if (r.status === 0) bin = findBin();
    if (!bin) buildFailed = true;
  }
}

for (const port of [3000, 3001]) {
  if ((await portHolders(port)).length === 0 && (await isPortFree(port))) continue;
  warn(`port ${port} is busy — killing whatever holds it ...`);
  killByPort(port);
  for (let i = 0; i < 15; i++) {
    await wait(300);
    if ((await portHolders(port)).length === 0 && (await isPortFree(port))) break;
  }
  if ((await portHolders(port)).length > 0 || !(await isPortFree(port))) {
    fail(`port ${port} is still in use. Run \`npm run stop\` and retry.`);
    process.exit(1);
  }
  log(`port ${port} freed`);
}

const procs = [];
let rustProc = null;
const backendNeeded = !!bin;
let backendOk = !backendNeeded;

if (bin) {
  const [binPath, flavor] = bin;
  log(`rust backend: ${flavor} (${path.relative(root, binPath)})`);
  rustProc = spawn(binPath, [], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  procs.push(rustProc);
  wirePrefixed(rustProc.stdout, "rust", C.rust);
  wirePrefixed(rustProc.stderr, "rust", C.rust);
  rustProc.on("exit", (c) => {
    if (c !== 0 && c !== null) console.error(tag(`${C.red}[rust] exited with code ${c}${C.reset}`));
  });
} else if (buildFailed) {
  warn("cargo build failed — continuing Next-only (proxy routes may 404).");
} else if (skipBuild) {
  warn("RIFTWATCH_SKIP_BUILD is set and no Rust binary exists — continuing Next-only (proxy routes may 404).");
} else {
  warn("Rust binary not found and cargo is unavailable — run `cargo build` in rust-backend/. Continuing Next-only (proxy routes may 404).");
}

let nextReady = false;
const onNextLine = (line) => {
  if (/Ready in/i.test(line)) nextReady = true;
};

const next = spawn("npx next dev -p 3000", { stdio: ["ignore", "pipe", "pipe"], shell: true, env: process.env });
procs.push(next);
wirePrefixed(next.stdout, "next", C.next, onNextLine);
wirePrefixed(next.stderr, "next", C.next, onNextLine);

let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) killProc(p);
  setTimeout(() => process.exit(code), 150);
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
next.on("exit", (code, signal) => {
  if (shuttingDown) return;
  console.error(tag(`${C.red}[next] exited ${code} signal ${signal}${C.reset}`));
  shutdown(1);
});

async function probeHealth() {
  try {
    const r = await fetch("http://127.0.0.1:3001/health", { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function openBrowser() {
  const url = "http://localhost:3000";
  if (process.platform === "win32") spawn(`start "" ${url}`, { shell: true, stdio: "ignore" });
  else if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore" });
  else spawn("xdg-open", [url], { stdio: "ignore" });
}

(async () => {
  if (backendNeeded) backendOk = await probeHealth();
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (backendOk && nextReady) break;
    if (shuttingDown) break;
    if (!backendOk && rustProc && (rustProc.exitCode !== null || rustProc.signalCode !== null)) break;
    if (!backendOk) backendOk = await probeHealth();
    await wait(400);
  }

  const backend = !backendNeeded
    ? `${C.dim}– backend skipped (Next-only)${C.reset}`
    : backendOk
      ? `${C.green}✓ backend${C.reset} 127.0.0.1:3001`
      : `${C.yellow}✗ backend${C.reset} 127.0.0.1:3001 (proxy routes will 404)`;
  const frontend = nextReady
    ? `${C.green}✓ frontend${C.reset} localhost:3000`
    : `${C.yellow}✗ frontend${C.reset} localhost:3000 (not ready yet)`;
  console.log(tag(`${backend}   ${frontend}   ${C.dim}→ http://localhost:3000${C.reset}`));
  if (openAfterReady && nextReady) openBrowser();
})();
