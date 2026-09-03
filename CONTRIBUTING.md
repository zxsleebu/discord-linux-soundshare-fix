# Contributing

Bug reports and verified support for newer Discord Linux builds are welcome.

Before submitting a compatibility update:

1. Work from a locally installed `discord_voice.node`; never attach or commit it.
2. Verify the complete call path and structure offsets, not only a byte-pattern match.
3. Add the full module SHA-256 and function offset to `runtime/supported-builds.json`.
4. Keep strict native prologue validation enabled.
5. Run `npm run verify`.

Please keep changes focused. The project intentionally avoids altering Discord's
PCM ring buffer, frame scheduler, encoder cadence, or unrelated voice behavior.
