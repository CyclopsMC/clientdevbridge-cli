# clientdevbridge-cli

[![npm version](https://img.shields.io/npm/v/cyclops-clientdevbridge-cli.svg)](https://www.npmjs.com/package/cyclops-clientdevbridge-cli)
[![CI](https://github.com/CyclopsMC/clientdevbridge-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/CyclopsMC/clientdevbridge-cli/actions/workflows/ci.yml)

Launch and drive a Minecraft **dev client** from the shell — for coding agents.

Everything is a bash command, so this works identically in a local terminal, in Claude Code on the
web, and in CI. There is no MCP server and nothing to configure.

```bash
npm install -g cyclops-clientdevbridge-cli    # or use npx

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

## What it does

### It runs a real client, and screenshots show what a player would see

Not a stub renderer and not a headless simulation: an actual Minecraft client on a virtual display,
with software OpenGL. Every image below was produced by the commands beside it, on a machine with
no GPU and no `$DISPLAY`.

```bash
clientdevbridge world-reset
clientdevbridge setblock  0 4 2 minecraft:crafting_table
clientdevbridge setblock  2 4 2 minecraft:chest
clientdevbridge setblock -2 4 2 minecraft:furnace
clientdevbridge give minecraft:diamond 5
clientdevbridge teleport 0 5 6 --yaw 180 --pitch 20
clientdevbridge screenshot --name scene
```

![A rendered Minecraft scene: a furnace, a crafting table and a chest on a stone platform, with a diamond held in hand](https://raw.githubusercontent.com/CyclopsMC/clientdevbridge-cli/master/docs/images/scene.png)

### It reads a GUI structurally, not just visually

`inspect-gui` right-clicks a block, waits for the screen, prints the widget tree, and writes a
screenshot — one command for the thing you actually want.

```console
$ clientdevbridge inspect-gui 0 4 2
CraftingScreen  "Crafting"
gui 427x240 @ scale 2, window 854x480px, mouse at 213.5,120
container CraftingMenu at (125,37) 176x166, 46 slots (1 filled)
  slot 14 (empty) @(205,121) hovered
  slot 37 minecraft:diamond x5 @(133,179)
  ImageButton " button Left click to activate" @(130,71 20x18)  /root/children[0]
  RecipeBookComponent @(unknown)  /root/children[1]

/path/to/mod/.clientdevbridge/screenshots/inspect-gui_....png
```

![The crafting screen the outline above describes, with the diamond stack in the inventory and one slot highlighted](https://raw.githubusercontent.com/CyclopsMC/clientdevbridge-cli/master/docs/images/crafting-gui.png)

The two halves answer different questions, and **a bug is usually a disagreement between them**.
The outline says what the game thinks is there; the screenshot says what is drawn. Check them
against each other: the container is reported at GUI (125,37) 176x166, which is pixels
(250,74)–(602,406) at scale 2 — where the panel is. The diamonds are at (133,179), bottom-left of
the inventory grid. Slot 14 is marked hovered, and it is the visibly lightened one.

Coordinates are in GUI space and are what you send back:

```bash
clientdevbridge find "button"            # locate a widget by label, type or path
clientdevbridge click --widget "/root/children[0]"
clientdevbridge tooltip --at 133,179    # read what hovering there would show
clientdevbridge snapshot --json         # the whole tree, for a program to consume
```

### It catches rendering regressions

`compare` checks a screenshot against a committed golden image and writes a diff you can look at.
Golden sets are kept per GL renderer, because llvmpipe and a real GPU do not produce identical
pixels and one tolerance cannot cover both without hiding regressions.

```console
$ clientdevbridge compare scene --update      # record
$ clientdevbridge compare scene               # verify
scene: matches (0 of 409920 pixels differ, 0.000% <= 0.1%).

$ clientdevbridge setblock 2 4 2 minecraft:oak_slab    # break something
$ clientdevbridge compare scene
scene: DIFFERS — 7811 of 409920 pixels, 1.905% > 0.1%.
/path/to/mod/.clientdevbridge/diffs/scene_..._-diff.png
```

![The same scene ghosted to near-white, with only the changed chest picked out in saturated red](https://raw.githubusercontent.com/CyclopsMC/clientdevbridge-cli/master/docs/images/golden-diff.png)

The unchanged scene is ghosted so the change is the only thing you see. `--region` narrows the
comparison to a rectangle — applied to the golden as well, so it needs no re-record — and
`--threshold` sets how much drift still counts as a match.

The reverse assertion — *this did* change something — is `screenshot --diff`:

```console
$ clientdevbridge screenshot --name lamp-off
/path/to/mod/.clientdevbridge/screenshots/lamp-off.png
$ clientdevbridge command "setblock 0 4 2 minecraft:redstone_block"
$ clientdevbridge screenshot --name lamp-on --diff .clientdevbridge/screenshots/lamp-off.png
/path/to/mod/.clientdevbridge/screenshots/lamp-on.png
changed: 4812 of 409920 pixels, 1.174% >= 0.1%.
```

It exits non-zero when the two are too similar, so "did that visibly do anything" is a check a
script can make rather than something you have to look at.

Determinism is not luck: `start` pins the GUI scale, disables clouds, particles, entity shadows,
view bobbing and vsync, fixes the window size, and the test world is a fixed-seed superflat with
the daylight cycle and weather off. `world-reset` puts the player at a known position every time.

Those settings are written into your project's `options.txt` — the same file a client you launch
yourself reads — so **`stop` puts the file back the way it was**, and says so. A client closed by
hand never reaches `stop`, and `status` then tells you the file is still pinned and that `stop` will
restore it. `start --no-pin-options` skips the whole business.

**Toast popups are suppressed** for the same reason — an advancement or recipe toast fades over
several seconds, so a screenshot taken near one is not reproducible. `start --toasts` turns them
back on, for when the toast is the thing you are testing.

**The cursor is part of the frame too**, and it is the one piece of that list which is live state
rather than a setting: it draws a hover highlight, and some GUIs point a player model or an item at
it. Every input command moves it, so two captures taken after different clicks differ for reasons
that have nothing to do with what you were testing. `screenshot --mouse 213,120` and
`compare --mouse 213,120` park it first — record the golden with the same value.

### It drives the client

```bash
clientdevbridge click --at 205,121              # or --widget by text or path
clientdevbridge type "hello"                    # into the focused widget
clientdevbridge key ESCAPE                      # or 'E', or 'GLFW_KEY_F3'
clientdevbridge hold-key W --ticks 20           # movement, held through the real key binding
clientdevbridge hold 2                          # select hotbar slot 2, so `use` acts with it
clientdevbridge drag --from 133,179 --to 205,121
clientdevbridge scroll --at 200,120 --dy -3    # or with no screen open: change hotbar slot
```

`drag` and `scroll` drive a scrollable screen the way a player does. The creative inventory is the
worked example: `scroll --at 200,110 --dy -3` moves the item list, and
`drag --from 298,72 --to 298,180` takes the scrollbar from top to bottom — a drag is a click, a run
of moves and a release, so a screen tracking its own drag state follows it. Both work on the search
tab and on a filtered list.

With **no screen open**, `scroll` changes the hotbar slot, which is the only thing scrolling does in
the world — `--at` is not needed there. `hold <slot>` is the direct way to the same thing.

Input goes through the game's own handlers, so a mod's click logic runs exactly as it would for a
player. Off-screen coordinates are refused rather than silently doing nothing.

`--widget` only reaches what the game models as a widget. Vanilla buttons, text boxes and slots are
widgets; a field a mod draws itself in `render` is not, and `snapshot` cannot show you what was
never there. Those need `--at x,y` with coordinates read off a screenshot, against the GUI-space
origin the container reports — see [It reads a GUI structurally](#it-reads-a-gui-structurally-not-just-visually).

### It sets up the world for you

```bash
clientdevbridge world-reset                     # fixed-seed creative superflat, player at 0,4,0
clientdevbridge world-reset --template my-save  # or start from a world committed in your repo
clientdevbridge command "fill -4 4 -4 4 8 4 minecraft:air"
clientdevbridge block 0 4 2 --json              # block, state, properties, block entity NBT
clientdevbridge entity @s ForgeCaps             # an entity's NBT, or one branch of it
clientdevbridge inventory
```

`entity` is `block --nbt` for things that are not blocks. Abilities, attributes and capability data
live on the **server** entity, which the client's copy does not have, so it is read through the same
command source `/data get` uses. Give it a path: a player's whole NBT is tens of kilobytes and
almost every question about one is about a single branch.

`inventory --json` serialises item components through their registered codecs, the way `/data get`
does — so a mod's own data component reads as its actual contents rather than as a class name and an
identity hash, which is what makes it usable for asserting that a mod changed something.

### It waits on conditions instead of on sleeps

```bash
clientdevbridge wait --screen CraftingScreen --timeout 5000
clientdevbridge wait --ticks 20
clientdevbridge wait --chunk 0,4,0
clientdevbridge wait --expr "mc.level != null"
```

Every wait reports the state it actually observed when it times out, so a failure says what was on
screen rather than only that something did not happen.

### It iterates without restarting

```bash
clientdevbridge hotswap        # recompile and redefine changed classes in the running client
clientdevbridge eval "player.getY()"
clientdevbridge logs --lines 20 --level warn
```

`hotswap` redefines method bodies through JDWP, so the client has to have been started with a
debug port: `clientdevbridge start --jdwp-port 5005`. Adding or removing a field, a method or a
superclass cannot be redefined by any JVM — `hotswap` says so and points at `restart`, rather than
reporting success and leaving you looking at stale code. `--restart-if-needed` makes that call for
you and restarts with the options the running client was launched with, so you do not have to know
HotSpot's redefinition rules to keep going.

Booting is a minute or two and it throws away the world you built, so prefer `hotswap` to
`restart`: keep one client alive for a whole session.

`eval` is an escape hatch for what no command covers. **The language is Groovy**, so a Java
expression is usually the safe guess and a JavaScript one usually is not: `typeof x` and
`String(x)` are not Groovy, and the errors they produce name Groovy internals rather than saying
so. `mc`, `player`, `level`, `screen`, `server` and `dev` are bound. It is opt-in and
localhost-only, like the whole bridge.

`dev` builds and reads the game objects a script cannot name for itself — because the game is
loaded by a transforming class loader and the script engine is not. **What each one answers:**

| Call | Returns |
| --- | --- |
| `dev.pos(0, 4, 2)` | a `BlockPos` |
| `dev.vec(0.5, 4.0, 2.5)` | a `Vec3` |
| `dev.block(0, 4, 2)` | a `BlockState` |
| `dev.blockId(0, 4, 2)` | a `String`, the registry id |
| `dev.prop(0, 4, 2, "lit")` | the property's **own type** — `Boolean` for `lit`, `Integer` for `power`, a `String` only where the property really is textual |
| `dev.props(0, 4, 2)` | a `Map` of every property name to its typed value |
| `dev.blockEntity(0, 4, 2)` | the `BlockEntity`, or null |
| `dev.nbt(0, 4, 2)` | a `String`: that block entity's synced NBT |
| `dev.item("minecraft:stone")`, `dev.item(id, count)` | an `ItemStack` |
| `dev.blocks(ns)`, `dev.items(ns)`, `dev.namespaces()` | a `List<String>` |

The type matters most for `dev.prop`, because comparing a `Boolean` against a quoted string is
false forever and a `wait --expr` on it can only time out. Write `dev.prop(0, 4, 2, "lit") == true`,
not `== 'true'`. `eval` shows you which you have — a `String` comes back quoted, a `Boolean` does
not:

```console
$ clientdevbridge eval "dev.prop(0,4,2,'lit')"
false
$ clientdevbridge eval "'false'"
"false"
```

### It runs a whole script over one connection

```bash
clientdevbridge batch build-network.txt         # or '-' to read the commands from stdin
```

Every command opens a socket, does one thing and closes it. That is right for a command you type
and wrong for the fifty a script issues in a row, where connecting costs more than the work.
`batch` holds one connection open and replays the lines through the same parser the shell uses, so
nothing about any command changes:

```
setblock 0 4 2 minecraft:anvil
open-gui 0 4 2
set-text "/root/children[0]" "Excalibur" --commit enter
close-screen
```

It stops at the first failure and says which line, because in a script that builds something, step
twelve is meaningless if step eleven did not happen. `--continue-on-error` runs the rest anyway,
and `--json` prints one result object per command.

### It tells you what a mod registered

```console
$ clientdevbridge registry namespaces
evilcraft
integrateddynamics
minecraft
$ clientdevbridge registry blocks colossalchests --limit 3
colossalchests:chest_wall_copper
colossalchests:chest_wall_diamond
colossalchests:chest_wall_gold
# 25 matched; showing 3. Narrow with --filter or raise --limit.
```

`namespaces` is also the quickest way to tell a mod genuinely loaded rather than merely being on
the classpath: one that failed to initialise registers nothing.

### It can mine

```console
$ clientdevbridge break 0 4 2
broke Block{minecraft:cobblestone} in 9 ticks
  dropped minecraft:cobblestone x1 at 0.26, 4.00, 1.82
$ clientdevbridge walk-to 0.26 1.82
Walked to 0.18, 4.00, 1.24.
```

Mining is a held action, and how long it takes depends on the block and the tool — so `break` holds
attack and advances the progress once per tick until the block gives way, which is what makes the
tick count mean something: nine with a diamond pickaxe, about two hundred with bare hands, and bare
hands drop nothing. The drop is *thrown*, so its position is reported: that is where you walk to.

`hold-key ATTACK --ticks 20` is the underlying mechanism. It also takes `USE` — eating, drinking,
drawing a bow, raising a shield — and `MOUSE_LEFT`/`MOUSE_RIGHT`/`MOUSE_MIDDLE`.

### It can use the item in your hand

```bash
clientdevbridge use-item --wait-screen
clientdevbridge open-gui                # no coordinates means the held item
```

The plainest interaction in the game, and how most item GUIs open. A right-click aimed at a block
interacts with the block instead — what a player gets, and the likeliest reason an item looks like
it did nothing — so `use-item` reports what it was aimed at and says so. `--hand main` skips that
decision; `--hand off` reaches an off-hand item, which a player cannot aim at.

### It can shift-click

```bash
clientdevbridge slot-click 12 --type quick_move
clientdevbridge click --at 125,202 --shift
```

A screen works out that a click was a shift-click from the *real* keyboard state, which synthetic
input cannot reach — and `Screen.mouseClicked` has nowhere to pass a modifier anyway. So the
operation is named rather than inferred: `quick_move` is what a shift-click means. `--type` also
takes `pickup`, `swap`, `clone`, `throw`, `quick_craft` and `pickup_all`.

### It edits a text field in one command

```console
$ clientdevbridge set-text "/root/children[0]" "Excalibur"
/root/children[0]: 'Diamond Sword' -> 'Excalibur'
```

The manual version is click, press BACKSPACE as many times as the old value is long, type, then
trigger whatever commits it. The snapshot already knows the field's current value, so the count is
exact; the value is read back afterwards and reported, so a field that rejected a character says so
rather than surfacing three commands later — an anvil with nothing in it ignores its name box, and
you hear about that immediately rather than three commands later.

The widget is a `/root/children[N]` path from `snapshot`, or a label. **Prefer the path.** A label
has to be unique, and on an anvil "Repair & Name" is both the screen's title and the box's, so it
matches two things:

```console
$ clientdevbridge set-text "Repair & Name" "Excalibur"
error: 'Repair & Name' matches 2 widgets:
  AnvilScreen "Repair & Name"  /root
  EditBox "Repair & Name"  /root/children[0]
Pass the exact path instead of the label, e.g. /root/children[3]
```

**A field a mod paints itself is not a widget at all**, so it has no path and no label, and
`snapshot` cannot show you what was never there — Integrated Dynamics' aspect-settings boxes are
like this. Those need `click --at x,y` with coordinates read off a `screenshot`, then `type`;
see [It reads a GUI structurally](#it-reads-a-gui-structurally-not-just-visually) for converting
between pixel and GUI space.

### It can aim at one side of a block

Most blocks behave the same whichever side you click. Multipart blocks — Integrated Dynamics'
cables, and anything else built on CyclopsCore — decide what you clicked by casting a ray from the
player's eye, so the side is the whole interaction:

```console
$ clientdevbridge use 0 4 2 --face up
used the main hand on the up side of 0,4,2: SUCCESS

$ clientdevbridge open-gui 0 4 2 --face up
screen: org.cyclops.integrateddynamics.client.gui.container.ContainerScreenPartWriter
```

`use` is the general right-click, for anything that leaves no screen behind: placing a block or a
part, using a tool, wrenching with `--sneak`. `open-gui` is `use` plus a wait for a screen.

## Output conventions

Output is sized for the thing reading it. `--json` is compact unless stdout is a terminal, and omits
the empty slots of a container or inventory — a chest screen with one item in it costs 792 bytes as
JSON where it used to cost 9,813. `slotCount` comes with it and the slots are a regular grid, so the
missing geometry is derivable; `snapshot --include-empty` and `inventory --include-empty` restore
every rectangle. **Read slots by their `index` field rather than by position in the array.**

The cheapest question is usually not the JSON one: the same screen is 225 bytes as an outline and
792 as JSON, and a screenshot read as an image is about 546 tokens. `compare` and
`screenshot --diff` answer "did this change" with an exit code and one line, without an image
entering anyone's context.


These exist so an agent reading stdout can act on it without guessing:

- **Images are never printed.** `screenshot` writes a file and prints its absolute path on its own
  line. Open that path with your file-reading tool.
- Default output is readable text. `--json` prints the raw protocol result instead.
- Exit codes: `0` success, `1` a protocol-level failure (bad arguments, a method that refused),
  `2` a session or connection failure (nothing running, port taken, client gone), `3` not ready yet
  — a build that is still running and healthy, which is a reason to wait rather than to investigate.
- **A pipe hides that exit code.** `clientdevbridge ... | head` reports `head`'s status, not the
  CLI's, so a failed command reads as a successful one — and piping into `head`, `tail` or `grep` is
  the natural thing to do with output this size. Check `${PIPESTATUS[0]}` in bash, or capture first
  and filter afterwards:

  ```bash
  out="$(clientdevbridge snapshot)" || exit 1
  grep EditBox <<<"$out"
  ```

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

**`start` also appends three lines to your project's `.gitignore`**, so the session state above does
not get committed while `golden/` still can. It says so when it does it, and it is the only file
outside `.clientdevbridge/` this tool ever writes. `start --no-gitignore` skips it, for a checkout
that has to stay pristine — a CI run, or a repository you only borrowed.

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

[`AGENTS.md`](AGENTS.md) is the guide for working on this repository: how it relates to the mod
repository, which side a change belongs on, and what to re-record when the protocol grows.
