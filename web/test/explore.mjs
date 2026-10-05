/* Scratch explorer: run the ROM with a scripted input plan and print the
 * game's own state over time. Used to find out what the opening actually needs
 * before writing it into the real test. Muted by construction (node has no
 * audio device and the audio buffer is never drained).
 *
 *   node explore.mjs <rom> <sym> <frames> [planName]
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSymbols, addresses, readState, KEY, SAVEDATA_TYPE } from './tmcstate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const createGBA = require(resolve(here, 'core-node.js'));

const [romPath, symPath, framesArg, planName] = process.argv.slice(2);
const frames = Number(framesArg || 3000);

const rom = readFileSync(romPath);
const M = await createGBA();
const api = {
	init: M.cwrap('vj_init', 'number', []),
	loadRom: M.cwrap('vj_load_rom', 'number', ['number', 'number']),
	runFrame: M.cwrap('vj_run_frame', null, []),
	setKeys: M.cwrap('vj_set_keys', null, ['number']),
	meanLuma: M.cwrap('vj_mean_luma', 'number', []),
	frameHash: M.cwrap('vj_frame_hash', 'number', []),
	busRead8: M.cwrap('vj_bus_read8', 'number', ['number']),
	busRead16: M.cwrap('vj_bus_read16', 'number', ['number']),
	busRead32: M.cwrap('vj_bus_read32', 'number', ['number']),
	saveType: M.cwrap('vj_save_type', 'number', []),
	saveNonblank: M.cwrap('vj_save_nonblank', 'number', []),
	saveHash: M.cwrap('vj_save_hash', 'number', []),
	title: M.cwrap('vj_game_title', 'string', []),
	framebuffer: M.cwrap('vj_framebuffer', 'number', []),
	opaque: M.cwrap('vj_opaque', null, [])
};

if (!api.init()) { throw new Error('vj_init failed'); }
const p = M._malloc(rom.length);
M.HEAPU8.set(rom, p);
if (!api.loadRom(p, rom.length)) { throw new Error('vj_load_rom failed'); }
M._free(p);
console.log(`title="${api.title()}"`);

const A = addresses(loadSymbols(symPath));
console.log('addresses:', Object.entries(A).map(([k, v]) => `${k}=0x${v.toString(16)}`).join(' '));

/* Input plans. A press has to be held for a few frames and then released with
 * real frames in between: an edge the core never polls is an edge the game
 * never saw. */
function mash(key) { return (f) => ((f % 16) < 6 ? key : 0); }

/* A plan is a list of [fromFrame, fn]; the last entry whose fromFrame has been
 * reached wins. `planName` may instead be a spec like "0:A,900:START,1400:DOWN"
 * so a new idea can be tried without editing this file. */
/* Deterministic wander: a seeded PRNG picks a direction every 120 frames and
 * mashes A in between, so dialogue gets cleared and the room gets explored.
 * Seeded so a find can be replayed exactly. */
function wander(seed) {
	let st = seed >>> 0;
	const rnd = () => (st = (st * 1664525 + 1013904223) >>> 0) / 4294967296;
	const dirs = [KEY.UP, KEY.DOWN, KEY.LEFT, KEY.RIGHT];
	let cur = dirs[0], until = 0;
	return (f) => {
		if (f >= until) { cur = dirs[(rnd() * 4) | 0]; until = f + 90 + ((rnd() * 120) | 0); }
		const ph = f % 200;
		if (ph >= 150) { return (f % 16) < 6 ? KEY.A : 0; }
		return cur;
	};
}

const PLANS = {
	mashA: [[0, mash(KEY.A)]],
	none: [[0, () => 0]]
};
for (let i = 1; i <= 8; i++) { PLANS['wander' + i] = [[0, mash(KEY.A)], [900, mash(KEY.START)], [1400, mash(KEY.A)], [8000, wander(i * 7919)]]; }

function compile(spec) {
	if (PLANS[spec]) return PLANS[spec];
	return spec.split(',').map((part) => {
		const [at, name] = part.split(':');
		if (name.startsWith('WANDER')) {
			return [Number(at), wander(Number(name.slice(6) || 1) * 7919)];
		}
		// "DOWN~A": alternate holding DOWN for 150 frames with mashing A for 90.
		// Walking and clearing dialogue have to be interleaved, because a text
		// box freezes the player and a held direction never dismisses it.
		if (name.includes('~')) {
			const [a, b] = name.split('~');
			const ca = a.split('+').reduce((acc, n) => acc | (KEY[n] ?? 0), 0);
			const cb = b.split('+').reduce((acc, n) => acc | (KEY[n] ?? 0), 0);
			return [Number(at), (f) => ((f % 240) < 150 ? ca : ((f % 16) < 6 ? cb : 0))];
		}
		const hold = name.endsWith('!');
		const combo = name.replace(/!$/, '').split('+').reduce((acc, n) => acc | (KEY[n] ?? 0), 0);
		return [Number(at), hold ? () => combo : mash(combo)];
	});
}
const steps = compile(planName || 'mashA');
function plan(f) {
	let fn = steps[0][1];
	for (const [at, g] of steps) { if (f >= at) fn = g; }
	return fn(f);
}

const dumpDir = process.env.VJ_DUMP;
if (dumpDir) mkdirSync(dumpDir, { recursive: true });
function dump(tag) {
	if (!dumpDir) return;
	api.opaque();
	const base = api.framebuffer();
	const px = M.HEAPU8.subarray(base, base + 240 * 160 * 4);
	const body = Buffer.alloc(240 * 160 * 3);
	for (let i = 0; i < 240 * 160; i++) {
		body[i * 3] = px[i * 4]; body[i * 3 + 1] = px[i * 4 + 1]; body[i * 3 + 2] = px[i * 4 + 2];
	}
	writeFileSync(`${dumpDir}/${tag}.ppm`, Buffer.concat([Buffer.from('P6\n240 160\n255\n'), body]));
}

let last = '';
const seen = new Set();
for (let f = 0; f < frames; f++) {
	api.setKeys(plan(f));
	api.runFrame();
	const trace = Number(process.env.VJ_TRACE || 0);
	if (trace && f % trace === 0) {
		const s2 = readState(api, A);
		console.log(`  t f=${f} keys=${plan(f)} area=0x${s2.area.toString(16)} room=0x${s2.room.toString(16)} p=(${s2.px},${s2.py}) screen=(${s2.px - s2.origin_x},${s2.py - s2.origin_y}) sub=${s2.substate} luma=${api.meanLuma().toFixed(0)} sv=${api.saveHash()>>>0} nb=${api.saveNonblank()}`);
	}
	const every = Number(process.env.VJ_DUMP_EVERY || 0);
	if (every && f % every === 0) { dump(`t${String(f).padStart(5, '0')}`); }
	if (f % 10 === 0 || f === frames - 1) {
		const s = readState(api, A);
		const key = `${s.task}/${s.state}/${s.substate}/${s.area}/${s.room}`;
		if (key !== last) {
			console.log(`f=${String(f).padStart(5)} task=${s.taskName}(${s.task}) ` +
				`state=${s.state} sub=${s.substate} area=0x${s.area.toString(16)} ` +
				`room=0x${s.room.toString(16)} room=${s.roomW}x${s.roomH} ` +
				`player=(${s.px},${s.py}) luma=${api.meanLuma().toFixed(1)} ` +
				`mute=${s.muteAudio} saveType=${SAVEDATA_TYPE[api.saveType()]} ` +
				`saveNonblank=${api.saveNonblank()}`);
			last = key;
			if (!seen.has(key)) { seen.add(key); dump(`f${String(f).padStart(5, '0')}_${key.replace(/\//g, '-')}`); }
		}
	}
}
const s = readState(api, A);
console.log('FINAL', JSON.stringify(s), 'saveNonblank=' + api.saveNonblank(),
	'saveType=' + SAVEDATA_TYPE[api.saveType()]);
dump('final');
