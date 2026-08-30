# Changelog
All notable changes to this project will be documented in this file.

<a name="Unreleased"></a>
## Unreleased

### Added
* `use`, a right-click with the held item, for everything that leaves no screen behind: placing a
  block or a cable part, tools, wrenching with `--sneak`.
* `--face` and `--at` on `use`, `open-gui` and `inspect-gui`, which say where on a block to aim.
  Multipart blocks — Integrated Dynamics' cables and anything else on CyclopsCore — decide what was
  clicked by casting a ray from the player's eye, so without a side there was no way to reach a
  part's GUI at all.
* `block` prints whatever a mod's `BlockExtractors` registration says distinguishes one instance of
  its block entity from another.

<a name="v0.1.0"></a>
## [v0.1.0] - 2026-08-30

First release. Everything below arrived together, so the entries name the feature rather than the
commit that happened to carry it.

### Added
* [Session lifecycle](https://github.com/CyclopsMC/clientdevbridge-cli/commit/458d17823ea1ee2905a0ce1d34acf89a6096986e):
  `start`, `stop`, `status` and `restart`, with detached process groups, stale-session detection,
  and Xvfb started and reaped around the client.
* [Gradle init-script injection](https://github.com/CyclopsMC/clientdevbridge-cli/commit/458d17823ea1ee2905a0ce1d34acf89a6096986e),
  so a consumer repository needs no edits to be driven.
* [`screenshot`](https://github.com/CyclopsMC/clientdevbridge-cli/commit/458d17823ea1ee2905a0ce1d34acf89a6096986e),
  which writes a PNG and prints its path; it never emits base64 to stdout.
* [`logs`](https://github.com/CyclopsMC/clientdevbridge-cli/commit/458d17823ea1ee2905a0ce1d34acf89a6096986e):
  the in-game log, or `gradle.log` with `--gradle`.
* [`doctor`](https://github.com/CyclopsMC/clientdevbridge-cli/commit/458d17823ea1ee2905a0ce1d34acf89a6096986e),
  which checks Java, the Gradle wrapper, Xvfb, Mesa, the network allowlist, and whether a
  ClientDevBridge build exists for the project's Minecraft version.
* [Screen inspection and input](https://github.com/CyclopsMC/clientdevbridge-cli/commit/d8f5252618c256f0dbfe0181dba396f866cb5ff6):
  `snapshot`, `find`, `click`, `type`, `key`, `hold-key`, `mouse-move`, `scroll`, `drag`, `tooltip`,
  `open-gui`, `close-screen`, and the `inspect-gui` composite.
* [World and player control](https://github.com/CyclopsMC/clientdevbridge-cli/commit/d8f5252618c256f0dbfe0181dba396f866cb5ff6):
  `world-reset`, `world-load`, `world-leave`, `world-list`, `command`, `block`, `setblock`, `give`,
  `teleport`, `look`, `inventory`, `eval` and `wait`.
* [`resize` and `compare`](https://github.com/CyclopsMC/clientdevbridge-cli/commit/d8f5252618c256f0dbfe0181dba396f866cb5ff6),
  with golden images kept per renderer so software rasterisation and a real GPU can each be
  compared strictly.
* [`hotswap`](https://github.com/CyclopsMC/clientdevbridge-cli/commit/d8f5252618c256f0dbfe0181dba396f866cb5ff6),
  redefining changed classes in a running client over JDWP.
* [Compatibility tests](https://github.com/CyclopsMC/clientdevbridge-cli/commit/d8f5252618c256f0dbfe0181dba396f866cb5ff6)
  that replay recorded protocol transcripts from every supported mod branch, so a release is
  verified against all of them without booting Minecraft.
* [Minecraft 26 support](https://github.com/CyclopsMC/clientdevbridge-cli/commit/4d171c2f72d62a3e1c0cfc8034b9bc455b717e4a),
  including running Gradle on a JDK the project accepts rather than whatever `java` is on `PATH`.
* [Anonymous artifact resolution](https://github.com/CyclopsMC/clientdevbridge-cli/commit/b8e24514c62e9d3264265f9d340fb9d8f839954e):
  the mod is resolved from the static GitHub Pages Maven, so no credentials are needed to launch a
  client.
