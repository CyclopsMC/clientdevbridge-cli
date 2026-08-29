# clientdevbridge-cli

Launch and drive a Minecraft **dev client** from the shell — for coding agents.

Everything is a bash command, so this works identically in a local terminal, in Claude Code on the
web, and in CI. There is no MCP server and nothing to configure.

```bash
npm install -g @cyclopsmc/clientdevbridge-cli    # or use npx

cd path/to/your/mod
clientdevbridge doctor        # is this machine able to build and launch a client?
clientdevbridge start         # boots the dev client, headless if there is no $DISPLAY
clientdevbridge status        # what is it showing right now?
clientdevbridge screenshot    # prints a PNG path — open it with your agent's file-reading tool
clientdevbridge stop
```

You do **not** need to modify your mod project. `start` generates
`.clientdevbridge/init.gradle` and passes it to `./gradlew runClient`, which injects the matching
[ClientDevBridge](https://github.com/CyclopsMC/ClientDevBridge) mod build and pins the settings that
make screenshots reproducible.

## Output conventions

These exist so an agent reading stdout can act on it without guessing:

- **Images are never printed.** `screenshot` writes a file and prints its absolute path on its own
  line. Open that path with your file-reading tool.
- Default output is readable text. `--json` prints the raw protocol result instead.
- Exit codes: `0` success, `1` a protocol-level failure (bad arguments, a method that refused),
  `2` a session or connection failure (nothing running, port taken, client gone).

## Session state

A session lives in `<project>/.clientdevbridge/`:

```
session.json     port, pid, loader, Minecraft version, when it started
gradle.log       the client's stdout and stderr
screenshots/     PNG output
golden/          committed golden images — this one is meant to be checked in
init.gradle      regenerated on every start
```

`start` detaches the client into its own process group, so it outlives the CLI invocation that
created it; `stop` kills the whole group. Every command detects a stale `session.json` — a
reclaimed cloud VM, a crash, a reboot — and says "not running" cleanly instead of hanging.

## Headless

On Linux with no `$DISPLAY`, `start` wraps the launch in `xvfb-run` and forces Mesa's llvmpipe
software rasteriser. This is a **real client on a virtual display**, not a client that skips
rendering, so screenshots show exactly what a player would see. Everywhere else, and with
`--headed`, a normal window opens. Nothing else about the CLI's behaviour differs.

```bash
sudo apt-get install -y xvfb libgl1-mesa-dri
```

`clientdevbridge doctor` checks for all of this and prints the exact command to fix whatever is
missing.

## Minecraft versions

This package is **version-agnostic and single-branch**. The wire protocol is identical on every
ClientDevBridge branch, so one CLI release drives every supported Minecraft version. The only
version knowledge it holds is which branch publishes builds for which Minecraft version, in
`src/artifacts.ts` — today the 1.21, 26 LTS and 26 lines. That file is the authority rather than
this paragraph, and `clientdevbridge doctor` prints which branch it picked for the project in
front of you, so neither has to be trusted from memory.

## Development

```bash
npm install
npm test           # unit tests and recorded-transcript replay; no Minecraft needed
npm run build
npm run lint
```

`scripts/record-fixture.mjs` records a handshake and transcript from a running client into
`test/fixtures/transcripts/`, which is how a CLI release is verified against every branch without
booting the game.
