# Changelog
All notable changes to this project will be documented in this file.

<a name="Unreleased"></a>
## Unreleased

### Added
* `entity [selector] [path]` reads an entity's NBT — `block --nbt` for things that are not blocks.
  Abilities, attributes and capability data live on the server entity, which the client's copy does
  not carry, so it goes through the same command source `/data get` uses. Pass a path: a player's
  full NBT is tens of kilobytes.
* `screenshot --mouse x,y` and `compare --mouse x,y` park the cursor before capturing. The cursor is
  the one piece of render state `options.txt` cannot pin, and every input command moves it — a GUI
  that points a player model at the pointer made two captures differ for reasons unrelated to what
  was being tested.
* Exit code `3`, "not ready yet", distinct from `2` "something failed".

### Fixed
* **`start` no longer calls a slow first build a failure.** On a machine with no toolchain cache the
  first boot takes 15–20 minutes; the 300 s default expired while the build was healthy and still
  progressing, and the message ("the client did not answer", "increase `--timeout`") described a
  death that had not happened. `start` now checks whether Gradle is alive and whether the log grew
  during the wait; if both, it says the build is still running, names the task, points at `status`
  and exits `3`. It also allows 25 minutes automatically when no NeoForm or Loom cache exists, which
  costs nothing when the client comes up sooner.
* `doctor` reports a cold cache as **warn**, not `ok`, and says what it implies: the first `start`
  will take 15–20 minutes. It was the best predictor of that wait, filed beside things that were
  genuinely fine.
* `inventory --json` and `snapshot --json` serialise item components through their registered codecs,
  the way `/data get` does. A mod's own data component rendered as `Object.toString` — a class name
  and an identity hash — so verifying that a mod changed an item meant falling back to
  `command "data get entity @p"` and grepping.
* **A timed-out `wait --expr` now says what the expression did** — how many times it ran, what it
  last answered, and that it was well-formed, since an expression that throws or answers a
  non-boolean fails immediately instead. It used to print the screen and the world state, which
  describe nothing an expression asked about, so a false expression, a throwing one and an unbound
  name were indistinguishable. Comparing `dev.prop` against a quoted string — false forever, because
  `dev.prop` answers the property's own typed value — is now named as the likely cause.
* The "matches N widgets" error suggested `--widget`, which `set-text` does not have; it takes the
  widget positionally. The hint no longer names a flag.

### Documentation
* The README says the `eval` language is **Groovy**. It never did, and its examples are valid in
  both Groovy and JavaScript, so nothing disambiguated them.
* Every `dev.*` helper's return type is documented, with the `dev.prop` comparison trap spelled out.
* The `set-text` examples are real output from a real screen. The old one used a label from the
  Integrated Dynamics aspect-settings screen that cannot resolve — the phrase is that window's
  title, and the box has no label — which sent readers hunting a bug that was not there. The
  mod-drawn case now points at the pixel fallback where it is described.
* `start` writing to the project's `.gitignore`, and `--no-gitignore`, are documented under Session
  state. The flag shipped in 0.3.0 and was mentioned nowhere.
* A warning that piping hides the exit code the README leans on as its contract.

<a name="v0.3.0"></a>
## [v0.3.0](https://github.com/CyclopsMC/clientdevbridge-cli/compare/v0.2.0...v0.3.0) - 2026-08-31

### Added
* `hold <slot>` selects a hotbar slot. Everything that places, uses or mines acts on the selected
  slot, and `give` fills the first free one — so the second item given was already unreachable, and
  holding a specific item meant hoping slot 0 was empty. `key HOTBAR_1`…`HOTBAR_9` reach the same
  bindings by name; a bare `key 1` cannot, because a digit parses as a raw key code first.
* `start --no-gitignore`, for a checkout that must stay pristine. The entry is still written by
  default, since a committed session directory is the more common harm.
* `screenshot --region` echoes the rectangle it captured, in GUI space and in pixels. A GUI-space
  region comes back as a pixel-sized image, so the size alone could not distinguish a crop that
  landed on the widget from one that missed it by a GUI scale factor.
* `block --json` includes the block entity NBT the README already promised it did. `--no-nbt` opts
  back out; the plain text form stays terse.

### Fixed
* `use` reports a block entity NBT change. A wrench turning a side, a variable card being written, a
  tank filling — none of those touch the block id or the block state, so the whole class of
  interactions that actually matter used to read as "no visible change to the block, the hand or the
  screen".
* `doctor` resolves dependencies against the module carrying the client task rather than the root. A
  multiloader root is an empty aggregator with no `compileClasspath`, so the new check failed on
  every Cyclops mod — a false alarm on exactly the layout this tool is built for. A project that
  genuinely declares no compile classpath is now reported as nothing to resolve, not as a failure.
* `teleport` no longer reports a normal landing as "the player fell or was pushed on the way". A
  target that is not already resting on a surface is settled onto one, which is the command working;
  crying wolf on that buried the case that matters, so a horizontal displacement — the target was
  inside something — is now said separately from a vertical settle.
* `break` reports what the player picked up during the drop settle, not only what is still lying on
  the ground. A drop becomes collectable ten ticks after it spawns and the settle is ten ticks, so
  mining within arm's reach routinely ended with the item in hand and `break` saying "nothing
  dropped".
* `close-screen` says which screen is in focus afterwards. A mod screen's `onClose` can put its
  parent back up, and reading back "closed" there sends a caller looking for a bug in the click they
  just made.
* **The bridge now works on single-module mod projects.** `detectGradleTask` answered a bare
  `runClient`, the launcher stripped the task with a pattern needing a leading colon, and the
  injection target became the literal string `runClient` — a path no Gradle project has, so the init
  script's guard returned early for every project and nothing was injected at all. The client booted
  as a plain dev client and never answered, with nothing naming the cause. Most mod repositories are
  single-module; both e2e fixtures are multiloader, which is why nothing caught it.
* The mod's system properties are also passed in `JAVA_TOOL_OPTIONS`, so they reach the client even
  when the run task is not a `JavaExec` the init script can configure — NeoGradle 7's userdev task is
  not, and there the mod loaded, logged "present but inert", and the CLI showed only a timeout.
* A `start` timeout now says which of the two silent failures happened: the mod present but not
  enabled, or never on the classpath at all.
* `doctor` resolves the project's compile classpath instead of only pinging hosts. Reachability is
  not usability — GitHub Packages answers an HTTPS HEAD from anyone and then refuses to serve without
  credentials — so "Everything checks out" used to be followed by six and a half minutes of Gradle
  and `Username must not be null!`. `--no-dependencies` skips it.

<a name="v0.2.0"></a>
## [v0.2.0](https://github.com/CyclopsMC/clientdevbridge-cli/compare/v0.1.1...v0.2.0) - 2026-08-31

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
