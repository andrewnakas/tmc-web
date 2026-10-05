/* Reading The Minish Cap's own game state out of the emulated bus.
 *
 * Why this file exists: a screenshot cannot tell you whether a GBA Zelda is
 * being played or is sitting on a title screen that happens to look busy, and
 * the fleet convention is to gate "played" on the game's own variables, taken
 * from the symbol table of the build you just made. So:
 *
 *   - ADDRESSES come from `arm-none-eabi-nm` on the tmc.elf this project built.
 *     They are passed in as a symbol file; nothing here is hardcoded.
 *   - STRUCT OFFSETS come from the decompilation's own headers, cited by
 *     file and field below. agbcc enforces several of them at compile time via
 *     the repo's own static_asserts.
 *   - Because an offset table is exactly the sort of thing that can be quietly
 *     wrong, sanityCheck() falsifies it at run time against facts that could
 *     not hold if the offsets were misaligned.
 *
 * One trap this game does NOT have, which is worth recording because the fleet
 * notes warn about it: there is no attract demo in the retail ROM. src/main.c
 * builds the task table with
 *
 *     #ifdef DEMO_USA
 *         [TASK_FILE_SELECT] = DemoTask,
 *     #else
 *         [TASK_FILE_SELECT] = FileSelectTask,
 *     #endif
 *
 * so DemoTask is only reachable in the kiosk demo ROMs (tmc_demo_usa /
 * tmc_demo_jp). A USA retail build has no code path that plays itself.
 */

import { readFileSync } from 'node:fs';

/* include/main.h: `typedef enum { TASK_TITLE, TASK_FILE_SELECT, TASK_GAME,
 * TASK_GAMEOVER, TASK_STAFFROLL, TASK_DEBUG } Task;` */
export const TASK = {
	TITLE: 0,
	FILE_SELECT: 1,
	GAME: 2,
	GAMEOVER: 3,
	STAFFROLL: 4,
	DEBUG: 5
};
export const TASK_NAME = ['TITLE', 'FILE_SELECT', 'GAME', 'GAMEOVER', 'STAFFROLL', 'DEBUG'];

/* Field offsets, each traceable to a declaration in the decomp's headers.
 *
 * Main (include/main.h, `typedef struct { ... } Main;`) is a run of u8s then a
 * u16, so the offsets are just the declaration order:
 *   0 interruptFlag, 1 sleepStatus, 2 task, 3 state, 4 substate, 5 field_0x5,
 *   6 muteAudio, 7 field_0x7, 8 pauseFrames, 9 pauseCount, 10 pauseInterval,
 *   11 pad, 12 ticks(u16).
 *
 * RoomControls (include/room.h) carries explicit offset comments in the source,
 * e.g. `/*0x04*\/ u8 area;` and `/*0x1E*\/ u16 width;`.
 *
 * Entity (include/entity.h) likewise: `/*0x2c*\/ union SplitWord x;` -- a
 * Q16.16 fixed-point position, so the pixel coordinate is the high half-word.
 */
export const OFF = {
	main: { task: 2, state: 3, substate: 4, muteAudio: 6, ticks: 12 },
	roomControls: { area: 4, room: 5, origin_x: 6, origin_y: 8, width: 0x1e, height: 0x20 },
	entity: { x: 0x2c, y: 0x30 }
};

/** Parse `arm-none-eabi-nm` output into { name: address }. */
export function loadSymbols(path) {
	const out = new Map();
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		// "02002a40 B gSave"  /  "0811e4bc 00000054 T gSaveFileEEPROMAddresses"
		const m = /^([0-9a-f]{8})\s+(?:[0-9a-f]{8}\s+)?(\S)\s+(\S+)$/.exec(line.trim());
		if (m) {
			out.set(m[3], parseInt(m[1], 16));
		}
	}
	return out;
}

const NEEDED = ['gMain', 'gRoomControls', 'gPlayerEntity', 'gSave', 'gArea'];

export function addresses(syms) {
	const a = {};
	for (const n of NEEDED) {
		const v = syms.get(n);
		if (v === undefined) {
			throw new Error(`symbol ${n} not in the symbol file -- regenerate it with ` +
				`arm-none-eabi-nm on the tmc.elf this project built`);
		}
		a[n] = v;
	}
	return a;
}

/** Snapshot the handful of variables the gameplay gate cares about. */
export function readState(api, a) {
	const u8 = (addr) => api.busRead8(addr);
	const u16 = (addr) => api.busRead16(addr);
	const u32 = (addr) => api.busRead32(addr);
	const task = u8(a.gMain + OFF.main.task);
	return {
		task,
		taskName: TASK_NAME[task] ?? `?${task}`,
		state: u8(a.gMain + OFF.main.state),
		substate: u8(a.gMain + OFF.main.substate),
		muteAudio: u8(a.gMain + OFF.main.muteAudio),
		ticks: u16(a.gMain + OFF.main.ticks),
		area: u8(a.gRoomControls + OFF.roomControls.area),
		room: u8(a.gRoomControls + OFF.roomControls.room),
		roomW: u16(a.gRoomControls + OFF.roomControls.width),
		roomH: u16(a.gRoomControls + OFF.roomControls.height),
		// Room position within the area. Player coordinates below are
		// area-absolute, so screen position is px - origin_x.
		origin_x: u16(a.gRoomControls + OFF.roomControls.origin_x),
		origin_y: u16(a.gRoomControls + OFF.roomControls.origin_y),
		// SplitWord: Q16.16, high half-word is the pixel coordinate.
		px: (u32(a.gPlayerEntity + OFF.entity.x) >>> 16),
		py: (u32(a.gPlayerEntity + OFF.entity.y) >>> 16)
	};
}

/**
 * Falsify the offset table rather than trusting it.
 *
 * Each of these would fail loudly if the struct offsets were misaligned, and
 * none of them can be satisfied by reading the wrong bytes except by luck:
 *
 *   - `task` must be a value in the Task enum (0..5) on every single sample. A
 *     misaligned read lands in interruptFlag/state/substate and produces values
 *     outside that range almost immediately.
 *   - at the very first frame the game must be in TASK_TITLE, because
 *     src/main.c's AgbMain enters the task table at index 0.
 *   - once in-game, the room dimensions must be a plausible pixel size: a
 *     non-zero multiple of 16, no larger than the format allows.
 *
 * Returns a list of problems; empty means the table held up.
 */
export function sanityCheck(samples) {
	const bad = [];
	const outOfRange = samples.filter((s) => s.task < 0 || s.task > 5);
	if (outOfRange.length) {
		bad.push(`gMain.task left the Task enum on ${outOfRange.length}/${samples.length} ` +
			`samples (saw ${[...new Set(outOfRange.map((s) => s.task))].join(',')}) -- ` +
			`the Main offsets do not line up`);
	}
	if (samples.length && samples[0].task !== TASK.TITLE) {
		bad.push(`first sample was task=${samples[0].taskName}, expected TITLE ` +
			`(AgbMain enters sTaskHandlers at index 0)`);
	}
	const inGame = samples.filter((s) => s.task === TASK.GAME && s.roomW > 0);
	if (inGame.length) {
		const weird = inGame.filter((s) => s.roomW % 16 || s.roomH % 16 ||
			s.roomW > 4096 || s.roomH > 4096);
		if (weird.length) {
			bad.push(`${weird.length}/${inGame.length} in-game samples had implausible room ` +
				`dimensions (e.g. ${weird[0].roomW}x${weird[0].roomH}) -- the RoomControls ` +
				`offsets do not line up`);
		}
	} else if (samples.some((s) => s.task === TASK.GAME)) {
		bad.push('reached TASK_GAME but RoomControls.width never became non-zero');
	}
	return bad;
}

/* mGBA's enum GBAKey bit positions. */
export const KEY = {
	A: 1, B: 2, SELECT: 4, START: 8,
	RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128,
	R: 256, L: 512
};

/* enum GBASavedataType, read from mGBA's include/mgba/gba/interface.h rather
 * than remembered. The Minish Cap's cartridge string is EEPROM_V124, the 8 KiB
 * part, so a healthy session must report EEPROM (4). EEPROM512 (5) would mean
 * mGBA's promotion to the 8 KiB chip never happened and only the first 512
 * bytes of the save are real -- which would look fine until a second file. */
export const SAVEDATA_TYPE = {
	'-1': 'AUTODETECT', 0: 'FORCE_NONE', 1: 'SRAM', 2: 'FLASH512',
	3: 'FLASH1M', 4: 'EEPROM', 5: 'EEPROM512', 6: 'SRAM512'
};
export const SAVEDATA_EEPROM = 4;
