# Release a package manually

The package is prepared as `@rezics/termspaces` with command `termspaces`.
The npm scope must be owned or publishable by the maintainer; absence from the
registry does not establish account permission. npm publication is manual.

From the repository root, install the locked development dependencies once:

```sh
task install
```

Then publish directly, with npm credentials and any required verification:

```sh
npm publish
```

`publishConfig.access` already selects public access. The `prepublishOnly` hook
runs `task release:check` (types, tests and documentation links). The `prepack`
hook runs `task build`, so missing or stale compiled output is rebuilt before
packaging. Both hooks use npm's [standard publishing lifecycle](https://docs.npmjs.com/cli/v11/using-npm/scripts/#npm-publish).

Use `task publish:dry-run` to exercise that same path without uploading. Use
`task package:smoke` to pack and install into an isolated prefix, then exercise
the shipped CLI. Tarballs are retained in `.temp/` as optional release artifacts;
publishing one explicitly is also supported.

The package contains compiled JavaScript and declarations, the tmux preset,
JSON Schema, Agent Skill, linked documentation, README and license. It excludes
reference clones, test data and source checkouts.

After publication, tag the released commit. No CI workflow in this repository
publishes to npm.
