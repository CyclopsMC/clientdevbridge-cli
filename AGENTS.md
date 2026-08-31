# AGENTS.md — developer and AI agent guide

This is the CLI half of a pair. The other is
[`CyclopsMC/ClientDevBridge`](https://github.com/CyclopsMC/ClientDevBridge), the Minecraft mod this
talks to over a loopback WebSocket. Read that repository's `AGENTS.md` before changing anything
protocol-shaped; it is the longer guide and this one does not repeat it.

## Where to put a change

| Repository | Holds | Branching |
|---|---|---|
| `CyclopsMC/clientdevbridge-cli` (this one) | the CLI people run, and the recorded protocol fixtures | a single `master` |
| `CyclopsMC/ClientDevBridge` | the mod: transport, protocol, handlers, all version-sensitive code | one branch per Minecraft line, upmerged oldest → newest |

**This repository has no version branches and nothing to upmerge.** One release drives every
supported Minecraft version, because the wire protocol is identical on every mod branch. The only
version knowledge here is `src/artifacts.ts`, mapping a Minecraft version to the mod branch that
publishes builds for it.

A protocol change lands **mod-side first** — on the mod's oldest affected branch, then upmerged
along `master-1.21-lts` → `master-26-lts` → `master-26` — and only then does the CLI subcommand
follow. The other order ships a CLI that talks to builds nobody can resolve yet. Contributors
without push access to the mod repository target `master-1.21-lts` there and let the maintainer
upmerge.

## Building and testing

```bash
npm install
npm test        # unit tests plus the recorded-transcript replay; no Minecraft needed
npm run lint
npm run typecheck
npm run build
```

The transcript replay is how a release is verified against **every** mod branch without booting the
game: `test/fixtures/transcripts/` holds a real handshake and exchange recorded per branch and
loader. Add a method and you must re-record them, against a running client, with
`node scripts/record-fixture.mjs <name>` — a fixture written by hand asserts what you believed, not
what the mod does.

The tests import from `src/`, not from what ships, so they cannot catch a missing `files` entry or
a runtime dependency listed under `devDependencies`. `RELEASING.md` has the one-minute pack-and-run
check that does.

## Things worth knowing before you change them

- **Output is for an agent to read.** Screenshots are written to files and their paths printed;
  base64 never goes to stdout. Every command is readable without `--json`.
- **Exit codes are load-bearing.** A failing in-game command exits non-zero — `setblock ... &&
  inspect-gui ...` must not proceed against a scene that was never built. `0` success, `1` a
  protocol failure, `2` a session or connection failure, `3` not ready yet (a build still running).
  **A pipe destroys this**: `$?` after `clientdevbridge ... | head` is `head`'s status, so a failed
  command reads as a successful one. Three separate agents have now misread an exit code this way.
  Use `${PIPESTATUS[0]}`, or capture the output first and filter it afterwards.
- **Error messages have to say what to do next.** An agent cannot ask a follow-up question.
- **The CLI writes `.clientdevbridge/` and one block in the consumer's `.gitignore`, and nothing
  else.** The `.gitignore` block keeps session state out of commits while leaving `golden/` in, is
  announced when written, and is skipped by `start --no-gitignore`. Any other write to a consumer's
  repository is a bug. (This rule used to say the CLI never touches the repository at all, which
  stopped being true when `--no-gitignore` shipped — an agent then had to explain a dirty
  `git status` against a promise that it could not happen.)

## Releasing

Publishing is manual and not in CI. See [`RELEASING.md`](RELEASING.md).
