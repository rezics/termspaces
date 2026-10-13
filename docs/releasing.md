# Release a package manually

The package is prepared as `@rezics/termspaces` with command `termspaces`.
The npm scope must be owned or publishable by the maintainer; absence from the
registry does not establish account permission. npm publication is manual.

Before publishing:

```sh
task install
task check
task test
task docs:check
task pack
```

Inspect the tarball in `.temp/`. It should contain compiled JavaScript and
declarations, the tmux preset, JSON Schema, Agent Skill, README and license.
It must exclude reference clones, test data, credentials and source checkouts.
Install that tarball into a fresh prefix and check its `termspaces` command.

The maintainer then runs, with npm credentials and any required verification:

```sh
npm publish .temp/rezics-termspaces-0.1.0.tgz --access public
```

Publish the verified tarball so the uploaded bytes match the package that was
tested. After publication, update the README's availability note and tag the
released commit. No CI workflow in this repository publishes to npm.
