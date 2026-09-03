#!/usr/bin/env node

import {
  discoverInstalls,
  inspectTarget,
  installTarget,
  targetFromPath,
  uninstallTarget,
} from "../lib/installer.mjs";

const HELP = `discord-soundshare-fix

Usage:
  discord-soundshare-fix status [--channel stable|canary|ptb] [--path DIR]
  discord-soundshare-fix install [--channel stable|canary|ptb] [--path DIR] [--all]
  discord-soundshare-fix uninstall [--channel stable|canary|ptb] [--path DIR] [--all]

Options:
  --channel NAME  Select a Discord channel
  --path DIR      Use a specific app-* or discord_voice directory
  --all           Apply the command to every selected installation
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
      if (!result.channel) throw new Error("--channel requires a value");
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

function printState(state) {
  const support = state.supported ? state.build.label : "unsupported";
  const installation = state.installed ? "installed" : "not installed";
  console.log(`${state.channel.padEnd(7)} ${state.appVersion.padEnd(10)} ${installation.padEnd(13)} ${support}`);
  console.log(`         ${state.moduleDirectory}`);
  console.log(`         sha256 ${state.moduleHash}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (!new Set(["status", "install", "uninstall"]).has(options.command)) {
    throw new Error(`Unknown command: ${options.command}`);
  }

  let targets = options.customPath
    ? [await targetFromPath(options.customPath)]
    : await discoverInstalls();
  if (options.channel) targets = targets.filter((target) => target.channel === options.channel);
  if (targets.length === 0) throw new Error("No matching Discord installation was found");

  if (options.command === "status") {
    for (const target of targets) printState(await inspectTarget(target));
    return;
  }

  if (targets.length > 1 && !options.all) {
    throw new Error("Multiple Discord installations matched. Use --channel, --path, or --all.");
  }

  for (const target of targets) {
    if (options.command === "install") {
      const state = await installTarget(target);
      console.log(`Installed for ${state.build.label}: ${target.moduleDirectory}`);
    } else {
      const removed = await uninstallTarget(target);
      console.log(`${removed ? "Uninstalled" : "Not installed"}: ${target.moduleDirectory}`);
    }
  }
}

main().catch((error) => {
  console.error(`discord-soundshare-fix: ${error.message}`);
  process.exitCode = 1;
});
