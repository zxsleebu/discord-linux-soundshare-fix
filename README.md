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

The default installer hooks Discord only in memory. It does not modify
`discord_voice.node`, Discord's JavaScript, or any system file. The optional
in-app indicator below adds a backed-up JavaScript loader.

## Optional in-app indicator

After building and installing the preload fix, enable the indicator for your client:

```bash
node bin/discord-soundshare-fix.mjs indicator-install --channel stable
node bin/discord-soundshare-fix.mjs indicator-status --channel stable
```

Fully quit Discord (including the tray process) and start it from the usual icon.
A small dot appears at the upper-right corner of the screen-share button.
Hover over the dot, or focus the button with the keyboard, to see the tooltip.
Clicks still reach the original button, including **Stop Streaming**.

- Green: the native hook is installed and its jump bytes still match.
- Yellow: the library is waiting for the voice module.
- Red: the fix is absent, disabled, failed to install, or the hook no longer matches.
- Grey: status is unavailable, including an older loaded library without telemetry.

The tooltip reports signal calls and suppressed duplicate restarts in this renderer
process, not just the current stream. Zero suppressed restarts is normal. Green does
not prove audio quality, A/V sync, or delivery to viewers.

The UI uses a separate, read-only Node-API bridge to the already-loaded preload
library. It does not install another hook, expose privileged APIs to the page,
open a debugging port, or change Electron security settings. Exact English and
Russian accessible screen-share button names are supported; unknown labels are
ignored. Pop-out windows without the voice module are not covered.

Installation backs up `discord_voice/index.js` next to the original, adds the
`discord-soundshare-indicator/` subdirectory, and updates our preload library
(saving the previous library as `.before-indicator`). Changes to the loader or its
backup are checksum-protected. Existing client mods are preserved. Uninstall with:

```bash
node bin/discord-soundshare-fix.mjs indicator-uninstall --channel stable
```

Then restart Discord. This restores the original loader but leaves the audio fix
installed. Inert indicator payload files are retained for any still-running client.
Discord updates can replace the loader: rerun `indicator-install` for a new build.
**An absent indicator is not a healthy status.** `indicator-status` checks files,
not the state of a running client. The indicator itself requires the voice wrapper
to load; if it cannot load, no badge can be drawn.

## Automatic repair after Discord updates (optional)

For a Linux desktop using systemd's XDG autostart generator (including this
KDE setup), enable local maintenance after installing the preload fix:

```bash
node bin/discord-soundshare-fix.mjs maintenance-install --channel stable
node bin/discord-soundshare-fix.mjs maintenance-status
```

This opts the selected client into indicator repair and adds:

- A preflight check in the existing launcher, before Discord starts.
- `discord-soundshare-fix-maintenance.service`, a user service polling only the
  selected Discord installations and the fix's managed launch files every 3 seconds.
- A separate drop-in for the existing generated autostart unit, such as
  `app-discord@autostart.service.d/50-soundshare-fix.conf`. It sends autostart through
  our launcher and the version-independent `/usr/bin/discord` entrypoint. Rewriting
  `~/.config/autostart/discord.desktop` no longer bypasses the fix in a systemd XDG
  session. No second autostart entry is created, and the native autostart toggle and
  conditions remain in control. Supported plain flags such as `--start-minimized`
  are preserved; later argument customizations are reported for review.

Maintenance uses a self-contained copy in the installed payload, not this Git
checkout or a temporary Node version-manager path. It does not download or execute
updates from the internet. The service runs without root, with a read-only filesystem
except the selected Discord config roots, the fix payload, and the applications
directory; code writes only its specific managed files.

New builds must have a recognizable voice wrapper and stable wrapper/module
fingerprints for at least two seconds before injection. The original is backed up.
The launcher and watcher serialize writes with `flock`. A byte-identical original
that lost its injection can be restored, as can missing owned payloads. **A changed
existing wrapper, backup, library, or payload is not silently overwritten.** In-place
module updates with a different wrapper may therefore require manual review rather
than automatic repair. The native compatibility inspector is rerun when a settled
module changes; an incompatible hook needs a new fix build, not another reinstall.

If Discord is already running without the library, or repair happens after its
voice module loaded, a deduplicated desktop notification asks for a full restart.
Maintenance never kills, restarts, or injects into a running Discord process.
The preflight is bounded; a maintenance failure does not prevent Discord opening.
State and diagnostics are stored in `maintenance-state.json` and the user service
journal. `status` distinguishes a protected systemd autostart from a changed desktop
entry; file checks alone are not proof of a healthy running hook.

To remove maintenance and restore the previous launcher:

```bash
node bin/discord-soundshare-fix.mjs maintenance-uninstall
```

The audio fix and indicator remain installed, but automatic repair/autostart
protection are removed. Remove maintenance before uninstalling the indicator or
base fix. Ownership checks prevent uninstall from overwriting later custom changes;
original managed-file contents are saved in `maintenance.json`. Inert maintenance
payload files are retained for diagnosis.

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

The native resolver is not tied to a Discord version. On every process start the
preload library waits for `discord_voice.node`, reads its local ELF symbol
table, finds the exact mangled symbol for
`LocalUser::SignalOnSoundshare(bool)`, and decodes enough whole x86-64
instructions for a safe trampoline. No version-specific file offset or object
layout offset is stored.

However, Discord can overwrite its autostart entry during an update, bypassing
the launcher. `status` reports this as `needs repair`; it is an installation
check, not proof that the fix is running. The optional UI loader may also need
reinstallation after updates.

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
