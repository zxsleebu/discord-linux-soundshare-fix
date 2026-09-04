# Discord Linux Soundshare Fix

[![CI](https://github.com/zxsleebu/discord-linux-soundshare-fix/actions/workflows/ci.yml/badge.svg)](https://github.com/zxsleebu/discord-linux-soundshare-fix/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Linux x86_64](https://img.shields.io/badge/platform-Linux%20x86__64-fcc624?logo=linux&logoColor=black)](#compatibility)

Prevents Discord screen-share audio from dropping out when PipeWire or
PulseAudio creates a new audio node on Linux.

Discord normally treats every newly monitored sink input as a fresh successful
soundshare start. That duplicate notification reaches
`LocalUser::SignalOnSoundshare`, destroys the active WebRTC audio send stream,
and creates it again. This fix makes only duplicate success notifications
idempotent. The first start, every stop/failure, and Discord's original audio
capture cadence remain unchanged.

Version 0.2 hooks Discord only in memory. It does not modify
`discord_voice.node`, Discord's JavaScript, or any system file.

## Install

Download and extract the latest release, then run:

```bash
./install.sh
```

No root access and no systemd service are required. Fully quit Discord,
including its tray process, and start it again from the usual icon.

The installer supports Stable, Canary, and PTB desktop entries. To select one:

```bash
./install.sh --channel canary
```

### Build from source

Requirements: Linux x86_64, Node.js 20 or newer, Python, a C++20 compiler, and
`make`.

```bash
git clone https://github.com/zxsleebu/discord-linux-soundshare-fix.git
cd discord-linux-soundshare-fix
npm install
npm run verify
./install.sh
```

## What the installer changes

The payload is stored entirely in the user's data directory:

```text
~/.local/share/discord-soundshare-fix/
  libdiscord_soundshare_fix_preload.so
  discord-soundshare-fix-launch
  preload-installation.json
```

It also creates an XDG override at the same desktop ID, for example:

```text
/usr/share/applications/discord.desktop
            ↓ overridden by
~/.local/share/applications/discord.desktop
```

The override retains Discord's existing name, icon, `StartupWMClass`, URL
handler, and command-line arguments. KDE/GNOME therefore presents the same
Discord application and the same pinned icon. The only functional difference
is that the command first exports `LD_PRELOAD` and then executes the original
Discord binary.

If Discord already has an XDG autostart entry, the installer wraps that entry
too and preserves an exact backup for uninstall.

Launching `/usr/bin/discord` directly bypasses the desktop override. Launching
Discord from the application menu, a pinned icon, or a `discord://` link uses
the fix.

Flatpak is not supported by this installer yet because its sandbox requires a
different library placement and environment override.

## Discord updates

Ordinary Discord updates require no reinstall. On every process start the
preload library waits for `discord_voice.node`, reads its local ELF symbol
table, finds the exact mangled symbol for
`LocalUser::SignalOnSoundshare(bool)`, and decodes enough whole x86-64
instructions for a safe trampoline. No version-specific file offset or object
layout offset is stored.

The same resolver has been checked against:

| Discord build | Platform | Result |
| --- | --- | --- |
| Stable 1.0.156 | Linux x86_64 | Compatible, symbol `0x3bf110` |
| Canary 1.0.1773 | Linux x86_64 | Compatible, symbol `0x3c14f0` |

This cannot promise compatibility with an arbitrary future rewrite. If Discord
removes local symbols, introduces an unsafe position-dependent prologue, or
changes the soundshare semantics, the hook fails closed and Discord continues
without the fix. In that case this project needs an update; it will not guess an
address and corrupt the process.

## Status, diagnostics, and uninstall

```bash
node ./bin/discord-soundshare-fix.mjs status
node ./bin/discord-soundshare-fix.mjs uninstall
```

Uninstall verifies the managed files, restores pre-existing user/autostart
entries byte-for-byte, and removes generated overrides and the payload.

Set `DISCORD_SOUNDSHARE_FIX_DISABLE=1` to load Discord without activating the
hook. For runtime messages and the duplicate counter, launch once with:

```bash
DISCORD_SOUNDSHARE_FIX_DEBUG=1 \
  ~/.local/share/discord-soundshare-fix/discord-soundshare-fix-launch \
  /usr/bin/discord
```

Release archives also contain an offline compatibility inspector:

```bash
./dist/discord_soundshare_fix_inspect \
  ./dist/libdiscord_soundshare_fix_preload.so \
  ~/.config/discord/app-*/modules/discord_voice-*/discord_voice/discord_voice.node
```

## Safety model

- The Discord binary and `discord_voice.node` are never modified or
  redistributed.
- Function discovery uses an exact C++ symbol, not a byte-pattern guess.
- The decoder rejects relative branches, calls, RIP-relative operands, and
  unknown instructions in the overwritten prologue.
- Loaded bytes must match the ELF file before memory is changed.
- The trampoline jump preserves every CPU register.
- Desktop writes are atomic and pre-existing user files are backed up.
- Unrecognized updates fail closed.

## Verified event chain

```text
new PulseAudio sink input
  → PulseAudioController::MonitorSinkInput
  → duplicate Status::Success
  → AudioDevice::Impl::OnStart
  → LocalUser::SignalOnSoundshare(true)
  → DestroyAudioStream + CreateAudioStream
```

The preload hook tracks active `LocalUser` instances itself, so it does not rely
on Discord's changing object layout. A duplicate `true` is suppressed; `false`
removes that instance from the active set and is forwarded to Discord.

## Credits

Root cause analysis and the first working patch were developed collaboratively
by [sleebu](https://github.com/zxsleebu) and OpenAI Codex, using runtime logs and
reverse engineering of the locally installed Discord module.

Discord is a trademark of Discord Inc. This project is an independent,
unofficial compatibility fix and is not affiliated with Discord Inc.
