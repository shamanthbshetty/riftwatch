import { spawnSync } from "node:child_process";
import net from "node:net";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const isWin = process.platform === "win32";
const RESET = "\x1b[0m";

export const C =
  process.stdout.isTTY && !process.env.NO_COLOR
    ? {
        rust: "\x1b[36m",
        next: "\x1b[35m",
        dim: "\x1b[2m",
        green: "\x1b[32m",
        yellow: "\x1b[33m",
        red: "\x1b[31m",
        reset: RESET,
      }
    : { rust: "", next: "", dim: "", green: "", yellow: "", red: "", reset: "" };

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen({ port, host: "0.0.0.0" });
  });
}

function winPidsViaPowerShell(port) {
  const res = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$p = @(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique; $p | Where-Object { $_ -ne 0 -and (Get-Process -Id $_ -ErrorAction SilentlyContinue) }`,
    ],
    { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }
  );
  return (res.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s) && s !== String(process.pid));
}

function winPidsViaNetstat(port) {
  const res = spawnSync("netstat", ["-ano"], { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
  const pids = [];
  for (const line of (res.stdout || "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== "TCP") continue;
    const [, local] = parts;
    const pid = parts[parts.length - 1];
    if (!local.endsWith(`:${port}`)) continue;
    if (pid === "0" || pid === String(process.pid)) continue;
    pids.push(pid);
  }
  return pids;
}

// Live PIDs holding a local socket on `port` (any state — zombie/bound sockets
// included; netstat alone misses some of those on Windows).
export function portHolders(port) {
  if (isWin) {
    const ps = winPidsViaPowerShell(port);
    return ps.length ? [...new Set(ps)] : [...new Set(winPidsViaNetstat(port))];
  }
  const res = spawnSync("sh", ["-c", `lsof -t -iTCP:${port} 2>/dev/null || true`], { encoding: "utf8" });
  return [...new Set((res.stdout || "").split(/\s+/).filter(Boolean))].filter((pid) => pid !== String(process.pid));
}

export function killByPort(port) {
  const pids = portHolders(port);
  if (isWin) {
    for (const pid of pids) spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
  } else {
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {}
    }
  }
  return pids.length;
}

export function killByName(name) {
  if (isWin) {
    const res = spawnSync("taskkill", ["/IM", name, "/T", "/F"], { stdio: "ignore" });
    return res.status === 0 ? 1 : 0;
  }
  const res = spawnSync("pkill", ["-9", "-f", name], { stdio: "ignore" });
  return res.status === 0 ? 1 : 0;
}

export function killProc(p) {
  if (!p || p.pid == null || p.exitCode !== null || p.signalCode !== null) return;
  if (isWin) spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      p.kill("SIGTERM");
    } catch {}
  }
}

export function linePrefix(tag, color) {
  const label = `${color}[${tag}]${C.reset} `;
  const decoder = new StringDecoder("utf8");
  let buf = "";
  return new Transform({
    transform(chunk, _enc, cb) {
      buf += decoder.write(chunk);
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        this.push(label + line + "\n");
        this.emit("line", line);
      }
      cb();
    },
    flush(cb) {
      buf += decoder.end();
      if (buf) {
        const line = buf.replace(/\r$/, "");
        this.push(label + line + "\n");
        this.emit("line", line);
      }
      cb();
    },
  });
}

export function wirePrefixed(stream, tag, color, onLine) {
  const prefix = linePrefix(tag, color);
  if (onLine) prefix.on("line", onLine);
  stream.pipe(prefix).pipe(process.stdout);
  return prefix;
}
