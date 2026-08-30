# Releasing

Two things ship independently, and the order matters: **the mod first, the CLI second.** The CLI
resolves a bridge build for the consumer's Minecraft version at launch, so a CLI release whose
version map names a line that has never been published is a release that cannot drive it.

## What the CI already does

| Trigger | What runs |
|---|---|
| every push and pull request | `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, on Node 20 and 22 |
| a tag matching `v*` | the above, then `npm publish --provenance --access public` |

`npm test` includes the recorded-transcript replay, which checks this CLI against every supported
ClientDevBridge branch without booting Minecraft. A release that breaks one branch fails there.

## One-time setup

1. The npm organisation **`cyclopsmc` must exist** and the publishing account must be a member of
   it. The package is scoped (`@cyclopsmc/clientdevbridge-cli`) and published with
   `--access public`, which a scoped package needs or npm defaults it to private.
2. Add a repository secret **`NPM_TOKEN`**: an npm *automation* token with publish rights on that
   scope. Classic granular tokens work; a token restricted to other packages does not.
3. Nothing else. `--provenance` uses the workflow's OIDC identity, which the workflow already
   requests via `id-token: write`.

## Cutting a release

```bash
npm version <patch|minor|major>     # bumps package.json and creates the v<x.y.z> commit and tag
# write the release into CHANGELOG.md, amend it into the version commit
git push && git push --tags
```

Watch the `Publish to npm` job. On success:

```bash
npm view @cyclopsmc/clientdevbridge-cli version
npx @cyclopsmc/clientdevbridge-cli --version
```

## Before tagging, by hand

The CI covers everything except the packaged artifact itself, which is worth one minute:

```bash
npm pack --pack-destination /tmp
cd /tmp && npm init -y && npm install ./cyclopsmc-clientdevbridge-cli-<version>.tgz
./node_modules/.bin/clientdevbridge --version
./node_modules/.bin/clientdevbridge doctor --project <a mod checkout> --no-network
```

This catches a `files` entry or a runtime dependency listed under `devDependencies`, neither of
which any test in the repo would notice: the tests import from `src`, not from what ships.

## Versioning

The CLI's version is its own. It is **not** tied to a Minecraft version or to the mod's version,
because one CLI release drives every supported branch — that is the whole design.

The only version-aware thing in this package is `src/artifacts.ts`, which maps a Minecraft version
to the branch that publishes builds for it. Adding a Minecraft line means editing that table,
recording its transcripts (`scripts/record-fixture.mjs`, one per loader), and releasing the CLI
*after* the mod branch's artifacts are on the Maven.

`PROTOCOL_VERSION` is separate again, and lives in the mod. It is deliberately hard to change: see
`docs/PROTOCOL.md` in the mod repository.
