"use strict";

// Real-Windows acceptance fixture. It intentionally emits no stdout/stderr before termination:
// node-pty's Windows kill path historically waited for first output and therefore could strand
// this otherwise valid process forever. Its child makes taskkill's `/T` tree traversal observable:
// killing only the root must leave the child alive and fail the acceptance harness. PID evidence is
// written exclusively to a task-owned file, never through the terminal being tested.
const { spawn } = require("child_process");
const fs = require("fs");

if (process.argv[2] !== "--child") {
  const evidencePath = process.argv[2];
  if (!evidencePath) process.exit(2);
  const child = spawn(process.execPath, [__filename, "--child"], {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
    windowsHide: true,
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) process.exit(3);
  fs.writeFileSync(
    evidencePath,
    JSON.stringify({ parentPid: process.pid, childPid: child.pid }),
    { flag: "wx", mode: 0o600 },
  );
}

setInterval(() => {}, 0x7fffffff);
