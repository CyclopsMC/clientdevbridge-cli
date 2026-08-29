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
- `snapshot`, `find`, `click`, `type`, `key`, `hold-key`, `mouse-move`, `scroll`, `drag`, `tooltip`,
  `open-gui`, `close-screen` and the `inspect-gui` composite.
- `world-reset`, `world-load`, `world-leave`, `world-list`, `command`, `block`, `setblock`, `give`,
  `teleport`, `look`, `inventory`, `eval`, `wait`.
- `resize` and `compare`, with golden images kept per renderer so software rasterisation and a real
  GPU can each be compared strictly.
- `hotswap`, redefining changed classes in the running client over JDWP.
- Compatibility tests that replay recorded protocol transcripts from every supported branch,
  so a release is verified against all of them without booting Minecraft.
