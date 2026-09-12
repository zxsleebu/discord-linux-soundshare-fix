#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { checkMaintenance } from "../lib/maintenance.mjs";

const exec = promisify(execFile);
const [mode, configPath, option] = process.argv.slice(2);
if (!["watch", "preflight", "check"].includes(mode) || !configPath) throw new Error("Usage: maintenance.mjs watch|preflight|check CONFIG");
const config = JSON.parse(await fs.readFile(configPath, "utf8"));
if (config.schemaVersion !== 1 || config.configPath !== configPath) throw new Error("Invalid maintenance configuration");
const notify = async (message) => {
  if (config.notifications === false) return;
  try { await exec("notify-send", ["--app-name=Soundshare Fix", "--icon=audio-volume-high", "Soundshare Fix", message], { timeout: 3000 }); }
  catch { /* Desktop notifications may be unavailable before the session starts. */ }
};

if (mode === "check") {
  // This entry is invoked under flock by the watcher/launcher, never concurrently.
  const started = Date.now();
  let result;
  do {
    result = await checkMaintenance(config, { notify });
    if (option !== "--preflight" || !result.pending || Date.now() - started >= 2500) break;
    await delay(500);
  } while (true);
} else {
  let child = null;
  let stopping = false;
  function killChild(signal) {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); } catch { /* The private child group may already have exited. */ }
  }
  function stop(signal) {
    stopping = true;
    if (child) killChild(signal);
    else process.exit(0);
  }
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  async function lockedCheck() {
    return await new Promise((resolve) => {
      child = spawn("/usr/bin/flock", ["--wait", mode === "preflight" ? "4" : "0", path.join(config.payload, "maintenance.lock"),
        config.nodePath, config.script, "check", configPath, ...(mode === "preflight" ? ["--preflight"] : [])], { stdio: "inherit", detached: true });
      // Bound the preflight even if a filesystem, inspector or notification hangs.
      let killTimeout;
      const timeout = setTimeout(() => { killChild("SIGTERM"); killTimeout = setTimeout(() => killChild("SIGKILL"), 2000); }, 15000);
      child.once("error", (error) => { console.error(error.message); });
      child.once("close", (code) => { clearTimeout(timeout); clearTimeout(killTimeout); child = null; resolve(code ?? 1); });
    });
  }
  if (mode === "preflight") process.exitCode = await lockedCheck();
  else {
    while (!stopping) {
      await lockedCheck();
      if (!stopping) await delay(3000);
    }
  }
}
