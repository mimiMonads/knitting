# Security

## Reporting a problem

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/mimiMonads/knitting/security/advisories)
using **Report a vulnerability**, if available. If the form isn't available,
open an issue asking for a private contact without sharing the vulnerability.

Include the Knitting version, OS, runtime, worker settings, and a small
reproduction. Explain what an attacker could do and what access they would need.
Please keep exploit details private while a fix is being discussed.

Fixes target the latest published release. Older versions have no scheduled
backports.

## Running untrusted code

Knitting shares memory between the host and workers. Workers with access to a
buffer can read and change its contents. Native pointer APIs also depend on
correct memory lifetimes.

Worker permissions vary by runtime. Strict mode is not an OS sandbox, and a
separate process alone is not enough to contain hostile code. Check the
[permission guide](docs/guide.md#permissions) and use OS isolation where needed.
Use `importTask()` to avoid loading worker code into the host.

Compiled workers run as native executables without a sandbox. Only run artifacts
and compilers you trust. Manifest checks verify compatibility, not whether code
is safe. Timeouts and cancellation do not provide isolation.
