import { spawn } from "node:child_process";
import { C, wirePrefixed } from "./lib.mjs";

const jobs = [
  { tag: "lint", color: C.rust, cmd: "npx eslint" },
  { tag: "typecheck", color: C.next, cmd: "npx tsc --noEmit" },
];

const codes = new Map();
const finished = new Set();

function summarize(job, code) {
  if (finished.has(job.tag)) return;
  finished.add(job.tag);
  codes.set(job.tag, code);
  if (finished.size < jobs.length) return;

  let failed = 0;
  for (const j of jobs) {
    const c = codes.get(j.tag);
    if (c === 0) {
      console.log(`${C.dim}[check]${C.reset} ${C.green}✓ ${j.tag}${C.reset}`);
    } else {
      failed += 1;
      console.error(`${C.dim}[check]${C.reset} ${C.red}✗ ${j.tag} (exit ${c})${C.reset}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

for (const job of jobs) {
  const p = spawn(job.cmd, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
  wirePrefixed(p.stdout, job.tag, job.color);
  wirePrefixed(p.stderr, job.tag, job.color);
  p.on("exit", (code) => summarize(job, code));
  p.on("error", () => summarize(job, 127));
}
