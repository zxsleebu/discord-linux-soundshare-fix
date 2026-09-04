# Security

This project writes an in-memory jump into Discord's native voice module. An
incorrect symbol, unsafe relocated instruction, or installer overwrite is
therefore treated as a security issue.

Please report vulnerabilities privately through GitHub's **Report a
vulnerability** feature. Do not include Discord binaries, account tokens, or
private logs in a public issue.

The preload resolver must require the exact C++ symbol, verify loaded bytes
against the ELF file, and reject unknown or position-dependent prologues. It
must fail closed when those conditions are not met.
