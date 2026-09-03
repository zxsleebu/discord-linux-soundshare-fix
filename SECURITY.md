# Security

This project writes an in-memory jump into a version-locked Discord native
module. An incorrect target is therefore treated as a security issue.

Please report vulnerabilities privately through GitHub's **Report a
vulnerability** feature. Do not include Discord binaries, account tokens, or
private logs in a public issue.

Only module hashes listed in `runtime/supported-builds.json` are supported.
Unknown builds must fail closed.
