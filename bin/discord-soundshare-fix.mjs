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
} from "../lib/installer.mjs";

const CHANNELS = new Set(["stable", "canary", "ptb"]);

const HELP = `discord-soundshare-fix

Usage:
  discord-soundshare-fix status
  discord-soundshare-fix install [--channel stable|canary|ptb]
  discord-soundshare-fix uninstall [--channel stable|canary|ptb]

The default installer creates a transparent XDG desktop override. It keeps the
same Discord icon and starts the real client with the in-memory LD_PRELOAD hook.
Discord files are not modified.

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
      console.log(`  ${entry.channel.padEnd(7)} ${(entry.kind ?? "application").padEnd(11)} ${entry.valid ? "ready" : "changed"}  ${entry.destinationPath}`);
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
