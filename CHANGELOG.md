# Changelog
All notable changes to this project will be documented in this file.

<a name="Unreleased"></a>
## Unreleased

### Added
* `registry <blocks|items|namespaces> [namespace]`, listing what the loaded mods registered. The
  first question about an unfamiliar mod, and it previously needed unzipping the jar. `--filter` and
  `--limit` keep the answer small — one mod alone has 53 blocks and 90 items.
* `break <x> <y> <z>`, which mines a block the way a player does — holding attack until it gives
  way — and reports how many ticks it took and what dropped, with each drop's position, since a drop
  is thrown rather than placed and lands a block or two away.
* `walk-to <x> <z>`, for when the movement is the point rather than the destination. Doing it by
  hand meant resetting the pitch (walking forward while looking down walks into the ground) and then
  guessing a tick count.
* `hold-key` takes `ATTACK`, `USE`, `PICK` and `MOUSE_LEFT`/`MOUSE_RIGHT`/`MOUSE_MIDDLE`. Attack is
  bound to a mouse button, so holding it was impossible to express — and holding it is mining, as
  holding use is eating, drinking, drawing a bow and raising a shield.
* `use-item [--hand auto|main|off] [--wait-screen]`, and `open-gui` with no coordinates as the same
  thing. Every other use command took a block position, so a mod whose entry point is an item had no
  command at all. A right-click aimed at a block interacts with the block and never reaches the
  item, so the reply says what it was aimed at and warns when something took the click first.
* `slot-click <slot> [--type quick_move|pickup|swap|clone|throw|quick_craft|pickup_all]`, and
  `--shift` on `click`. A screen works out that a click was a shift-click from the real keyboard
  state, which synthetic input cannot reach, so the operation is named rather than inferred. The
  index is the one `snapshot --json` already reports; `--at` resolves a point to the slot under it.
* `batch <file|->`, running many commands over a single connection. Every command otherwise opens a
  socket, does one thing and closes it, which costs more than the work when a script issues fifty in
  a row. It stops at the first failure with its line number; `--continue-on-error` runs the rest and
  `--json` prints one result object per command.
* `set-text <widget> <value> [--commit enter|tab|none]`, replacing a text field's contents in one
  command instead of click, N backspaces, type, commit. The count comes from the snapshot rather
  than a guess, and the value is read back afterwards.
* `screenshot --diff <image.png> [--min-diff <pct>]`, the assertion `compare` cannot make: that
  something on screen *did* change. Exits non-zero when the two captures are too similar.
* `hotswap --restart-if-needed`, which restarts when a change cannot be redefined in place, with
  the options the running client was launched with. Whether an edit is swappable is a HotSpot rule,
  and a caller who wants their change live should not have to know it.
* `use`, a right-click with the held item, for everything that leaves no screen behind: placing a
  block or a cable part, tools, wrenching with `--sneak`.
* `--face` and `--at` on `use`, `open-gui` and `inspect-gui`, which say where on a block to aim.
  Multipart blocks — Integrated Dynamics' cables and anything else on CyclopsCore — decide what was
  clicked by casting a ray from the player's eye, so without a side there was no way to reach a
  part's GUI at all.
* `block` prints whatever a mod's `BlockExtractors` registration says distinguishes one instance of
  its block entity from another.

### Changed
* `--json` is compact unless stdout is a terminal. Indentation was 42% of every payload and carries
  no information; a person at a terminal is the one reader it helps, and `isTTY` is exactly that
  reader.
* `--json` omits empty container and inventory slots, reporting `slotCount` instead. A container is
  mostly empty and each empty slot cost about eighty bytes to say so: a chest screen holding one
  item went from 9,813 bytes to 792, a 92% cut, with the slot grid still derivable from the filled
  slots and the total. `--include-empty` restores every rectangle.
  **Look slots up by their `index` field, not by position in the array** — it is no longer dense.

### Fixed
* `eval` and `wait --expr` work on Minecraft 26. The init script pinned Groovy 4.0.22, which cannot
  read Java 25 class files, so both failed there with `Unsupported class file major version 69` —
  on every 26 client, for the whole life of those branches. Groovy 5.1.1 handles them, and is fine
  on 1.21 too.
* An in-world `click` no longer reports `screen: none` at the moment it opened one. The click queues
  a key binding that the game processes on the next tick, and the reply now waits for it.
* `inventory` and `snapshot` describe what a container item holds, instead of printing the component
  through a `toString` that is a class name and an identity hash.
* `teleport` no longer prints a position the player is about to leave. The mod now waits for them to
  land rather than merely arrive, and warns when nothing is holding them up.

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
