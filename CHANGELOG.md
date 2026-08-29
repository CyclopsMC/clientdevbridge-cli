# Changelog

## Unreleased

- `start`, `stop`, `status`, `restart`: session lifecycle with detached process groups, stale-session
  detection, and Xvfb handling.
- `screenshot`: writes a PNG and prints its path; never emits base64 to stdout.
- `logs`: the in-game log via `log.tail`, or `gradle.log` with `--gradle`.
- `wait`: wait for game ticks.
- `doctor`: checks Java, the Gradle wrapper, Xvfb, Mesa, the network allowlist, and whether a
  ClientDevBridge build exists for the project's Minecraft version.
- Gradle init-script injection, so consumer repositories need no edits.
