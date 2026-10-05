# tmc — The Legend of Zelda: The Minish Cap

**The build is byte-identical to the staged ROM.** The browser target runs that ROM on a
WebAssembly build of mGBA, from a cartridge dump the user picks themselves.

**But "the artifact matches" and "the game is decompiled" are different claims here, and the
gap is unusually wide.** Both numbers are in §2, measured two independent ways. Read that
section before quoting the 100%.

---

## 1. The matching build

Upstream documents its expected hashes in `README.md`, in `INSTALL.md` and in `tmc.sha1`.
I checked all three against the staged ROM **before** building anything. They agree exactly —
**there is no mismatch to report.**

| | sha1 | size |
|---|---|---|
| staged `roms/tmc.gba` | `b4bd50e4131b027c334547b4524e2dbbd4227130` | 16777216 |
| upstream `README.md` / `INSTALL.md` / `tmc.sha1` | `b4bd50e4131b027c334547b4524e2dbbd4227130` | — |
| **built `tmc.gba`** | **`b4bd50e4131b027c334547b4524e2dbbd4227130`** | 16777216 |

Also, for the record: md5 `a104896da0047abe8bee2a6e3f4c7290`,
sha256 `bedc74df62755f705398273de8ed3bc59be610cf55760d0b9aa277f1f5035e73`.

Verified three ways, not one:

1. the build's own `sha1sum -c` against `tmc.sha1` (`GBA.mk` runs it as part of `make`, so a
   non-match fails the build rather than silently producing a wrong ROM);
2. an independent `cmp` of the built file against the staged ROM;
3. a **full `make clean`** (which removes `build/`, `tmc.gba` *and* `tmc.elf`) followed by a
   15.6 s rebuild — not a 3 s relink off a stale `.elf`. Three independent builds in total,
   all byte-identical to each other and to the cartridge dump.

### Pinned revision

```
zeldaret/tmc  6fb6dfb4a7efbe24d0fd1dda5097af6131faacde   (2026-09-27)
              "Merge pull request #708 from Henny022p/link-fire"
```

Checked out detached at that commit; not a moving branch.

### Toolchain

| component | version | where from |
|---|---|---|
| agbcc | pret/agbcc, prebuilt | `~/decompfleet/shared/agbcc-install` (shared; not rebuilt) |
| arm-none-eabi-gcc / cpp | 14.2.1 20241119 | Ubuntu `gcc-arm-none-eabi` deb |
| arm-none-eabi as/ld/objcopy/nm | 2.45.50.20251209 | Ubuntu `binutils-arm-none-eabi` deb |
| host gcc / g++ | 15.2.0 | system |
| cmake | 4.2.3 | system |
| libpng | 1.6.57 | system |
| python3 + pycparser | 3.00 | `apt-get download python3-pycparser` + `dpkg-deb -x` |
| emscripten | 4.0.10 (`b7dc6e57`) | shared emsdk |
| mGBA | `68cf79fe55257b61efaeea87c83de69aab01f963` | pokeruby's shared wasm build, linked read-only |

**tmc is not a pret repo, but it does want the pret agbcc.** This was worth confirming rather
than assuming, because at least one non-pret GBA decomp on this fleet (`metroidret/mzm`) needs
`-f2003-patch`, a flag only the `jiangzhengwenjz/agbcc` fork has. tmc does not:
`.devcontainer/Containerfile` clones `https://github.com/pret/agbcc`, `INSTALL.md` says the
same, and `GBA.mk`'s `CFLAGS` are plain `-O2 -Wimplicit -Wparentheses -Werror -Wno-multichar
-g3` plus `-mthumb-interwork` on seven files. The byte match settles it empirically.

**tmc is a hybrid toolchain, unlike the pret repos.** `Toolchain.mk` uses agbcc as the C
compiler (`CC1`) but modern `arm-none-eabi-gcc` as the *preprocessor* (`CPP := $(CC) -E`), plus
modern `as`/`ld`/`objcopy`. Host tools are a CMake project, not a hand-written makefile.

### Two deviations from upstream's instructions — neither is a patch to the game

1. **CMake 4 refuses a vendored dependency.** `make tools` fails with
   *"Compatibility with CMake < 3.5 has been removed"* — a `FetchContent` dependency
   (nlohmann/json) still declares `cmake_minimum_required(VERSION 3.1)`. Configure with the
   documented escape hatch instead of editing anything:

   ```sh
   cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
         -DCMAKE_INSTALL_PREFIX=tools -S tools -B tools/cmake-build
   cmake --build tools/cmake-build -j"$(nproc)" --target install
   ```

2. **`pycparser` is required and there is no pip on this box.** `tools/extract_include_enum.py`
   imports it to turn `include/*.h` enums into assembler `.set` directives. No sudo needed:

   ```sh
   apt-get download python3-pycparser && dpkg-deb -x python3-pycparser_*.deb <prefix>
   export PYTHONPATH=<prefix>/usr/lib/python3/dist-packages
   ```

Nothing else needed patching. The host tools (gbagfx, preproc, scaninc, asset_processor,
tmc_strings, …) all compile clean under gcc/g++ 15.2.0 with their own warnings intact. Full
clean build: ~16 s wall / ~43 s CPU at `-j12`.

### Reproducing it

```sh
export PATH="$HOME/decompfleet/shared/arm-bin/usr/bin:$PATH"
export PYTHONPATH="$HOME/decompfleet/games/tmc/pylibs/usr/lib/python3/dist-packages"
cd upstream/tmc
cp -r ~/decompfleet/shared/agbcc-install tools/agbcc
ln -sf ~/decompfleet/roms/tmc.gba baserom.gba        # your own dump; never committed
cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
      -DCMAKE_INSTALL_PREFIX=tools -S tools -B tools/cmake-build
cmake --build tools/cmake-build -j"$(nproc)" --target install
make -j"$(nproc)"                                     # ends with "tmc.gba: OK"
```

---

## 2. The two percentages, and what the byte match actually covers

**Code: 100.0000%. Data: 1.7127%.** Both from upstream's own `progress.py` against the map file
this build produced:

```
src:     647908 /   647908 total bytes decompiled  100.0000%
data:    238628 / 13933140 total bytes analysed      1.7127%
```

`progress.py -m` (matching rather than decompiled) gives the same 100.0000% — there are no
`NONMATCH` functions left. The shield in upstream's README shows the first number only.

### What the 100% does and does not mean

It is a real and unusually strong figure: the `asm` bucket is **zero**, i.e. no raw
disassembly `.text` remains. Two caveats, from reading `progress.py` rather than trusting it:

- It counts `asm/src/` and `asm/lib/` `.text` as "src". Of the 647,908 bytes, **631,300 (97.4%)
  are compiled from C in `src/`** and **16,608 (2.6%) are hand-written ARM assembly**
  (`crt0.s`, `intr.s`, `player.s`, `enemy.s`, `script.s`, `libagbsyscall.s`, `m4a_asm.s`, …).
  That is still human-authored source, just not C — a fair thing to count, worth naming.
- It is a percentage **of code only**. Code is a small part of this cartridge.

### Where the 16,777,216 bytes actually come from

Measured from the link map of the build above:

| | bytes | % of ROM |
|---|---:|---:|
| `.text` from compiled C (`src/*.c`) | 631,300 | 3.76% |
| `.text` from hand-written assembly (`asm/`) | 16,608 | 0.10% |
| `.rodata` from `src/` (C data) | 181,756 | 1.08% |
| `.text` from `data/` (scripts) | 56,872 | 0.34% |
| **`.rodata` from `data/` (`.incbin` blobs)** | **13,694,512** | **81.63%** |
| 0xFF padding to 16 MiB | 2,196,060 | 13.09% |

So **about 6% of the ROM's real content is produced by the toolchain and about 94% is copied
out of the user's own cartridge.** There are **7,218 `.incbin` directives** in `data/` and
`asm/`, pointing at files that `asset_processor extract` cuts out of `baserom.gba` at offsets
listed in `assets/*.json`: **13,916,026 bytes across 14,785 files** written into
`build/USA/assets` at build time. The repository itself commits no game bytes at all — only the
JSON manifests (offset, size, type) and one logo PNG in the docs.

This is the "match by construction" the GameCube and PS1 sessions found, and here it is the
dominant mechanism: the link reproduces the original largely because most of the bytes *are*
the original.

### Confirming that independently: a poisoned baserom

Rather than infer it from the map, I measured it. I flipped one byte every 64 KiB in a **copy**
of the ROM (255 probes; the staged dump was never touched), pointed `baserom.gba` at the copy,
wiped `build/` and rebuilt. If a probe's flipped value appears at the same offset in the
output, that region is a pass-through of the user's ROM; if the output byte is unchanged, that
region was reconstructed by the compiler.

```
probes landing in real ROM content: 222
  carried through from the user's ROM : 201   90.5%
  rebuilt from source (poison erased) :  21    9.5%
probes landing in the 0xFF pad       :  33    (excluded; nothing is built there)

total differing bytes between the clean and poisoned builds: 201
```

Exactly 201 bytes differ — one per surviving probe, with **zero knock-on**. Every poisoned byte
either survived verbatim at its own offset or was overwritten by compiler output; nothing
propagated. The probe's 9.5%-from-source is consistent with the map's 6.1% within the sampling
error of 222 probes.

The build correctly **failed its own sha1 check** on the poisoned input, which is also a check
on the check.

---

## 3. The native port (999sian/tmc, "Project Picori") — evaluated, not shipped

```
999sian/tmc  bd06a63919951ed75fca3e8cbb6c6cb728823321   (2026-09-28)
```

**Declined**, for the same reason as the Twilight Princess and Castlevania sessions. Three
findings, in order of how much they settle it:

1. **It has no WebAssembly target at all.** A grep for `emscripten|emcc|wasm` across its build
   files, scripts and docs returns nothing. It is SDL3 + a vendored software PPU + the agbplay
   audio engine, targeting x86-64 Linux/Windows/macOS. It cannot be the browser deliverable
   even in principle; shipping it would mean *I* port it.

2. **Its decompilation source has diverged, and the matching GBA target no longer builds.** 357
   files under `src/` differ from `zeldaret/tmc` (~25,099 changed lines). It still ships
   `tmc.sha1` with the retail hash and a byte-identical `GBA.mk`, but `make` fails: 28
   `#include "port_*"` directives sit **outside** their `#ifdef PC_PORT` guards. I added
   `-I port` locally to see whether that was the whole story — it is not. `src/color.c` then
   fails on an unguarded `Port_RemapGfxOffset()` call and an undeclared `numPalettes`, and
   `src/common.c` on a struct-member mismatch. So the native binary is compiled from a codebase
   that cannot currently reproduce the cartridge: shipping it is shipping my build of a
   non-matching recompilation.

3. **To be fair to it, it does not bake the game's assets into the binary.** Its one large
   embedded blob, `port/generated_sounds_embed.cpp` (104,411 bytes), is `assets/sounds.json` —
   a manifest of offsets, sizes and types, not audio. The design requires the user's own ROM
   next to the executable, validates it by SHA-1, and builds the asset cache on first launch.
   On the bring-your-own-ROM rule it passes on its own terms. It fails on the other two.

Also worth noting if anyone revisits it: it carries `port_update_check.c` and
`port_discord_rpc.c`, i.e. it phones out by default — which a page holding someone's cartridge
dump should not.

Its GBA host tools and `agbcc` setup *do* build fine here; only the game target fails.

---

## 4. The browser target

**Shipped: the decomp's ROM on an emscripten build of mGBA's `mCore`.** Not EmulatorJS, not a
libretro frontend — a 443-line C shim and one static HTML page, following `pokeruby`'s stack,
which is the best on this fleet and immune to the EmulatorJS traps.

```
dist/tmc.wasm   663,901 bytes
dist/tmc.js      19,295 bytes
dist/index.html  22,857 bytes
```

- **The user supplies the ROM.** A real `<input type=file>` plus drag-and-drop, read with the
  File API straight into wasm linear memory. The page is static files with no server
  component, and the test asserts at the CDP network layer that it fetches nothing but its own
  `.js` and `.wasm`.
- The ROM is cached in IndexedDB so a reload doesn't re-prompt; there is a **"forget ROM"**
  button. It never leaves the device.
- **Saves persist across a reload**, verified by the game's own loader — see §5.
- **Muted by default and genuinely silent:** no `AudioContext` is constructed at all until the
  user clicks unmute. Muting is the absence of an audio graph, not a gain node at zero.

### The one thing that differs from every other GBA target on this fleet

**The Minish Cap saves to EEPROM, not flash.** The cartridge string is `EEPROM_V124` — the
8 KiB part — so `SAVE_BYTES` is **8192**, not pokeruby's and firered's 131072. This is exact,
not "big enough": mGBA picks the save media partly from the size of the buffer it is handed.
mGBA starts at `EEPROM512` and promotes to the 8 KiB chip via `_ensureEeprom()` once the game
issues a 14-bit address; sizing the buffer at 8192 up front means that promotion remaps inside
the same buffer and never has to truncate, so the bytes stay live for the page to mirror. The
shim exposes `vj_save_type()` and **both test suites assert mGBA settled on `EEPROM` (4), not
`EEPROM512` (5)**, rather than assuming the promotion happened.

Build: `cd web && make`. Tests: `make selftest` (core, in node) and `make browsercheck` (the
real page in headless Chrome).

---

## 5. What I actually tested

Everything below ran **muted**. No sound was ever enabled or heard.

### The matching build — verified
Byte-identical three times, by `sha1sum -c`, by `cmp`, and after a genuine `make clean`.

### Gating "played" on the game's own state

A screenshot cannot tell play from a cutscene, so both suites read The Minish Cap's own
variables, at addresses taken from `arm-none-eabi-nm` on **the `tmc.elf` this project built** —
`gMain`, `gRoomControls`, `gPlayerEntity`, `gSave`. Struct offsets come from the decomp's own
headers. The symbol file is regenerated by the Makefile, never committed.

Because an offset table is exactly the sort of thing that is quietly wrong, `sanityCheck()`
tries to falsify it: `gMain.task` must stay inside the `Task` enum on all 960 samples, the
first sample must be `TASK_TITLE` (because `AgbMain` enters `sTaskHandlers` at index 0), and
in-game room dimensions must be a plausible multiple of 16.

**One trap that does not apply here, established rather than assumed:** retail TMC has **no
attract demo**. `src/main.c` wires `DemoTask` into the task table only under `#ifdef DEMO_USA`,
so it exists solely in the kiosk demo ROMs. The retail USA build has no code path that plays
itself. The differential-input check below is kept anyway, as the thing that *would* catch one.

### Core suite, in node (`web/test/core-smoke.mjs`) — 22/22
- cartridge header reads `GBAZELDA MC` / `BZME`, revision byte 0.
- `TASK_TITLE → TASK_FILE_SELECT → TASK_GAME` through the real file-select flow.
- The opening is genuinely played: A through the logos and the Picori legend, **START to
  confirm a name on the ENTER A NAME keyboard** (A alone only types more letters, so the name
  comes out `AAAAAA`), A through the wake-up. The game then addresses the player as
  **"AAAAAA, time to get up"** — my typed name, in the game's own dialogue.
- `gSave.name` reads `AAAAAA`.
- **Differential input:** holding LEFT moves the player −83 px, holding RIGHT +88 px. Nothing
  the game drives by itself tracks the pad like that.
- **Left the starting room under scripted input**, up the staircase: `0x22/0x15` → `0x22/0x10`
  (`AREA_HOUSE_INTERIORS_2`, Link's bedroom → the room above).
- mGBA attached the 8 KiB EEPROM; save buffer exactly 8192 bytes.
- Savestate round trip: snapshot → 240 frames of divergence → restore → one frame from the
  restored state is bit-identical. The test fails itself as inconclusive if the picture did not
  change during the divergence window.
- **I looked at the frames.** Dumped PPMs show the naming keyboard with `AAAAAA` typed, the
  opening cutscene vignette, Link in control in the bedroom, the different room after the
  stairs, and the bedroom again after the reload.

### Save persistence — validated by the game, not by comparing bytes

A byte-for-byte match across a reload **cannot** tell a complete save from a half-written one,
so that is not what is asserted. The save is handed back to The Minish Cap and its own loader
is asked to accept it: `src/save.c`'s `ReadSaveFile` → `VerifyChecksum` checks two checksum
words and the `'MCZ3'` magic before `gSave` is populated.

The signal needs no reimplementation of that checksum. **Replay the opening with A only.** From
a valid file, A on the file select continues into the game. From an empty or rejected slot, A
starts a new file and lands on the naming keyboard, where A only types more letters and the run
stalls in `TASK_FILE_SELECT` forever.

| arm | result |
|---|---|
| save written by the game, restored | `TASK_GAME`, name `AAAAAA`, same area — **accepted** |
| **control:** blank cartridge (all `0xFF`) | stalls in `TASK_FILE_SELECT` — **refused** |
| **control:** wide corruption (1 byte in 8 flipped) | stalls in `TASK_FILE_SELECT` — **refused** |

Both controls fail as they must, so the check is able to say no. Without them "the save loaded"
would be unfalsifiable.

**A finding other agents should know:** blanking the entire back half of the EEPROM *still
loads*. That is correct behaviour, not a weak check — TMC writes **two redundant copies** of
every save file with two checksum records each (`DataDoubleWriteWithStatus`), so copy 1
survives. An earlier version of my control flipped a single byte and the game repaired it
silently, which would have made a one-byte-corruption control look like a passing test while
measuring nothing. On this game a byte-comparison save test is doubly inadequate.

### The real page, headless Chrome (`web/test/browser_check.py`) — 18/18

The ROM is fed to the genuine file input over the DevTools protocol
(`DOM.setFileInputFiles`), so the picker, File API path, IndexedDB and boot sequence under test
are the ones a user gets.

- **Ephemeral debug port** (`--remote-debugging-port=0`, real port read back from
  `DevToolsActivePort`) in a private profile, plus **a URL nonce the page must echo back**. Ten
  agents share this box; a fixed port lets Chrome attach to someone else's instance and grade
  their game.
- core boots; ROM accepted through the real picker; header `GBAZELDA MC`/`BZME`, revision 0.
- **no request leaves the machine** — asserted from CDP's own `Network.requestWillBeSent` log,
  not the page's self-report; the only four requests are `index.html`, `tmc.js`, `tmc.wasm`
  and a `favicon.ico`.
- canvas is laid out at a non-zero size (240×160 backing, 952×552 on screen).
- **audio muted — asserted that no `AudioContext` object exists.**
- played the opening to `TASK_GAME`; `gSave.name` is `AAAAAA`; mGBA settled on EEPROM (4).
- **brightness measured from the driver's own screenshot**, decoded outside the page with
  `pngstat.py`: mean luma 146.5, 83% of pixels lit. A page cannot measure its own WebGL canvas
  — no `preserveDrawingBuffer` — and reports perfect black while the game is plainly running.
- **differential input in the browser too:** LEFT −83, RIGHT +88, identical to node.
- **walked out of the starting room in the browser**, up the staircase.
- a **dispatched** `pagehide` (deterministic, not a navigate-away race) does not destroy the
  in-memory save.
- **navigated away in the same tab and came back** — not closed and reopened, which can skip
  the unload path entirely — then A alone continued into the game with the name intact.
- **control arm:** a corrupted save planted in the page's own IndexedDB makes the next load
  stall at file select. Same page, same code path, opposite outcome.
- no console errors.

### What I did NOT test — be clear about this

- **No play beyond Link's house.** The muted run reaches the bedroom and the room up the
  stairs, and no further. **Never reached South Hyrule Field, Hyrule Town, or any dungeon.**
  Nothing about the overworld, combat, items, Kinstones or Minish shrinking is play-tested.
- **I never reached an in-game SAVE from the pause menu.** `START` does not open a menu this
  early in the game; `HandleSave` is reachable from `src/menu/pauseMenu.c` but I did not get
  there. The save that is validated is the one the game itself writes when the file is created
  at file select — a complete, checksummed `WriteSaveFile`, accepted by the game's own loader
  on reload — but it is **not** a save made from the in-game menu mid-adventure. **Unverified.**
- **Only headless Chrome.** No Firefox, no Safari, no real mobile browser.
- **No touch controls.** Keyboard and gamepad only; the gamepad path is written against the
  Standard Gamepad mapping but **unverified** — no controller was attached.
- **Audio is unverified.** The code to drain mGBA's buffer into a ScriptProcessor exists and is
  wired to the unmute button, but every test ran muted by rule, so it has never been heard.
- **EU, JP and the two demo ROMs were not built** — only USA. `make all` would build all five
  but I have no dumps for the others.
- The Picori native binary was **never run**: I built its host tools and its GBA target (which
  fails), not `tmc_pc`.

---

## 6. Proposed catalog fragment

Do not merge mechanically — `source`, `embedUrl`, `image` and `verification.date` are
placeholders until this is actually published.

```json
{
  "id": "zelda-minish-cap",
  "title": "The Legend of Zelda: The Minish Cap",
  "aliases": ["tmc", "minish cap", "minishcap", "zelda minish cap", "the minish cap"],
  "year": 2004,
  "genre": "Action-adventure",
  "kind": "Decompilation",
  "mode": "files",
  "engine": "the zeldaret/tmc decompilation, built to a matching ROM and run on a WebAssembly build of mGBA",
  "description": "Shrink to Minish size and grow again to cross Hyrule with a talking cap.",
  "overview": "The Legend of Zelda: The Minish Cap built from the zeldaret/tmc decompilation, pinned at 6fb6dfb4. The build is byte-identical to a retail USA cartridge dump, sha1 b4bd50e4131b027c334547b4524e2dbbd4227130. Worth being precise about what that means: tmc's code is 100% decompiled, but only 1.71% of its data is, so roughly 94% of the cartridge's real content is extracted from your own ROM at build time and linked back in unchanged. The page runs the result on a direct 663 KB WebAssembly build of mGBA's core, with no emulator frontend in between. You supply your own ROM: it is read in your browser with the File API straight into the emulator's memory. The page is static files with no server component, and makes no network request after its own two files load.",
  "source": "https://github.com/andrewnakas/tmc-web",
  "engineLicense": "zeldaret/tmc; mGBA core MPL-2.0",
  "assetLicense": "None distributed — the player supplies their own ROM",
  "assetRequirements": "Your own The Legend of Zelda: The Minish Cap ROM, USA, sha1 b4bd50e4131b027c334547b4524e2dbbd4227130. It is read in your browser and never uploaded.",
  "controls": [
    "Arrow keys — move",
    "X — A (sword, talk)",
    "Z — B",
    "A / S — L / R (R rolls)",
    "Enter — Start",
    "Shift — Select",
    "Gamepad — any standard controller (untested)"
  ],
  "saveInstructions": "The cartridge EEPROM is mirrored into this browser's storage and restored automatically on reload, so a file you start is still there next time. Save from the in-game menu as usual. There are also save-state buttons. Clearing site data removes everything, including the cached ROM.",
  "limitations": [
    "You must supply your own ROM; none is distributed.",
    "USA version only — the EU, JP and demo cartridges are different builds and are untested here.",
    "Verified only as far as leaving Link's bedroom for the room upstairs. Hyrule Town, the overworld, combat and every dungeon are not play-tested.",
    "Saving from the in-game pause menu was never reached. Save persistence is verified by the game's own loader accepting the file it wrote at file-creation, across a real page reload.",
    "Sound is implemented but has never been listened to — all testing was muted.",
    "Keyboard and gamepad only; no on-screen touch controls.",
    "Tested in headless Chrome only."
  ],
  "inputs": ["Keyboard", "Gamepad"],
  "downloadMB": null,
  "complete": false,
  "color": "#3f9d55",
  "shelf": "decomp",
  "platform": "Game Boy Advance",
  "launch": "embed",
  "touch": false,
  "embedUrl": "https://andrewnakas.github.io/tmc-web/",
  "verification": {
    "status": "smoke-tested",
    "date": null,
    "browsers": ["Chrome (headless)"],
    "scope": "Muted headless run: boot, file creation through the real name-entry keyboard, the opening cutscene, player control in Link's house and a room change up the staircase, all gated on the game's own variables read from this build's symbol table. Cartridge-EEPROM persistence across a real same-tab navigation, validated by the game's own save loader with blank and corrupted control arms. No play-testing beyond Link's house.",
    "playthrough": false
  },
  "image": "/images/zelda-minish-cap.png"
}
```

---

## 7. Layout

```
games/tmc/
  STATUS.md                     this file
  .gitignore                    no ROMs, no extracted assets, no build output
  upstream/tmc/                 zeldaret/tmc @ 6fb6dfb4 (detached), not vendored
  ref-picori/                   999sian/tmc @ bd06a639, evaluation only — not shipped
  pylibs/                       pycparser, unpacked from a deb (no sudo, no pip)
  tools/
    cdp.py                      CDP client; patched for an EPHEMERAL debug port
    pngstat.py                  stdlib PNG brightness (from pokefirered)
    save_mechanism.py           from pokefirered; kept for reference, EmulatorJS-specific
    ppm2png.py                  turns core frame dumps into something you can look at
  web/
    Makefile                    all / test / selftest / browsercheck / check
    src/shim.c                  mCore -> JS surface (EEPROM-sized, bus reads)
    src/index.html              the page
    test/tmcstate.mjs           symbol + struct-offset table, with falsification checks
    test/core-smoke.mjs         22 core checks (VJ_DUMP=dir for PPM frames)
    test/browser_check.py       18 checks against the real page in headless Chrome
    test/explore.mjs            dev tool: scripted input plans + state trace
    test/build/tmc.sym          generated from tmc.elf by the Makefile (gitignored)
    dist/                       build output (gitignored)
```

### Things that cost time, so they are written down

- **The staircase out of Link's bedroom is a ~20-pixel gap and diagonals slide past it.**
  Holding `UP+LEFT` never enters it. What works is anchoring at the left wall, then alternating
  a 70-frame `UP` hold with a 14-frame `RIGHT` step. Thirty-two thousand frames of random
  wandering never found it; a deliberate comb found it in about 1,100.
- **A held direction never clears a text box, and a frozen player looks exactly like a broken
  input path.** The first differential-input check read `dx = 0` and looked like the shim was
  not wiring the pad through. It was dialogue.
- **A multi-phase input plan needs a session-wide frame counter.** Passing a per-call index made
  the opening plan restart its phases on every `run()` call, silently shifting the whole
  timeline. That surfaced much later as "the player does not respond to the pad".
- **A restored savestate has not repainted the video buffer**, so hashing the frame immediately
  after `loadState` compares against the last frame drawn *before* the restore and fails for a
  reason that has nothing to do with savestates. Run one frame first.
- **mGBA reports `AUTODETECT` for the save type until the game first drives the EEPROM**, so
  asserting the media right after `loadROM` always fails.
- **`pngstat.luma()` takes its crop box as fractions of the image and returns a dict**, not
  pixels and a float.
