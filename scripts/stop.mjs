import { killByName, killByPort } from "./lib.mjs";

let killed = 0;
killed += killByName("riftwatch-backend.exe");
killed += killByName("riftwatch-backend");
killed += killByPort(3000);
killed += killByPort(3001);

console.log(
  killed > 0
    ? `Stopped dev server and Rust backend (${killed} process(es) killed).`
    : "Nothing to stop — ports 3000/3001 are free."
);
