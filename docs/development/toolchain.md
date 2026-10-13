# Toolchain and checks

| Tool | Version / contract | Purpose |
| --- | --- | --- |
| Node.js | 24+; local validation includes 24.14.1 and 26.8.2 | Published CLI runtime and native test runner |
| TypeScript | 5.9.3 | Compile ESM JavaScript and declarations |
| Yarn Classic | 1.22.22 | Install locked dependencies only |
| Task | 3.53.1 locally; Task 3 | Development entry points |
| tmux | 3.3+; local 3.7c | Terminal execution; rename format semantics change in 3.6 |
| util-linux flock | Linux open-file-description advisory locks | Serialize writers and release on process death |
| TypeBox | 0.34.52 | Configuration type and generated schema |
| Ajv | 8.20.0 | Runtime JSON Schema validation |
| yaml | 2.9.1 | YAML parsing with duplicate-key and alias limits |
| Commander | 15.0.0 | CLI parsing |
| @types/node | 24.19.2 | Runtime type contracts |
| systemd | Optional Linux user manager | Boot initialization; dedicated server lifecycle |
| Git / GitHub CLI | Host-provided | Source control and repository delivery |
| curl, tar, make, C compiler, bison, libevent/ncurses development headers | CI host packages | Build tmux 3.3a/3.5a/3.7c for compatibility checks |
| GitHub Actions checkout / setup-node / setup-task | v4 / v4 / v2 | Read-only CI; Node 24/26 × tmux 3.3a/3.5a/3.7c |

From a clean clone:

```sh
task --list
task install
task build
task check
task test
task docs:check
task pack
```

`task test -- test/recovery.test.mjs` selects explicit tests. All tmux test servers
use isolated sockets inside `.temp/`; test cleanup targets only those servers.
Integration tests exercise ownership, repeated and concurrent apply, live process
preservation, special characters, pending/unknown launch states, sticky shell
signals, and destructive-operation boundaries.

`task test:systemd` is an opt-in check against an available user systemd manager.
It temporarily links uniquely named units, starts a private server, restarts its
apply unit, then stops and unlinks its test units. It does not touch ordinary
development sessions. The ordinary test suite skips this check unless opted in.

The CLI uses `node:child_process` argv calls and a per-pane Node supervisor.
This avoids depending on experimental `process.execve`, at the cost of one Node
process per managed pane. Large-workspace memory use has not been benchmarked.

Temporary checkouts, test data and npm tarballs live under ignored `.temp/`.
The generated schema is committed; `task build` regenerates it from TypeBox.
CI installs the same locked dependencies and tests Node.js and tmux releases.
