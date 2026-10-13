# termspaces

Editable tmux workspaces that survive SSH disconnects. Define sessions, windows
and panes in YAML, then apply changes without restarting existing tasks.

termspaces is a Linux-first CLI for people and coding agents. It uses a private
tmux server and preserves the normal terminal interface. It does not require a
separate controller daemon; sticky panes have a small Node.js supervisor process.

## Install

Requires **Node.js 24+**, **tmux 3.3+**, and **flock** from util-linux on the remote
Linux host. Windows users connect through SSH, or run the CLI inside WSL.

The npm package is prepared for publication but **has not been published yet**.
After publication:

```sh
npm install --global @rezics/termspaces
termspaces doctor
termspaces init
termspaces validate
termspaces plan
termspaces apply
termspaces attach default
```

Before publication, build from source and run `node dist/cli.js` in place of
`termspaces`. See [development](docs/development/toolchain.md).

## Define a workspace

Default configuration: `$XDG_CONFIG_HOME/termspaces/workspaces/*.yaml`, falling
back to `~/.config/termspaces/workspaces/*.yaml`. One file defines one session.
Use `--config` to select another directory or a single YAML file.

```yaml
version: 1
session:
  id: project
  name: Project
  cwd: ~/projects/my-project
  autostart: true
  profile: minimal

windows:
  - id: agents
    name: Agents
    layout: even-horizontal
    panes:
      - id: main
      - id: review

  - id: development
    name: Development
    startup:
      mode: on-create
      argv: [task, dev]
    panes:
      - id: server

  - id: tests
    panes:
      - id: shell
```

IDs are stable identities, scoped to their parent; names are display labels.
Session directories are relative to the YAML file. Window directories inherit
the session directory; pane directories inherit the window directory. Only `~`
and `~/` expand; environment variables and shell expressions do not.

Startup defaults to `manual`, opening an interactive login shell. `on-create`
executes an argv array once for that pane's creation. Commands are not sent as
keystrokes. For intentional shell syntax, explicitly use an argv such as
`[/bin/sh, -c, "build && test"]`.

Put `startup` on a window to run its command in the **first pane after all
declared panes and the initial layout are ready**. It runs only when that window
is created. Recreating a missing first pane in an existing window does not rerun
the window command; its status is `skipped`. Alternatively, put `startup` on
individual panes for per-pane creation commands. A window startup and an explicit
first-pane startup cannot be combined. `reset` creates new windows and therefore
runs their creation commands again.

`sticky` defaults to `true`: after a startup task finishes, an interactive shell
opens; exiting that shell opens another. Startup tasks never automatically run
again. Set `sticky: false` to keep a finished task as an exited pane. Set `shell`
to an absolute executable path to override the account's login shell. Fresh
shells do not retain a previous shell's variables or working-directory changes.

The [generated JSON Schema](schema/workspace.schema.json) also ships in the npm
package; `termspaces schema` prints it without needing a tmux server.

## Apply semantics

| Change | Behavior |
| --- | --- |
| Add a session/window/pane | Create the missing resource |
| Apply again | Keep existing resources and startup attempts |
| Change a display name or profile | Update in place |
| Change an existing startup command, cwd, shell or sticky option | Report deferred drift; keep the running pane |
| Remove a definition | Keep the runtime resource and report it |
| Change the declared layout | Report drift; use `layout` explicitly |
| Resize panes manually | Preserve the layout on ordinary apply |

Adding a pane necessarily changes available screen space. Initial window layouts
are applied at creation. Manually added, unowned resources are never adopted;
name conflicts block apply. Clearing a session containing unmanaged descendants
is refused so it cannot terminate those resources indirectly.

Every mutation holds one kernel-backed file lock per canonical socket path.
Configuration is reread after acquiring the lock. A failure retains completed
resources and reports partial progress; rerun `plan` before retrying.

If a controller stops before a tagged launcher is released, the next apply can
finish that pending launch only when its initial spec still matches. A launcher
failure before ownership tagging is reported as an uninitialized-resource
conflict. Inspect that exact resource with tmux and remove it deliberately before
retrying; it is never automatically adopted or duplicated. A dead committed
attempt without a recorded exit result is `unknown`, and is never replayed.

These guarantees cover cooperating termspaces processes. Arbitrary direct tmux
commands can still change or destroy resources concurrently.

## Commands

Global options: `--config <file-or-directory>`, `--socket <name>`, `--json`.
The default socket name is `termspaces`; the ordinary tmux `default` socket is
refused. `--socket-path` is available for explicit service integration.

```sh
termspaces validate
termspaces plan --json
termspaces apply --json
termspaces list
termspaces status project
termspaces windows project
termspaces panes project/agents
termspaces capture project/agents/main --lines 100
termspaces attach project
termspaces attach project --takeover
termspaces layout project/agents
termspaces clear project
termspaces reset project
```

`clear` terminates the selected session; `reset` recreates it from valid
configuration. Interactive use requires typing the session ID. Noninteractive
use requires explicit `--yes`. Neither command kills the whole tmux server.

`attach` switches clients already inside this server. A client inside a different
tmux server must detach first. `--takeover` explicitly detaches other clients when
attaching from outside tmux; normal attach allows shared clients.

Human output is readable structured text. JSON mode writes one envelope to
stdout and diagnostics to stderr:

```json
{"protocolVersion":1,"ok":true,"data":{"operations":[],"deferred":[],"conflicts":[]}}
```

Errors include a stable `error.code` and message. Exit codes: `0` success, `2`
invalid input or missing destructive confirmation, `3` conflict, `1` other
failure. A conflicting `plan` returns its structured plan with exit code `3`.
`capture` labels its text untrusted; output is neither instructions nor proof of
task completion. Startup exit status and shell exit status are reported separately.

## Terminal shortcuts

Prefix is **Ctrl+B**, followed by the second key. Use Ctrl+B twice to send it
through. `minimal` shows a simple status bar; `immersive` hides it.

| Shortcut | Action |
| --- | --- |
| Ctrl+B, s | Session selector |
| Ctrl+B, w | Window/session tree |
| Ctrl+B, c | New manual window |
| Ctrl+B, \| / - | Split left/right or top/bottom |
| Ctrl+B, h/j/k/l | Move between panes |
| Ctrl+B, z | Toggle pane zoom |
| Ctrl+B, B | Toggle this session's status bar |
| Ctrl+B, d | Detach, preserving tasks |
| Ctrl+B, X | Confirm destruction of the current session |

Manual windows/panes created through tmux shortcuts are unmanaged. Add their
definitions and let apply create managed resources if you want declarative
ownership; explicit adoption is reserved for a future release.

Mouse mode and tmux history are enabled. Clipboard integration uses tmux's OSC
52 support and depends on the local terminal. Test copying and scrolling with
your actual SSH client; the tool cannot promise identical behavior in every
terminal emulator.

## Start at boot

First edit `autostart: true` in the workspaces to initialize at boot:

```sh
termspaces autostart install --enable
loginctl enable-linger "$USER"
```

Installation writes generated user units and enables them for a subsequent user
manager startup. It does **not** start, stop or migrate existing sessions. Linger
allows the user manager to run without an SSH login; host policy may require an
administrator to enable it.

On a fresh socket, start the initialized service explicitly:

```sh
systemctl --user start termspaces-apply-termspaces.service
```

The apply unit requires a separate foreground tmux server unit. If manual apply
has already started the same socket, schedule a deliberate clear/migration before
starting that server service; service installation does not take ownership of the
running server. Choose another `--socket` to test the service independently.

For daily changes, use `termspaces apply`. Restarting the **apply unit** preserves
the server and panes. Stopping or restarting the **server unit** terminates its
workspaces. After updating the global npm installation, rerun `autostart install
--enable` to refresh recorded Node/package paths.

To remove autostart for the default socket, disable the apply unit, then disable
the server unit for future boots. Add `--now` to the server operation only when
you intend to terminate its running workspaces. Remove the two generated files
from `~/.config/systemd/user/` and run `systemctl --user daemon-reload`.

SSH disconnects preserve running processes. A server reboot creates new
workspaces; it cannot restore old process memory or shell state.

## Agents and development

The shipped [Agent Skill](skills/termspaces/SKILL.md) describes safe management
through the same CLI. No MCP integration is required.

See [source research and design tradeoffs](docs/research.md),
[toolchain and checks](docs/development/toolchain.md), and
[manual publication](docs/releasing.md).
