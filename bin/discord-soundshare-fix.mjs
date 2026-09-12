#!/usr/bin/env node

import {
  discoverInstalls,
  inspectPreloadInstallation,
  inspectTarget,
  installPreload,
  installTarget,
  targetFromPath,
  uninstallPreload,
  uninstallTarget,
  refreshPreloadLibrary,
} from "../lib/installer.mjs";
import { installIndicator, inspectIndicator, uninstallIndicator } from "../lib/indicator-installer.mjs";
import { installMaintenance, inspectMaintenance, uninstallMaintenance, SERVICE_NAME } from "../lib/maintenance.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

const CHANNELS = new Set(["stable", "canary", "ptb"]);

const HELP = `discord-soundshare-fix

Usage:
  discord-soundshare-fix status
  discord-soundshare-fix install [--channel stable|canary|ptb]
  discord-soundshare-fix uninstall [--channel stable|canary|ptb]
  discord-soundshare-fix indicator-install [--channel stable|canary|ptb]
  discord-soundshare-fix indicator-status [--channel stable|canary|ptb]
  discord-soundshare-fix indicator-uninstall [--channel stable|canary|ptb]
  discord-soundshare-fix maintenance-install [--channel stable|canary|ptb]
  discord-soundshare-fix maintenance-status
  discord-soundshare-fix maintenance-uninstall

The default installer creates a transparent XDG desktop override. It keeps the
same Discord icon and starts the real client with the in-memory LD_PRELOAD hook.
Discord files are not modified.
Optional indicator/maintenance commands add a backed-up JavaScript loader.

Legacy v0.1 commands:
  discord-soundshare-fix legacy-status [--channel NAME] [--path DIR]
  discord-soundshare-fix legacy-install [--channel NAME] [--path DIR] [--all]
  discord-soundshare-fix legacy-uninstall [--channel NAME] [--path DIR] [--all]

Options:
  --channel NAME  Select one Discord channel
  --path DIR      Select a legacy app-* or discord_voice directory
  --all           Select every legacy installation
  -h, --help      Show this help
`;

function parseArguments(argv) {
  const result = { command: "status", channel: null, customPath: null, all: false };
  const args = [...argv];
  if (args[0] && !args[0].startsWith("-")) result.command = args.shift();

  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "-h" || argument === "--help") return { ...result, help: true };
    if (argument === "--all") {
      result.all = true;
      continue;
    }
    if (argument === "--channel") {
      result.channel = args.shift();
      if (!CHANNELS.has(result.channel)) throw new Error("--channel must be stable, canary, or ptb");
      continue;
    }
    if (argument === "--path") {
      result.customPath = args.shift();
      if (!result.customPath) throw new Error("--path requires a value");
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function printLegacyState(state) {
  const support = state.supported ? state.build.label : "unsupported";
  const installation = state.installed ? "installed" : "not installed";
  console.log(`${state.channel.padEnd(7)} ${state.appVersion.padEnd(10)} ${installation.padEnd(13)} ${support}`);
  console.log(`         ${state.moduleDirectory}`);
  console.log(`         sha256 ${state.moduleHash}`);
}

async function runLegacy(options) {
  let targets = options.customPath
    ? [await targetFromPath(options.customPath)]
    : await discoverInstalls();
  if (options.channel) targets = targets.filter((target) => target.channel === options.channel);
  if (targets.length === 0) throw new Error("No matching Discord installation was found");

  if (options.command === "legacy-status") {
    for (const target of targets) printLegacyState(await inspectTarget(target));
    return;
  }
  if (targets.length > 1 && !options.all) {
    throw new Error("Multiple Discord installations matched. Use --channel, --path, or --all.");
  }

  for (const target of targets) {
    if (options.command === "legacy-install") {
      const state = await installTarget(target);
      console.log(`Installed legacy loader for ${state.build.label}: ${target.moduleDirectory}`);
    } else {
      const removed = await uninstallTarget(target);
      console.log(`${removed ? "Uninstalled legacy loader" : "Legacy loader not installed"}: ${target.moduleDirectory}`);
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }

  if (options.command.startsWith("legacy-")) {
    if (!new Set(["legacy-status", "legacy-install", "legacy-uninstall"]).has(options.command)) {
      throw new Error(`Unknown command: ${options.command}`);
    }
    await runLegacy(options);
    return;
  }
  if (options.command.startsWith("indicator-")) {
    if (!["indicator-install", "indicator-status", "indicator-uninstall"].includes(options.command)) throw new Error("Unknown indicator command");
    if (options.customPath || options.all) throw new Error("Use --channel for the indicator");
    const targets = (await discoverInstalls()).filter((target) => !options.channel || target.channel === options.channel);
    if (!targets.length) throw new Error("No matching Discord installation found");
    if (options.command === "indicator-uninstall" && (await inspectMaintenance()).files.length) {
      throw new Error("Run maintenance-uninstall first, otherwise automatic repair would reinstall the indicator");
    }
    if (options.command === "indicator-install") await refreshPreloadLibrary();
    for (const target of targets) {
      if (options.command === "indicator-install") {
        console.log(`Indicator installed: ${await installIndicator(target)}`);
      } else if (options.command === "indicator-uninstall") {
        console.log(`${target.channel}: ${await uninstallIndicator(target) ? "indicator removed" : "not installed"}`);
      } else {
        console.log(`${target.channel} ${target.appVersion}: ${(await inspectIndicator(target)).reason}`);
      }
    }
    if (options.command !== "indicator-status") console.log("Fully quit Discord and restart from the usual icon. The running client is unchanged.");
    return;
  }
  if (options.command.startsWith("maintenance-")) {
    if (options.customPath || options.all) throw new Error("Use --channel for maintenance installation");
    if (options.command === "maintenance-install") {
      const config = await installMaintenance({ channels: options.channel ? [options.channel] : ["stable"] });
      await exec("systemctl", ["--user", "daemon-reload"]);
      await exec("systemctl", ["--user", "enable", "--now", SERVICE_NAME]);
      console.log(`Maintenance enabled for ${config.channels.join(", ")}; running Discord was not restarted.`);
      for (const guard of config.guards) console.log(`Autostart protected: ${guard.unit}`);
    } else if (options.command === "maintenance-status") {
      const status = await inspectMaintenance();
      console.log(`Maintenance files: ${status.installed ? "ready" : "not installed or changed"}`);
      for (const file of status.files) console.log(`  ${file.valid ? "ready" : "changed"} ${file.path}`);
      if (status.checkedAt) console.log(`Last check: ${status.checkedAt}`);
      for (const diagnostic of status.diagnostics ?? []) console.log(`  ${diagnostic}`);
      const runtime = await exec("systemctl", ["--user", "show", SERVICE_NAME, "-p", "ActiveState", "-p", "SubState", "-p", "UnitFileState"]).catch(() => ({ stdout: "systemd status unavailable\n" }));
      console.log(runtime.stdout.trim());
    } else if (options.command === "maintenance-uninstall") {
      if (options.channel) throw new Error("Maintenance uninstall removes the entire maintenance service");
      await exec("systemctl", ["--user", "disable", "--now", SERVICE_NAME]);
      const removed = await uninstallMaintenance();
      await exec("systemctl", ["--user", "daemon-reload"]);
      console.log(removed ? "Maintenance removed; original launcher restored. Audio fix and indicator remain installed." : "Maintenance was not installed.");
    } else throw new Error("Unknown maintenance command");
    return;
  }
  if (!new Set(["status", "install", "uninstall"]).has(options.command)) {
    throw new Error(`Unknown command: ${options.command}`);
  }
  if (options.customPath || options.all) {
    throw new Error("--path and --all are only used by legacy commands");
  }

  if (options.command === "status") {
    const status = await inspectPreloadInstallation();
    if (status.entries.length === 0) {
      console.log("Transparent preload: not installed");
      return;
    }
    console.log(`Transparent preload: ${status.installed ? "installed" : "needs repair"}`);
    for (const entry of status.entries) {
      console.log(`  ${entry.channel.padEnd(7)} ${(entry.kind ?? "application").padEnd(11)} ${entry.guarded ? "systemd guarded" : entry.valid ? "ready" : "changed"}  ${entry.destinationPath}`);
    }
    return;
  }

  const channels = options.channel ? [options.channel] : undefined;
  if (options.command === "install") {
    const result = await installPreload({ channels });
    console.log(`Installed transparent preload ${result.toolVersion}:`);
    for (const entry of result.entries) {
      console.log(`  ${entry.channel.padEnd(7)} ${(entry.kind ?? "application").padEnd(11)} ${entry.destinationPath}`);
    }
    console.log("Fully quit Discord, including its tray process, and start it from the usual icon.");
  } else {
    const removed = await uninstallPreload({ channels });
    if (removed.length === 0) {
      console.log("Transparent preload is not installed for the selected channel.");
    } else {
      for (const entry of removed) console.log(`Uninstalled: ${entry.channel} (${entry.destinationPath})`);
    }
  }
}

main().catch((error) => {
  console.error(`discord-soundshare-fix: ${error.message}`);
  process.exitCode = 1;
});
