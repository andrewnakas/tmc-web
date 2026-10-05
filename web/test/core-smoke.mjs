/* Core-level test for the Minish Cap browser target, outside a browser.
 *
 * Isolates "does the mGBA shim work" from "does the page work", and does the
 * expensive parts of the gameplay and save evidence here because node is ~100x
 * faster than driving a headless browser frame by frame.
 *
 * Audio is silent by construction: node has no audio device, and the shim's
 * audio buffer is never drained.
 *
 *   node core-smoke.mjs <rom> <symfile>
 *   VJ_DUMP=<dir> node core-smoke.mjs ...     also write PPM frames to look at
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	loadSymbols, addresses, readState, sanityCheck,
	TASK, KEY, SAVEDATA_TYPE, SAVEDATA_EEPROM, OFF
} from './tmcstate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const createGBA = require(resolve(here, 'core-node.js'));

const romPath = process.argv[2];
const symPath = process.argv[3] || resolve(here, 'build/tmc.sym');
if (!romPath) {
	console.error('usage: node core-smoke.mjs <rom> [symfile]');
	process.exit(2);
}

const rom = readFileSync(romPath);
const A = addresses(loadSymbols(symPath));

let failures = 0;
function ok(cond, msg, detail) {
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${detail ? '  [' + detail + ']' : ''}`);
	if (!cond) { failures++; }
}

const dumpDir = process.env.VJ_DUMP;
if (dumpDir) { mkdirSync(dumpDir, { recursive: true }); }

/* ------------------------------------------------------------------ session */

async function session() {
	const M = await createGBA();
	const w = (n, r, a) => M.cwrap(n, r, a);
	const api = {
		init: w('vj_init', 'number', []),
		loadRom: w('vj_load_rom', 'number', ['number', 'number']),
		runFrame: w('vj_run_frame', null, []),
		setKeys: w('vj_set_keys', null, ['number']),
		framebuffer: w('vj_framebuffer', 'number', []),
		opaque: w('vj_opaque', null, []),
		meanLuma: w('vj_mean_luma', 'number', []),
		frameHash: w('vj_frame_hash', 'number', []),
		busRead8: w('vj_bus_read8', 'number', ['number']),
		busRead16: w('vj_bus_read16', 'number', ['number']),
		busRead32: w('vj_bus_read32', 'number', ['number']),
		saveBuffer: w('vj_save_buffer', 'number', []),
		saveSize: w('vj_save_size', 'number', []),
		saveType: w('vj_save_type', 'number', []),
		saveRestore: w('vj_save_restore', 'number', ['number', 'number']),
		stateSize: w('vj_state_size', 'number', []),
		stateSave: w('vj_state_save', 'number', []),
		stateLoad: w('vj_state_load', 'number', ['number', 'number']),
		title: w('vj_game_title', 'string', []),
		revision: w('vj_rom_revision', 'number', []),
		sampleRate: w('vj_sample_rate', 'number', [])
	};

	if (!api.init()) { throw new Error('vj_init failed'); }

	const self = {
		M, api,
		restoreSave(bytes) {
			const p = M._malloc(bytes.length);
			M.HEAPU8.set(bytes, p);
			const n = api.saveRestore(p, bytes.length);
			M._free(p);
			return n;
		},
		load() {
			const p = M._malloc(rom.length);
			M.HEAPU8.set(rom, p);
			const okk = api.loadRom(p, rom.length);
			M._free(p);
			return okk;
		},
		/* `frame` is session-wide on purpose. Passing a per-call index would make
		 * a multi-phase plan like OPENING restart its phases on every run()
		 * call, which silently shifts the whole opening timeline -- the sort of
		 * bug that shows up later as "the player does not respond to the pad". */
		frame: 0,
		run(frames, plan, sink) {
			for (let i = 0; i < frames; i++) {
				const f = self.frame++;
				api.setKeys(plan ? plan(f) : 0);
				api.runFrame();
				if (sink && i % 10 === 0) { sink(readState(api, A), f); }
			}
		},
		state() { return readState(api, A); },
		/* SaveFile.name, include/save.h: `/*0x080*\/ char name[FILENAME_LENGTH]`
		 * -- in the live copy at gSave. The charmap (charmap.txt) is ASCII for
		 * the letters, so no decoding table is needed. */
		saveName() {
			let s = '';
			for (let i = 0; i < 6; i++) {
				const c = api.busRead8(A.gSave + 0x80 + i);
				s += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
			}
			return s;
		},
		eeprom() {
			const p = api.saveBuffer();
			return Buffer.from(M.HEAPU8.subarray(p, p + api.saveSize()));
		},
		dump(tag) {
			if (!dumpDir) { return; }
			api.opaque();
			const base = api.framebuffer();
			const px = M.HEAPU8.subarray(base, base + 240 * 160 * 4);
			const body = Buffer.alloc(240 * 160 * 3);
			for (let i = 0; i < 240 * 160; i++) {
				body[i * 3] = px[i * 4];
				body[i * 3 + 1] = px[i * 4 + 1];
				body[i * 3 + 2] = px[i * 4 + 2];
			}
			writeFileSync(`${dumpDir}/${tag}.ppm`,
				Buffer.concat([Buffer.from('P6\n240 160\n255\n'), body]));
		}
	};
	return self;
}

/* ------------------------------------------------------------- input plans */

const mash = (k) => (f) => ((f % 16) < 6 ? k : 0);

/* Opening: mash A through the logos and the legend, START to confirm the name
 * on the ENTER A NAME keyboard (A alone only types more letters, so the name
 * ends up AAAAAA), then A again through the wake-up dialogue. */
const OPENING = (f) => (f < 900 ? mash(KEY.A)(f) : f < 1400 ? mash(KEY.START)(f) : mash(KEY.A)(f));

/* Walk up the staircase out of the starting room.
 *
 * The stairs are a ~20-pixel-wide gap in the top wall and nothing else in the
 * room is walkable through, so the approach has to be deliberate: hold LEFT
 * until Link is against the left wall (a known x, rather than wherever the
 * previous check left him), then alternate "hold UP" with a short step RIGHT.
 * One of those UP phases lines up with the gap and he climbs out.
 *
 * Holding UP+RIGHT diagonally does NOT work -- he slides across the opening
 * without ever pushing into it. That cost an hour, so it is written down. */
function stairComb(from) {
	const steps = [[from, KEY.LEFT]];
	let t = from + 240;
	for (let i = 0; i < 24; i++) {
		steps.push([t, KEY.UP]); t += 70;
		steps.push([t, KEY.RIGHT]); t += 14;
	}
	return (f) => {
		let k = KEY.UP;
		for (const [at, key] of steps) { if (f >= at) { k = key; } }
		return k;
	};
}

/* ---------------------------------------------------------------- the test */

console.log(`# core-smoke  rom=${romPath}`);
console.log(`# symbols: ${Object.entries(A).map(([k, v]) => k + '=0x' + v.toString(16)).join(' ')}`);

/* ---- stage 1: boot, identify, play the opening ---------------------------- */

const s1 = await session();
ok(s1.load(), 'mGBA accepted the ROM');
const hdr = s1.api.title();
ok(hdr.slice(0, 12).trim() === 'GBAZELDA MC' && hdr.slice(12) === 'BZME',
	'cartridge header is GBAZELDA MC / BZME (USA retail)', JSON.stringify(hdr));
ok(s1.api.revision() === 0, 'header revision byte is 0 (USA retail)', String(s1.api.revision()));

const samples = [];
s1.run(900, OPENING, (s) => samples.push(s));
s1.dump('01-opening');
s1.run(500, OPENING, (s) => samples.push(s));
s1.dump('02-opening-cutscene');
/* Long enough to clear the wake-up dialogue as well: while a text box is up the
 * player is frozen, and a "does the pad move Link" check run too early reads
 * zero and looks like a broken input path. */
s1.run(8200, OPENING, (s) => samples.push(s));
s1.dump('03-in-control');

const offsetProblems = sanityCheck(samples);
ok(offsetProblems.length === 0,
	'struct offsets stand up to their own falsification checks',
	offsetProblems.join('; ') || `${samples.length} samples`);

const tasksSeen = [...new Set(samples.map((s) => s.task))];
ok(tasksSeen.includes(TASK.TITLE) && tasksSeen.includes(TASK.FILE_SELECT)
	&& tasksSeen.includes(TASK.GAME),
	'went TITLE -> FILE_SELECT -> GAME through the real file-select flow',
	'tasks seen: ' + tasksSeen.join(','));

const st1 = s1.state();
ok(st1.task === TASK.GAME, 'ended the opening in TASK_GAME', st1.taskName);
ok(s1.saveName() === 'AAAAAA',
	'the name typed on the ENTER A NAME keyboard is in gSave.name',
	JSON.stringify(s1.saveName()));
ok(s1.api.saveType() === SAVEDATA_EEPROM,
	'mGBA attached the 8 KiB EEPROM (EEPROM_V124), not the 512-byte part',
	SAVEDATA_TYPE[s1.api.saveType()]);
ok(s1.api.saveSize() === 8192, 'save buffer is exactly 8192 bytes',
	String(s1.api.saveSize()));
ok(s1.api.meanLuma() > 20, 'something is actually on screen',
	'mean luma ' + s1.api.meanLuma().toFixed(1));

/* ---- stage 2: the player is under MY control, not watching a cutscene ----- */
/* A screenshot cannot tell play from a scripted sequence. A differential test
 * can: hold LEFT, then hold RIGHT, and check the position moves the opposite
 * way each time. Nothing the game drives by itself tracks the pad like that.
 * (The retail ROM has no attract demo at all -- see the note in tmcstate.mjs --
 * but this is the check that would catch one.) */

const before = s1.state();
s1.run(120, () => KEY.LEFT);
const afterLeft = s1.state();
s1.run(120, () => KEY.RIGHT);
const afterRight = s1.state();
const dLeft = afterLeft.px - before.px;
const dRight = afterRight.px - afterLeft.px;
ok(dLeft < 0 && dRight > 0,
	'the player responds to the pad: LEFT moves -x, RIGHT moves +x',
	`dx(LEFT)=${dLeft} dx(RIGHT)=${dRight}`);

/* ---- stage 3: leave the starting room by the staircase -------------------- */

const roomsSeen = new Set([`${st1.area}/${st1.room}`]);
let leftStartRoom = false;
const startRoom = `${st1.area}/${st1.room}`;
s1.run(2500, stairComb(s1.frame), (s) => {
	roomsSeen.add(`${s.area}/${s.room}`);
	if (`${s.area}/${s.room}` !== startRoom && s.task === TASK.GAME) { leftStartRoom = true; }
});
s1.dump('04-after-stairs');
ok(leftStartRoom,
	'walked out of the starting room under scripted input (up the staircase)',
	'rooms visited while in control: ' + [...roomsSeen].join(' '));

/* ---- stage 4: savestate round trip ---------------------------------------- */

const stPtr = s1.api.stateSave();
const stLen = s1.api.stateSize();
ok(stPtr !== 0 && stLen > 0, 'savestate taken', `${stLen} bytes`);
const snapshot = Buffer.from(s1.M.HEAPU8.subarray(stPtr, stPtr + stLen));

function restore() {
	const sp = s1.M._malloc(snapshot.length);
	s1.M.HEAPU8.set(snapshot, sp);
	const r = s1.api.stateLoad(sp, snapshot.length);
	s1.M._free(sp);
	return r;
}

/* Compare like for like. loadState restores the emulated machine but does not
 * repaint the video buffer, so the hash immediately after a restore is still
 * the LAST frame drawn before it -- comparing that against the pre-divergence
 * hash fails for a reason that has nothing to do with the savestate. Run one
 * frame from the restored state and compare that instead. */
s1.run(1, () => 0);
const hashAfterOne = s1.api.frameHash();
restore();
s1.run(240, () => KEY.DOWN);
const diverged = s1.api.frameHash() !== hashAfterOne;
const restored = restore();
s1.run(1, () => 0);
ok(diverged, 'the picture changed during the divergence window (so the check is live)');
ok(restored === 1 && s1.api.frameHash() === hashAfterOne,
	'savestate restored the machine: one frame from the restored state is bit-identical');

/* ---- stage 5: the save, validated by the game itself ---------------------- */
/* A byte comparison across a reload CANNOT tell a complete save from a
 * half-written one. So the save is handed back to the game and the game's own
 * loader is asked to accept it: src/save.c's ReadSaveFile -> VerifyChecksum
 * checks two checksum words and the 'MCZ3' magic before gSave is populated.
 *
 * The signal is behavioural and needs no reimplementation of that checksum:
 * replay stage 2 with **A only**. From a valid file, A on the file select
 * enters the game. From an empty or rejected slot, A starts a new file and
 * lands on the ENTER A NAME keyboard, where A only types more letters -- the
 * run stalls in TASK_FILE_SELECT forever. */

const eeprom = s1.eeprom();
ok(eeprom.some((b) => b !== 0xFF && b !== 0x00),
	'the game wrote something to the cartridge EEPROM',
	eeprom.filter((b) => b !== 0xFF && b !== 0x00).length + ' non-erased bytes');

async function bootWithSave(bytes, label) {
	const s = await session();
	s.restoreSave(bytes);                 /* BEFORE loadROM: mGBA reads it when
	                                       * it attaches the save media */
	s.load();
	const tasks = new Set();
	s.run(9000, mash(KEY.A), (st) => tasks.add(st.task));
	const st = s.state();
	return { s, st, tasks: [...tasks], name: s.saveName(), label };
}

const reload = await bootWithSave(eeprom, 'restored');
reload.s.dump('05-after-reload');
ok(reload.st.task === TASK.GAME,
	'after a fresh boot with the stored EEPROM, A alone continues into the game '
	+ '(so the game accepted the save: no name entry)',
	`task=${reload.st.taskName}`);
ok(reload.name === 'AAAAAA',
	'the reloaded file is the one this test created',
	JSON.stringify(reload.name));
ok(reload.st.area === st1.area,
	'resumed in the area the file was saved in',
	`area=0x${reload.st.area.toString(16)} expected 0x${st1.area.toString(16)}`);

/* ---- stage 6: controls -- prove this detector is able to say NO ----------- */
/* Two arms that MUST fail. Without them, "the save loaded" would be
 * unfalsifiable: a test that passes on a blank cartridge measures nothing. */

const blank = Buffer.alloc(eeprom.length, 0xFF);
const ctlBlank = await bootWithSave(blank, 'blank');
ok(ctlBlank.st.task !== TASK.GAME,
	'CONTROL: a blank cartridge does NOT continue into the game (stalls at file select)',
	`task=${ctlBlank.st.taskName}`);

const corrupt = Buffer.from(eeprom);
for (let i = 0; i < corrupt.length; i += 8) { corrupt[i] ^= 0xA5; }
const ctlCorrupt = await bootWithSave(corrupt, 'corrupt');
ok(ctlCorrupt.st.task !== TASK.GAME,
	'CONTROL: a corrupted save is rejected by the game and does NOT continue',
	`task=${ctlCorrupt.st.taskName}`);

/* Informational, not a pass/fail: The Minish Cap keeps TWO copies of every save
 * file with two checksum records each (src/save.c DataDoubleWriteWithStatus).
 * Blanking the back half of the EEPROM therefore still loads, because copy 1
 * survives. Recorded because it is exactly the kind of redundancy that makes a
 * naive byte-comparison test look like it passed. */
const half = Buffer.from(eeprom);
half.fill(0xFF, half.length / 2);
const ctlHalf = await bootWithSave(half, 'half');
console.log(`NOTE  blanking the back half of the EEPROM still loads `
	+ `(task=${ctlHalf.st.taskName}) -- the game keeps a second redundant copy, `
	+ `so this is correct behaviour, not a weak check`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
