#!/bin/sh
set -eu

project_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "discord-soundshare-fix: Node.js 20 or newer is required by the installer" >&2
  exit 1
fi

exec node "$project_directory/bin/discord-soundshare-fix.mjs" install "$@"
