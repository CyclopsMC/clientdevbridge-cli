# Releasing

Two things ship independently, and the order matters: **the mod first, the CLI second.** The CLI
resolves a bridge build for the consumer's Minecraft version at launch, so a CLI release whose
version map names a line that has never been published is a release that cannot drive it.

## What the CI already does

| Trigger | What runs |
|---|---|
| every push and pull request | `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, on Node 20 and 22 |

Publishing is deliberately **not** automated: it is done by hand, from a checkout, by someone who
has just watched those checks pass.

`npm test` includes the recorded-transcript replay, which checks this CLI against every supported
ClientDevBridge branch without booting Minecraft. A release that breaks one branch fails there.

## One-time setup

`npm login` as an account that may publish `cyclops-clientdevbridge-cli`. That is all: the package
name is unscoped, so it is public by default and needs no npm organisation and no `--access` flag.

## Cutting a release

`CHANGELOG.md` is maintained with [manual-git-changelog](https://www.npmjs.com/package/manual-git-changelog),
hooked into npm's `version` lifecycle:

```json
"version": "manual-git-changelog onversion"
```

So `npm version` writes the new section itself, from the commits since the last `v*` tag, and then
**pauses** with:

```
Manually edit CHANGELOG.md, press any key to finalize...
```

That pause is the point of the tool: open `CHANGELOG.md` in another window, replace the generated
`### TODO: categorize commits...` heading with the ones that apply (`Added`, `Changed`,
`Deprecated`, `Removed`, `Fixed`, `Security`), drop the commits nobody outside this repository
cares about, then press a key. The tool stages the file so it lands in the version commit.

```bash
npm version <patch|minor|major>     # bumps package.json, writes CHANGELOG.md, commits, tags v<x.y.z>
git push && git push --tags
```

(`onversion` needs a previous `v*` tag to compare against. The first release had none, so
`CHANGELOG.md` was seeded with `manual-git-changelog init` instead; every release since has a tag
behind it, so this no longer comes up.)

Then publish, from a clean checkout of the tag:

```bash
git status --porcelain     # must be empty; npm packs the working tree, not the commit
npm publish                # prepublishOnly rebuilds dist/, which is not in git
```

Afterwards:

```bash
npm view cyclops-clientdevbridge-cli version
npx cyclops-clientdevbridge-cli --version
```

## Before tagging, by hand

The CI covers everything except the packaged artifact itself, which is worth one minute:

```bash
npm pack --pack-destination /tmp
cd /tmp && npm init -y && npm install ./cyclops-clientdevbridge-cli-<version>.tgz
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
