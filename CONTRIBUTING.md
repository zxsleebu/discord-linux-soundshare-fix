# Contributing

Bug reports and verified support for newer Discord Linux builds are welcome.

Before submitting a compatibility update:

1. Work from a locally installed `discord_voice.node`; never attach or commit it.
2. Verify the complete call path and symbol semantics, not only a byte-pattern match.
3. Keep exact ELF symbol lookup and conservative prologue decoding enabled.
4. Add a focused fixture when extending the x86-64 decoder.
5. Run `npm run verify`, including the real preload smoke test.

Please keep changes focused. The project intentionally avoids altering Discord's
PCM ring buffer, frame scheduler, encoder cadence, or unrelated voice behavior.
