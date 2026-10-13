# Declarative tmux workspace research

Reviewed 2026-10-13 for a Linux-first Node.js 24+ TypeScript CLI, packaged as
`@rezics/termspaces`. This report separates upstream observations from proposed
termspaces behavior. tmux 3.3+ is the intended compatibility range; source
comparisons below distinguish release-specific behavior. The local tmux
executable reports 3.7c.

The requested source checkouts are retained under ignored `.temp/references/`.
Their exact inspected revisions are:

| Checkout | Revision |
| --- | --- |
| `.temp/references/tmuxp` | [`fa1bd94fb22a54b9f7820ba5e3621cf2d93d603b`](https://github.com/tmux-python/tmuxp/commit/fa1bd94fb22a54b9f7820ba5e3621cf2d93d603b) |
| `.temp/references/tmuxinator` | [`d380a341b709ea7c4229a5b4e8b50ed972af302b`](https://github.com/tmuxinator/tmuxinator/commit/d380a341b709ea7c4229a5b4e8b50ed972af302b) |
| `.temp/references/sesh` | [`628bf249c3185ee4e7d5fea2076b378ca5e874d3`](https://github.com/joshmedeski/sesh/commit/628bf249c3185ee4e7d5fea2076b378ca5e874d3) |

## Decision

Build a small reconciler over tmux rather than wrap an existing session loader.
The differentiating requirement is repeatable, non-destructive application into
live workspaces, including recovery after interruption. YAML layout syntax alone
does not provide those semantics. Keep one-shot CLI commands; a daemon and
automatic task restarts are unnecessary for the MVP.

## What existing implementations establish

| Tool | Observed behavior in implementation | Useful lesson and limit |
| --- | --- | --- |
| tmuxp | `load` returns after offering to attach when the named session already exists; its classic builder creates windows and supports appending. Pane commands use `send_keys`, with optional sleeps and a cursor-based shell-readiness check. | Its session/window/pane YAML hierarchy is useful precedent. Its reviewed loader is not an ownership-based reconciler; readiness heuristics do not prove command completion. [Loader](https://github.com/tmux-python/tmuxp/blob/fa1bd94fb22a54b9f7820ba5e3621cf2d93d603b/src/tmuxp/cli/load.py), [builder](https://github.com/tmux-python/tmuxp/blob/fa1bd94fb22a54b9f7820ba5e3621cf2d93d603b/src/tmuxp/workspace/builder/classic.py). |
| tmuxinator | A generated shell template distinguishes first start, append, and existing-session restart hooks. Panes are addressed by session name and numeric indices; commands are shell-escaped and sent as keys. Window creation includes `-k`. | Shell escaping solves one parser boundary, not stable identity or recovery. Do not copy replacement-by-index into default apply. [Template](https://github.com/tmuxinator/tmuxinator/blob/d380a341b709ea7c4229a5b4e8b50ed972af302b/lib/tmuxinator/assets/template.erb), [pane](https://github.com/tmuxinator/tmuxinator/blob/d380a341b709ea7c4229a5b4e8b50ed972af302b/lib/tmuxinator/pane.rb), [window](https://github.com/tmuxinator/tmuxinator/blob/d380a341b709ea7c4229a5b4e8b50ed972af302b/lib/tmuxinator/window.rb). |
| sesh | Connection strategy prefers a running tmux session before configuration; startup executes for a new connection. Its tmux adapter passes argument arrays, qualifies session targets, and doubles `#` in creation names and paths. | Good precedent for precise targets and literal-format encoding. Its reviewed connect path attaches rather than reconciling configured panes into an existing session. [Connection](https://github.com/joshmedeski/sesh/blob/628bf249c3185ee4e7d5fea2076b378ca5e874d3/connector/connect.go), [startup branch](https://github.com/joshmedeski/sesh/blob/628bf249c3185ee4e7d5fea2076b378ca5e874d3/connector/tmux.go), [adapter](https://github.com/joshmedeski/sesh/blob/628bf249c3185ee4e7d5fea2076b378ca5e874d3/tmux/tmux.go). |
| smug | Normal start attaches to an existing session; selected windows can be added. New commands are sent as keys, with a configured delay. Socket-name/path options are explicit. | Useful small-CLI/socket precedent. Delay is a workaround for input readiness, not task state or concurrency control. [Lifecycle](https://github.com/ivaaaan/smug/blob/master/smug.go), [tmux adapter](https://github.com/ivaaaan/smug/blob/master/tmux.go). |
| laio | `start` switches to an existing session and returns. New sessions receive configuration metadata in their environment; pane commands are queued and flushed. Layout generation uses tmux IDs while constructing geometry. | Session metadata helps distinguish managed sessions. Flex layout is a possible later feature; the reviewed start path does not establish live reconciliation semantics. [Lifecycle/layout](https://github.com/ck3mp3r/laio-cli/blob/main/src/muxer/tmux/mux.rs), [client](https://github.com/ck3mp3r/laio-cli/blob/main/src/muxer/tmux/client.rs). |
| tmux-resurrect | Restore registers already-existing panes and avoids restoring their processes again, using session/window/pane indices. A special restore-from-scratch branch can replace the sole initial pane. | The explicit avoidance of rerunning existing processes is relevant. Positional identity and the special overwrite case do not meet the default apply contract. [Restore implementation](https://github.com/tmux-plugins/tmux-resurrect/blob/master/scripts/restore.sh). |
| Overmind | A concurrent Procfile manager owns a tmux control client and separate socket. It enables `remain-on-exit`, maps processes to pane IDs, observes exit state, and has explicit stop/restart policy. It kills its session if its control client unexpectedly exits. | Strong counterexample to treating all tmux managers as layout loaders: supervision is a separate product decision. Its coupled controller/session lifecycle is unsuitable when workspaces must outlive this CLI. [tmux client](https://github.com/DarthSim/overmind/blob/master/start/tmux.go), [process policy](https://github.com/DarthSim/overmind/blob/master/start/process.go). |

These are conclusions about the reviewed paths, not claims that upstream projects
could never add or host a custom reconciler.

Reading the actual checkouts confirmed these loader/attach distinctions.
In particular, sesh's window implementation and tests explicitly put a startup
command after `--` and encode literal format characters in names and working
directories. Its session renamer also encodes formats. This reinforced the need
to inspect tmux releases rather than assume shell-free argv has identical
semantics in every version.
[Window implementation](https://github.com/joshmedeski/sesh/blob/628bf249c3185ee4e7d5fea2076b378ca5e874d3/tmux/new_win.go),
[tests](https://github.com/joshmedeski/sesh/blob/628bf249c3185ee4e7d5fea2076b378ca5e874d3/tmux/new_win_test.go),
[renamer](https://github.com/joshmedeski/sesh/blob/628bf249c3185ee4e7d5fea2076b378ca5e874d3/tmux/rename.go).

## Window startup placement and ordering

The source checkouts provide related patterns, with different trigger scopes:

- **tmuxinator:** a simple `windows: [{server: "bundle exec rails s"}]` entry
  runs shell text in the new window's initial pane. `pre_window` applies to every
  pane, despite its name; a window's `pre` is likewise sent before each pane's
  own commands. The template creates windows first, then sends pane commands
  while constructing splits, and applies the final window layout afterward.
  Project hooks have broader scope: `on_project_start` runs before the
  existing-session branch, and `on_project_first_start` runs before new-session
  creation. These are shell-script/text mechanisms, not executable argv arrays.
  [Window docs](https://github.com/tmuxinator/tmuxinator/blob/d380a341b709ea7c4229a5b4e8b50ed972af302b/README.md#Windows),
  [command builder](https://github.com/tmuxinator/tmuxinator/blob/d380a341b709ea7c4229a5b4e8b50ed972af302b/lib/tmuxinator/window.rb),
  [ordering](https://github.com/tmuxinator/tmuxinator/blob/d380a341b709ea7c4229a5b4e8b50ed972af302b/lib/tmuxinator/assets/template.erb).
- **tmuxp:** window-level `shell_command_before` is inherited by **every pane**.
  The loader concatenates session-before, window-before, pane-before, and pane
  commands in that order. The classic builder sends shell text into each pane
  while constructing it. Its Python plugin callback `on_window_create` runs
  before pane construction; `after_window_finished` runs afterward. The latter
  is a useful ordering precedent, but is not a built-in YAML command executed
  once per window. `before_script` is a workspace-level subprocess before
  configured window construction, rather than a window-startup command.
  [Inheritance](https://github.com/tmux-python/tmuxp/blob/fa1bd94fb22a54b9f7820ba5e3621cf2d93d603b/src/tmuxp/workspace/loader.py#L198),
  [builder hooks](https://github.com/tmux-python/tmuxp/blob/fa1bd94fb22a54b9f7820ba5e3621cf2d93d603b/src/tmuxp/workspace/builder/classic.py).
- **sesh:** the documented `[[window]].startup_script = "git pull"` is shell
  text sent immediately after new-window creation. Session startup follows the
  configured-window loop. Its separate `window connect --command` path passes
  one shell-command string to tmux on creation, but sends keystrokes to an
  existing window on reuse. This last behavior is intentional in sesh and would
  violate termspaces' non-replay contract if copied into ordinary apply.
  [Window docs](https://github.com/joshmedeski/sesh/blob/628bf249c3185ee4e7d5fea2076b378ca5e874d3/README.md#multiple-windows),
  [startup ordering](https://github.com/joshmedeski/sesh/blob/628bf249c3185ee4e7d5fea2076b378ca5e874d3/startup/startup.go),
  [create/reuse distinction](https://github.com/joshmedeski/sesh/blob/628bf249c3185ee4e7d5fea2076b378ca5e874d3/connector/connect_window.go).

**Recommended termspaces contract:** `windows[].startup` with `mode: on-create`
and `argv` means one startup attempt in that newly created window's first
declared pane. It is an ergonomic declaration at window scope, not an external
callback process and not a command inherited by all panes. It uses that pane's
effective cwd and configured shell for the subsequent interactive prompt. Reject
an explicit first-pane startup when window startup would also control that pane.
Preserve literal argv; users request shell parsing explicitly with an executable
such as `/bin/sh` and arguments `-c`, `script text`.

Bind this startup only when creating a **window generation**, including the
first window of a new session. Repeated apply, attachment, sticky-shell restart,
and recreation of a missing first pane in an existing window do not trigger it.
Adding or changing window startup on an existing window reports deferred drift.
Explicit reset or recreation of an absent window creates a new generation and
can run the declaration again. Keep the command's origin separate from pane
defaults so ordinary missing-pane reconciliation cannot accidentally rebind it.

Release all of the window's pending runners only after its declared panes,
ownership metadata, and initial layout are initialized. Persist that completion
barrier so recovery from a partial create finishes structure before releasing
the first-pane command. Do not wait for the startup task to finish: long-running
servers are valid. There is no implied readiness or completion ordering between
different panes' tasks or between different windows. This combines the useful
placement and hook-ordering precedents above with termspaces' stricter recovery
and non-replay requirements; it is not a claim that upstream tools share the
same lifecycle contract.

Validation should prove the trigger distinctions above, reject conflicting
first-pane declarations, preserve argv metacharacters literally, and interrupt
creation before the final split/layout. On recovery the startup task must observe
the complete declared pane set and initial layout, while its external side
effect occurs at most once per window generation.

Targeted implementation validation passed with local tmux 3.7c:
`task exec -- node --test test/window-recovery.test.mjs` ran three real-tmux cases.
They cover interruption before the first split, interruption after the initialized
marker but before runner release, and an unmanaged pane inserted before initial
layout completion. Startup observed all three declared panes in the expected
horizontal layout with the completion marker set; recovery retained existing
pane IDs and ran the startup once. The unmanaged-pane case retained the manual
layout and kept pending startup commands unreleased.

## tmux boundaries that affect correctness

### Argument arrays are necessary, but insufficient

tmux 3.5a `cmd_parse_from_arguments` treats an argument ending in `;` as a command
boundary. A backslash immediately before that final semicolon is consumed to
produce a literal semicolon. Therefore encode **every literal tmux argument**
ending in `;` by inserting one backslash before its final character; preserve
any existing backslashes. Intentionally generated command separators require a
different representation. Prefer separate invocations for the MVP.
[Parser implementation](https://github.com/tmux/tmux/blob/3.5a/cmd-parse.y).

tmux's pane spawning uses `execvp` for multiple command arguments, but invokes
the configured shell with `-c` for exactly one. Use an explicit `--` boundary
before trusted launcher argv and pass at least executable plus one argument.
Keep manifest shell text in an opaque payload until the runner invokes the
chosen shell deliberately. Creation working directories and window names are
format-expanded, so encode literal `#` as `##` at those specific boundaries.
Do not globally double `#` for every argument.
[Spawn implementation](https://github.com/tmux/tmux/blob/3.5a/spawn.c),
[new-session](https://github.com/tmux/tmux/blob/3.5a/cmd-new-session.c),
[rename-window](https://github.com/tmux/tmux/blob/3.5a/cmd-rename-window.c).

**Verified compatibility:** direct fetches of the tagged sources confirm that
`rename-session` and `rename-window` call `format_single_from_target` in every
supported release checked: **3.3a, 3.5a, and 3.7c**. Creation names and working
directories also undergo format expansion in these releases. Double literal
`#` in both creation and rename names throughout the supported 3.3+ range; no
rename version gate is needed. Validate names containing `#{pid}`,
`#(touch SENTINEL)`, and ordinary `#` against real binaries. For dependency
reporting, query the running server's `#{version}` when present, since an
executable upgrade does not itself replace the long-lived server.
[3.3a session rename](https://github.com/tmux/tmux/blob/3.3a/cmd-rename-session.c),
[3.3a window rename](https://github.com/tmux/tmux/blob/3.3a/cmd-rename-window.c),
[3.5a window rename](https://github.com/tmux/tmux/blob/3.5a/cmd-rename-window.c),
[3.7c window rename](https://github.com/tmux/tmux/blob/3.7c/cmd-rename-window.c).

Evidence correction: actual tagged source contents supersede the earlier
release-boundary inference; compatibility claims must be checked by the real
tmux matrix as well as source inspection.

`select-pane -T` also expands formats. Encode literal titles there. Option values
should stay literal; do not enable `set-option -F` for ownership or state data.
[Pane title implementation](https://github.com/tmux/tmux/blob/3.5a/cmd-select-pane.c).

### Identity belongs to objects, not positions

tmux IDs are stable for an object's lifetime; names and indices are presentation.
User options can carry strings, but lookup can fall back through pane, window,
and session scopes. Use distinct ownership keys for each resource scope, and
avoid interpreting inherited values as proof of local ownership. The current
format lookup searches multiple scopes explicitly. Distinct key names alone do
not prove own-object membership: `show-options` with an explicit scope and
without `-A` uses `options_get_only`, so use it for ownership, identity, and
attempt metadata. A parent/global ownership tag must never authorize destruction
of an unowned child.
[tmux target/option documentation](https://man.openbsd.org/tmux.1),
[format lookup](https://github.com/tmux/tmux/blob/3.5a/format.c),
[own-option lookup](https://github.com/tmux/tmux/blob/3.5a/cmd-show-options.c#L112).

**Proposed identity:** explicit workspace/session/window/pane IDs in YAML,
ownership protocol version, and one server-generation UUID. Match these tags,
then address tmux by its actual IDs. A configuration file's path, display name,
list position, or entire content hash must not define ownership. Duplicate
logical IDs in live objects are a conflict. Server generation prevents a delayed
old runner from updating a new server at the same socket and reused pane ID.

### Lock the full operation, and recover rather than replay

tmux `wait-for -L` stores a channel's locked boolean and queued waiters, without
an owning client for an acquired lock. Explicit unlock is required; it is not a
process-death-safe CLI mutex. [3.5a lock implementation](https://github.com/tmux/tmux/blob/3.5a/cmd-wait-for.c).

Use a Linux advisory lock keyed by canonical absolute socket path, shared across
all manifests and all mutating commands. Hold it across snapshot, planning,
creation, ownership initialization, release, and verification. `flock --no-fork`
can exec the actual CLI while retaining the lock; closing the descriptor releases
it. Do not unlink the lock file while another process might hold its inode, and
do not let background children inherit the descriptor. If a helper holds the
lock while another process performs mutations, unexpected helper death must
also stop the mutator: otherwise the lock can disappear during an operation.
Use a private local runtime directory rather than a network filesystem.
[util-linux flock documentation](https://github.com/util-linux/util-linux/blob/master/sys-utils/flock.1.adoc).

The implementation selects another Linux mechanism: the CLI opens the lock file,
passes its descriptor as inherited FD 3 to `flock`, and keeps its own descriptor
open after the helper successfully exits. Linux associates the lock with that
shared open file description, so helper exit does not release it while the CLI
still holds the descriptor. This avoids a persistent helper and ties release to
the mutating CLI's descriptor lifetime. Canonicalize socket aliases before
hashing the lock identity; `resolve()` alone does not resolve ancestor symlinks.
[Linux flock descriptor semantics](https://man7.org/linux/man-pages/man2/flock.2.html).

**Proposed creation protocol:** launch only a trusted runner with opaque identity
and immutable startup specification. The runner initializes ownership and
`pending`, then waits for a release marker. The controller observes readiness
before release. Preserve a recognizable creation marker in initial launcher
metadata so a crash before the first ownership write cannot lead to blind
adoption or duplicate creation. An unrecognized collision fails safely.

The runner commits an attempt before spawning user code. A crash after commit
means execution may have happened. Report `unknown` if completion cannot be
established; default apply must never replay the attempt. This is deliberately
an at-most-once startup-attempt contract, not an exactly-once guarantee for
external effects. Pending live runners can finish initialization; exited,
ambiguous, changed, or unknown attempts require explicit reset. In particular,
a pending runner whose recorded startup specification differs from YAML must
not be released by an apply that merely reports the difference as deferred.

## Sticky shells and task status

Keep startup task state separate from pane liveness. After the configured command
returns, record its result and open an interactive shell in the same pane. A live
shell does not mean its startup task is running. `remain-on-exit` is useful for
retaining a failed runner but does not itself provide an interactive prompt.
Do not infer task status from `pane_current_command`.

The initial Node supervisor is a reasonable correctness-first choice: stable
child-process APIs, explicit task exit/error handling, and no experimental API
requirement. Its per-pane memory/process overhead must be measured before making
scale claims. A future fixed `/bin/sh` wrapper reached through `process.execve`
can remove permanent Node overhead; Node 24 documentation still labels that API
experimental. It preserves only stdio and runs no cleanup callbacks.
[Node 24 process documentation](https://nodejs.org/docs/latest-v24.x/api/process.html#processexecvefile-args-env).

A task run in a child shell cannot export environment or change directory in the
subsequent interactive shell. Document this boundary. A shell-compatible result
such as 137 does not distinguish explicit `exit 137` from signal termination.
Ctrl-C behavior needs a real PTY check; an ignored INT trap can inadvertently make
children ignore interruption too.

## systemd lifecycle

Do not imply that a successful detached `apply` is a continuously supervised
service. `Type=oneshot` with `RemainAfterExit=yes` records successful application;
another `start` does nothing while active, whereas `ExecReload` can synchronously
reapply. Unit command arguments also have systemd's own specifier/environment
substitution rules and need separate encoding.
[Service semantics](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml).

A controller that happens to start tmux can place the server in its cgroup;
connecting to an existing server cannot. Avoid lifecycle behavior depending on
that accident. Prefer a dedicated foreground server unit and an apply unit if
full systemd management is included. tmux `-D` keeps the server foreground,
disables `exit-empty`, and accepts no command. Make stopping the server explicitly
destructive. Upstream discourages `KillMode=process` and `none` as ways to let
children escape unit lifecycle management.
[tmux invocation documentation](https://man.openbsd.org/tmux.1),
[systemd kill semantics](https://github.com/systemd/systemd/blob/main/man/systemd.kill.xml).

Prepare and validate the explicit socket's parent before the foreground server
starts. An installation-time `/tmp/tmux-<uid>` directory may be absent after boot;
an apply unit ordered after the server cannot create that directory soon enough.
Use a secure startup helper or a matching systemd runtime-directory design.

## MVP behavior and falsification tests

Default apply creates missing owned resources and completes safe pending work.
It preserves running panes, manual additions, and startup attempts already made.
Changed startup cwd/env/command/shell is reported as drift; it is not injected
into an existing shell. Layout convergence is safe only where the relevant
objects are owned and identified. Clear/reset must enumerate its exact owned
targets and reject ambiguous ownership or unrelated children before destruction.

The following checks are decision criteria, not claims of completed validation:

1. Apply twice: same tmux IDs; startup side-effect counter remains one. Rename
   and renumber live objects, then apply: match logical tags without duplication.
2. Add/remove/reorder YAML entries: add only missing IDs; preserve unspecified
   live panes by default. Changed command/env/cwd/shell reports drift.
3. Inject unrelated sessions, windows, panes, and same-name collisions: preserve
   them. Duplicate ownership tags and inherited-only tags cause conflicts.
4. Kill the CLI after create, before tag, after tag, before release, after release,
   and after attempt commit. Reapply never duplicates or repeats user effects;
   ambiguous attempts become unknown.
5. Run two applies, apply versus clear, and different manifests on the same socket
   concurrently. Verify serialized decisions, crash release, and bounded lock
   waits. A different socket must remain independent.
6. Test literal argument values `;`, `x;`, `x\\;`, spaces, quotes, tabs, newlines,
   Unicode, leading dashes, `$()`, and backticks. Test real names/paths/titles
   containing `#{pid}` and `#(touch SENTINEL)`; no incidental expansion or command
   execution is allowed. Reject NUL before process creation.
7. Task exits 0, 7, 127, and 137; command calls `exit`; executable/shell fails to
   start; task and runner receive signals. Record honest startup status, retain a
   usable shell where expected, and never label that shell as the startup task.
8. With a PTY, verify Ctrl-C, full-screen programs, interactive input, attach/
   detach, and shell startup files. No arbitrary sleep or prompt movement should
   be necessary to start user code reliably.
9. Restart the tmux server at the same socket while an old runner is delayed.
   Generation checks prevent writes into a reused pane ID.
10. Generate systemd units using paths containing spaces, `%`, `$`, quotes, and
    backslashes. Verify with `systemd-analyze verify`; exercise start/reload/stop
    both with and without an existing server.
11. Check non-mutating plan/status with absent tmux server: they do not create it.
    Explicit socket selection remains effective inside an unrelated tmux client.
12. Measure 1, 10, and 50 idle panes: startup time, apply subprocess count, and RSS.
    Report measurements and environment before setting a workload budget.

Research validation included reading upstream implementations, inspecting the
three retained source checkouts at the revisions above, and checking the local
tmux version. A small isolated-socket probe unexpectedly lost its server
immediately after creation and therefore did not establish runtime behavior; its
temporary server was cleaned up. The integration suite must resolve that local
environment issue and prove the composition above. No package was published.

Two isolated Python-PTY/Node-supervisor mechanism probes subsequently passed:
Bash accepted commands in two successive child-shell cycles after `exit`, and
Ctrl-C terminated a foreground startup child with `signal: SIGINT` while the
supervisor survived to open an interactive shell. Ctrl-C then interrupted a
`sleep` job inside that shell, which accepted a subsequent command. These probes
used Bash without startup files and do not replace integration checks of the
actual runner, tmux, arbitrary configured shells, or user shell configuration.
