#!/usr/bin/env python3
"""The real Minish Cap page, in headless Chrome, muted.

What this adds over the node core test: it exercises the page a person actually
gets -- the file picker, the File API path, IndexedDB, the run loop and a real
navigation -- rather than the core in isolation.

Design notes that are not optional on this machine:

* **Ephemeral debug port.** Ten agents share this box. A fixed --remote-debugging-port
  lets Chrome attach to somebody else's instance, and /json/list then hands back
  THEIR page, so a green run can be another agent's game. cdp.Chrome(port=0)
  reads the real port back out of DevToolsActivePort in a private profile.
* **A nonce in the URL that the page must echo.** Proves the tab being measured
  is the one this script opened.
* **Navigate away in the same tab, do not close it.** Closing a tab over CDP can
  skip beforeunload entirely, so a close/reopen "reload test" never exercises
  the unload path a person hits.
* **Brightness is measured from the screenshot the driver takes**, decoded
  outside the page. A page cannot measure its own WebGL canvas (no
  preserveDrawingBuffer) and will confidently report pure black while the game
  is plainly running.
* **The save is validated by the game, not by comparing bytes.** A byte-for-byte
  match across a reload cannot tell a complete save from a half-written one.
  This asks The Minish Cap's own loader instead, and includes a control arm that
  must fail.

    browser_check.py <rom> <symfile> [--shots DIR]
"""
import base64
import json
import os
import pathlib
import random
import subprocess
import sys
import threading
import time
import http.server
import socketserver

HERE = pathlib.Path(__file__).resolve().parent
TOOLS = HERE.parent.parent / "tools"
sys.path.insert(0, str(TOOLS))
import cdp        # noqa: E402
import pngstat    # noqa: E402

DIST = HERE.parent / "dist"

# mGBA's enum GBAKey bit positions.
KEY = {"A": 1, "B": 2, "SELECT": 4, "START": 8,
       "RIGHT": 16, "LEFT": 32, "UP": 64, "DOWN": 128, "R": 256, "L": 512}
TASK_NAME = ["TITLE", "FILE_SELECT", "GAME", "GAMEOVER", "STAFFROLL", "DEBUG"]
TASK_GAME = 2
SAVEDATA_EEPROM = 4

# include/main.h and include/room.h, the same table the node test uses.
OFF_TASK = 2
OFF_AREA, OFF_ROOM = 4, 5
SAVE_NAME = 0x80

failures = []


def check(cond, msg, detail=""):
    print(("PASS  " if cond else "FAIL  ") + msg + (("  [" + str(detail) + "]") if detail else ""))
    if not cond:
        failures.append(msg)
    return cond


def load_symbols(path):
    out = {}
    for line in open(path):
        p = line.split()
        if len(p) == 3 and len(p[0]) == 8:
            out[p[2]] = int(p[0], 16)
        elif len(p) == 4 and len(p[0]) == 8:
            out[p[3]] = int(p[0], 16)
    return out


class Server:
    """Threaded static server for dist/. Threaded matters: the page fetches its
    own .wasm while the harness is also talking to Chrome, and a single-threaded
    handler deadlocks."""

    def __init__(self, root):
        root = str(root)

        class H(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *a, **kw):
                super().__init__(*a, directory=root, **kw)

            def log_message(self, *a):
                pass

        self.httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), H)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def main():
    rom = os.path.abspath(sys.argv[1])
    sym = os.path.abspath(sys.argv[2])
    shots = None
    if "--shots" in sys.argv:
        shots = pathlib.Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)

    A = load_symbols(sym)
    for n in ("gMain", "gRoomControls", "gSave", "gPlayerEntity"):
        if n not in A:
            print("FAIL  symbol %s missing from %s" % (n, sym))
            return 2
    print("# symbols: " + " ".join("%s=0x%x" % (k, A[k])
                              for k in ("gMain", "gRoomControls", "gSave", "gPlayerEntity")))

    srv = Server(DIST)
    chrome = cdp.Chrome(port=0, headless=True)
    print("# chrome debug port %d (ephemeral), server port %d" % (chrome.port, srv.port))
    tab = None
    try:
        nonce = "n%d" % random.randrange(1 << 30)
        url = "http://127.0.0.1:%d/index.html?_t=%s" % (srv.port, nonce)
        # Open blank first and turn the Network domain on BEFORE navigating,
        # or the page's own .js/.wasm fetches happen before anything is
        # listening and the "nothing left this device" assertion is made
        # against an almost empty log.
        tab = chrome.tab("about:blank")
        tab.call("Network.enable")
        tab.goto(url)

        # --- the tab is mine -------------------------------------------------
        got = wait_for(tab, "location.search.indexOf('%s') !== -1" % nonce, 30)
        check(got, "the attached tab is the one this script opened (URL nonce echoed back)", nonce)

        check(wait_for(tab, "!!(window.__vj && window.__vj.ready)", 60),
              "the wasm core booted in the page")

        # --- the user's own file picker -------------------------------------
        tab.set_file_input("#rom-file", [rom])
        check(wait_for(tab, "!!(window.__vj && window.__vj.running)", 60),
              "the ROM went in through the real <input type=file> and the core started")

        title = tab.js("window.__vj.title()")
        check(title[:12].strip() == "GBAZELDA MC" and title[12:] == "BZME",
              "page read the cartridge header: GBAZELDA MC / BZME", repr(title))
        check(tab.js("window.__vj.revision()") == 0, "header revision byte 0 (USA retail)")
        check(tab.js("window.__vj.saveSize()") == 8192, "save buffer is 8192 bytes")
        # The save MEDIA is not decided yet: mGBA reports AUTODETECT until the
        # game first drives the EEPROM, so this is asserted after the opening.

        # --- the canvas has a size (EmulatorJS-class trap, worth asserting) --
        dims = tab.js("(function(){var c=document.getElementById('canvas');"
                      "var r=c.getBoundingClientRect();"
                      "return [c.width,c.height,Math.round(r.width),Math.round(r.height)];})()")
        check(dims[0] == 240 and dims[1] == 160 and dims[2] > 100 and dims[3] > 60,
              "the canvas is laid out at a non-zero size", dims)

        # --- audio: muted means no audio graph at all ------------------------
        check(tab.js("window.__vj.audioContextExists()") is False
              and tab.js("window.__vj.audioOn()") is False,
              "muted: no AudioContext object has been constructed")

        # --- play the opening ------------------------------------------------
        play_opening(tab)
        st = read_state(tab, A)
        check(st["task"] == TASK_GAME,
              "played the opening in the browser and reached TASK_GAME",
              "task=%s area=0x%x room=0x%x" % (TASK_NAME[st["task"]], st["area"], st["room"]))
        name = tab.js("window.__vj.readStr(%d, 6)" % (A["gSave"] + SAVE_NAME))
        check(name == "AAAAAA",
              "the name typed on the ENTER A NAME keyboard is in gSave.name", repr(name))
        stype = tab.js("window.__vj.saveType()")
        check(stype == SAVEDATA_EEPROM,
              "mGBA settled on the 8 KiB EEPROM (EEPROM_V124), not the 512-byte part",
              stype)

        # --- brightness, measured OUTSIDE the page ---------------------------
        shot = (shots or pathlib.Path(os.environ.get("TMPDIR", "/tmp"))) / "tmc-playing.png"
        tab.screenshot(shot)
        # pngstat takes the crop as FRACTIONS of the image, so convert from the
        # CSS rect using the viewport size -- the screenshot is not necessarily
        # the same pixel size as the layout box.
        frac = tab.js("(function(){var r=document.getElementById('canvas').getBoundingClientRect();"
                      "var W=window.innerWidth,H=window.innerHeight;"
                      "return [r.left/W, r.top/H, r.right/W, r.bottom/H];})()")
        frac = [max(0.0, min(1.0, v)) for v in frac]
        stat = pngstat.luma(str(shot), box=tuple(frac))
        check(stat["mean"] > 20,
              "the driver's own screenshot of the canvas is not black",
              "mean luma %.1f, %.0f%% of pixels lit, image %dx%d"
              % (stat["mean"], 100 * stat["lit"], stat["w"], stat["h"]))

        # --- under the player's control, and out of the starting room --------
        # A screenshot cannot tell play from a scripted sequence; a differential
        # input test can. (Retail Minish Cap has no attract demo at all -- the
        # task table only wires DemoTask in under #ifdef DEMO_USA -- but this is
        # the check that would catch one.)
        px = lambda: tab.js("window.__vj.read32(%d) >>> 16" % (A["gPlayerEntity"] + 0x2C))
        p0 = px(); hold(tab, 120, KEY["LEFT"])
        p1 = px(); hold(tab, 120, KEY["RIGHT"])
        p2 = px()
        check(p1 - p0 < 0 and p2 - p1 > 0,
              "the player responds to the pad in the browser: LEFT moves -x, RIGHT +x",
              "dx(LEFT)=%d dx(RIGHT)=%d" % (p1 - p0, p2 - p1))

        start_room = (st["area"], st["room"])
        rooms = {start_room}
        # Anchor at the left wall first. The staircase is a ~20px gap in the top
        # wall; combing from a known x is what makes this repeatable, and
        # starting from "wherever the last check left Link" is what makes it
        # flaky.
        hold(tab, 240, KEY["LEFT"])
        for _ in range(24):
            hold(tab, 70, KEY["UP"])
            s = read_state(tab, A)
            rooms.add((s["area"], s["room"]))
            if (s["area"], s["room"]) != start_room:
                break
            hold(tab, 14, KEY["RIGHT"])
        left_room = any(r != start_room for r in rooms)
        check(left_room,
              "walked out of the starting room in the browser (up the staircase)",
              "rooms while in control: " + " ".join("0x%x/0x%x" % r for r in sorted(rooms)))
        if shots:
            tab.screenshot(shots / "tmc-after-stairs.png")

        # --- nothing left this device ----------------------------------------
        # Asserted at the network layer from CDP's own event stream, not from
        # anything the page says about itself.
        reqs = [e["params"]["request"]["url"] for e in tab.events
                if e.get("method") == "Network.requestWillBeSent"]
        own = "http://127.0.0.1:%d/" % srv.port
        foreign = [u for u in reqs if not u.startswith(own) and not u.startswith("data:")]
        check(not foreign,
              "the page made no request off this machine; it only fetched its own files",
              "%d requests, all local: %s" % (len(reqs), sorted({u[len(own):] for u in reqs})))

        # --- flush the save, then a REAL navigation --------------------------
        tab.js("window.__vj.flushSave()")
        time.sleep(0.5)
        saved_b64 = tab.js("window.__vj.dumpSave()")
        check(isinstance(saved_b64, str) and len(saved_b64) > 100,
              "pulled the cartridge EEPROM out of the page", "%d b64 chars" % len(saved_b64))

        # Deterministic unload: dispatch the event rather than racing a real
        # navigation. A navigate-away soak is a weak detector -- it passed 8/8
        # on a page that was provably destroying its save.
        tab.js("window.dispatchEvent(new Event('pagehide'))")
        time.sleep(0.5)
        after_dispatch = tab.js("window.__vj.dumpSave()")
        check(after_dispatch == saved_b64,
              "a dispatched pagehide does not destroy the save in memory")

        ok = go_back_and_continue(tab, url, A, "reload")
        check(ok["task"] == TASK_GAME,
              "after navigating away and back, A alone continues into the game "
              "(the game itself accepted the stored save; no name entry)",
              "task=" + TASK_NAME[ok["task"]])
        check(ok["name"] == "AAAAAA",
              "the continued file is the one this run created", repr(ok["name"]))

        if shots:
            tab.screenshot(shots / "tmc-after-reload.png")

        # --- CONTROL: the same test must be able to fail ---------------------
        corrupt = bytearray(base64.b64decode(saved_b64))
        for i in range(0, len(corrupt), 8):
            corrupt[i] ^= 0xA5
        tab.js("window.__vj.overwriteStoredSave(%s)"
               % json.dumps(base64.b64encode(bytes(corrupt)).decode()), await_promise=True)
        bad = go_back_and_continue(tab, url, A, "control")
        check(bad["task"] != TASK_GAME,
              "CONTROL: with a corrupted save in browser storage the game refuses to "
              "continue (so the check above can fail)",
              "task=" + TASK_NAME[bad["task"]])

        # --- page errors ------------------------------------------------------
        errs = [m for m in tab.console() if "error" in m.lower()]
        check(not errs, "no console errors", errs[:2])

    finally:
        if tab is not None:
            try:
                tab.close()
            except Exception:
                pass
        chrome.kill()
        srv.stop()

    print("\n%s" % ("ALL CHECKS PASSED" if not failures else "%d CHECK(S) FAILED" % len(failures)))
    return 0 if not failures else 1


def wait_for(tab, expr, secs):
    end = time.time() + secs
    while time.time() < end:
        try:
            if tab.js(expr) is True:
                return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


def read_state(tab, A):
    return tab.js(
        "(function(){var v=window.__vj;return {task:v.read8(%d),area:v.read8(%d),room:v.read8(%d)};})()"
        % (A["gMain"] + OFF_TASK, A["gRoomControls"] + OFF_AREA, A["gRoomControls"] + OFF_ROOM))


def hold(tab, frames, button):
    """Hold a button for `frames` frames (pumpMash with no off phase)."""
    tab.js("window.__vj.pumpMash(%d, %d, 1, 0)" % (frames, button), timeout=300)


def mash(tab, frames, button):
    """Run frames synchronously in the page, holding `button` for 6 frames out
    of every 16. Deliberately not sleep(): a sleep hands control to the
    compositor and the number of frames actually executed becomes whatever the
    headless frame pacing felt like."""
    tab.js("window.__vj.pumpMash(%d, %d, 6, 10)" % (frames, button), timeout=300)


def play_opening(tab):
    """Same shape as the node test: mash A through the logos and the legend,
    START to confirm AAAAAA on the naming keyboard, A through the wake-up."""
    mash(tab, 900, KEY["A"])
    mash(tab, 500, KEY["START"])
    mash(tab, 8200, KEY["A"])


def continue_opening(tab):
    """A only. From a valid save this walks into the game; from an empty or
    rejected slot it stalls on the naming keyboard, where A only types more
    letters."""
    mash(tab, 9000, KEY["A"])


def go_back_and_continue(tab, url, A, label):
    """Navigate away in the SAME tab and come back, then try to continue with A
    alone. The page restores the ROM and the save from IndexedDB by itself."""
    tab.goto("about:blank")
    time.sleep(0.4)
    tab.goto(url)
    wait_for(tab, "!!(window.__vj && window.__vj.ready)", 60)
    wait_for(tab, "!!(window.__vj && window.__vj.running)", 60)   # auto-resumes cached ROM
    continue_opening(tab)
    st = read_state(tab, A)
    st["name"] = tab.js("window.__vj.readStr(%d, 6)" % (A["gSave"] + SAVE_NAME))
    print("#   %s: task=%s area=0x%x name=%r"
          % (label, TASK_NAME[st["task"]], st["area"], st["name"]))
    return st


if __name__ == "__main__":
    sys.exit(main())
