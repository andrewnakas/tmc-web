/* The Legend of Zelda: The Minish Cap — browser target, mGBA mCore shim.
 *
 * Exposes a small C surface to JS. Deliberately has no SDL, no filesystem and
 * no audio device: the page owns the canvas and (only if the user asks) the
 * AudioContext. The ROM arrives as bytes from an <input type=file> and is never
 * written anywhere but linear memory.
 *
 * Adapted from the pokeruby browser target in this fleet. Two things differ and
 * both matter:
 *
 *   1. Minish Cap's save media is EEPROM, not flash. The cartridge string is
 *      EEPROM_V124 and the chip is 8 KiB, so SAVE_BYTES is 8192 -- see the note
 *      on it below, because getting this wrong is silent.
 *   2. This shim can read the emulated bus (vj_bus_read*). The gameplay test
 *      gates "played" on the game's own state at addresses taken from the
 *      symbol table of the ROM we just built, not on what a screenshot looks
 *      like.
 */

#include <mgba/core/core.h>
#include <mgba/core/config.h>
#include <mgba/core/log.h>
#include <mgba/gba/core.h>
#include <mgba/internal/gba/gba.h>
#include <mgba-util/vfs.h>
#include <mgba-util/audio-buffer.h>
#include <mgba-util/image.h>

#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define VID_W 240
#define VID_H 160

/* The Minish Cap is EEPROM_V124 -- a 64 Kbit (8 KiB) EEPROM. This size is
 * exact, not "big enough": mGBA picks the save media partly from the size of
 * the buffer it is handed, so oversizing it (e.g. copying pokeruby's 128 KiB
 * FLASH1M figure) makes it attach the wrong chip. mGBA starts at EEPROM512 and
 * promotes to the 8 KiB part via _ensureEeprom() once the game issues a 14-bit
 * address; with 8192 bytes already here, that promotion remaps inside this same
 * buffer and never has to truncate, so the bytes stay live for the page to
 * mirror. vj_save_type() reports what mGBA actually settled on, so the test can
 * assert the promotion happened rather than assuming it. */
#define SAVE_BYTES (8 * 1024)

static struct mCore* core = NULL;
static mColor* vbuf = NULL;

/* The core keeps referencing the ROM VFile for the whole session, so this copy
 * has to outlive vj_load_rom(). Same for the save buffer. */
static uint8_t* rom = NULL;
static size_t romLen = 0;
static struct VFile* romVf = NULL;

static uint8_t* save = NULL;
static struct VFile* saveVf = NULL;

static int16_t* abuf = NULL;   /* interleaved stereo, drained by JS */
static size_t abufFrames = 0;
static unsigned sampleRate = 0;

static uint8_t* state = NULL;
static size_t stateLen = 0;

/* Scratch for vj_read_block, so JS can pull a struct in one call. */
static uint8_t peek[4096];

static int loaded = 0;

/* ---------------------------------------------------------------- lifecycle */

/* mGBA's default logger prints every BIOS SWI and DMA to stdout, which in a
 * browser means thousands of console lines per second and a visible framerate
 * cost. Swallow everything; vj_* return values are the diagnostic surface. */
static void _quietLog(struct mLogger* logger, int category, enum mLogLevel level,
                      const char* format, va_list args) {
	UNUSED(logger);
	UNUSED(category);
	UNUSED(level);
	UNUSED(format);
	UNUSED(args);
}

static struct mLogger quietLogger = { .log = _quietLog, .filter = NULL };

EMSCRIPTEN_KEEPALIVE
int vj_init(void) {
	if (core) {
		return 1;
	}
	mLogSetDefaultLogger(&quietLogger);
	core = GBACoreCreate();
	if (!core) {
		return 0;
	}
	if (!core->init(core)) {
		core->deinit(core);
		core = NULL;
		return 0;
	}
	/* core->config holds hash tables that mCore reads during reset()
	 * (_GBACoreReset -> mCoreConfigGetBoolValue). GBACoreCreate does not
	 * initialise them, so without this reset() walks a garbage table and traps
	 * on an out-of-bounds read. Nothing is loaded from or written to disk --
	 * mCoreConfigLoad is deliberately not called. */
	mCoreConfigInit(&core->config, "tmc-web");
	core->loadConfig(core, &core->config);

	vbuf = calloc(VID_W * VID_H, sizeof(mColor));
	core->setVideoBuffer(core, vbuf, VID_W);
	core->setAudioBufferSize(core, 1024);
	sampleRate = core->audioSampleRate(core);
	abufFrames = 4096;
	abuf = calloc(abufFrames * 2, sizeof(int16_t));
	return 1;
}

/* Copies: JS may free its own view afterwards. */
EMSCRIPTEN_KEEPALIVE
int vj_load_rom(const uint8_t* data, int size) {
	if (!core || size <= 0) {
		return 0;
	}
	if (loaded) {
		core->unloadROM(core);
		loaded = 0;
	}
	free(rom);
	rom = malloc((size_t) size);
	if (!rom) {
		return 0;
	}
	memcpy(rom, data, (size_t) size);
	romLen = (size_t) size;

	romVf = VFileFromMemory(rom, romLen);
	if (!romVf || !core->loadROM(core, romVf)) {
		return 0;
	}

	if (!save) {
		save = calloc(SAVE_BYTES, 1);
	}
	saveVf = VFileFromMemory(save, SAVE_BYTES);
	core->loadSave(core, saveVf);

	core->reset(core);
	loaded = 1;
	return 1;
}

EMSCRIPTEN_KEEPALIVE
int vj_loaded(void) {
	return loaded;
}

EMSCRIPTEN_KEEPALIVE
void vj_reset(void) {
	if (core && loaded) {
		core->reset(core);
	}
}

/* ------------------------------------------------------------------- frames */

EMSCRIPTEN_KEEPALIVE
void vj_run_frame(void) {
	if (core && loaded) {
		core->runFrame(core);
	}
}

EMSCRIPTEN_KEEPALIVE
mColor* vj_framebuffer(void) {
	return vbuf;
}

EMSCRIPTEN_KEEPALIVE
int vj_width(void) { return VID_W; }

EMSCRIPTEN_KEEPALIVE
int vj_height(void) { return VID_H; }

EMSCRIPTEN_KEEPALIVE
int vj_frame_counter(void) {
	return (core && loaded) ? (int) core->frameCounter(core) : -1;
}

/* mGBA leaves alpha at 0 in some paths; ImageData needs it opaque. Done here
 * rather than in JS so the page can hand the buffer straight to putImageData. */
EMSCRIPTEN_KEEPALIVE
void vj_opaque(void) {
	uint32_t* p = (uint32_t*) vbuf;
	for (int i = 0; i < VID_W * VID_H; ++i) {
		p[i] |= 0xFF000000u;
	}
}

/* -------------------------------------------------------------------- input */

EMSCRIPTEN_KEEPALIVE
void vj_set_keys(int keys) {
	if (core && loaded) {
		core->setKeys(core, (uint32_t) keys);
	}
}

/* -------------------------------------------------------------------- audio */

EMSCRIPTEN_KEEPALIVE
int vj_sample_rate(void) { return (int) sampleRate; }

EMSCRIPTEN_KEEPALIVE
int16_t* vj_audio_buffer(void) { return abuf; }

/* Returns frames (sample pairs) written into vj_audio_buffer(). JS only calls
 * this when the user has unmuted; otherwise the buffer is simply never drained
 * and mGBA's ring overwrites itself, which costs nothing. */
EMSCRIPTEN_KEEPALIVE
int vj_drain_audio(int maxFrames) {
	if (!core || !loaded) {
		return 0;
	}
	if (maxFrames > (int) abufFrames) {
		maxFrames = (int) abufFrames;
	}
	struct mAudioBuffer* ab = core->getAudioBuffer(core);
	if (!ab) {
		return 0;
	}
	size_t got = mAudioBufferRead(ab, abuf, (size_t) maxFrames);
	return (int) got;
}

/* --------------------------------------------------- cartridge EEPROM (save) */

EMSCRIPTEN_KEEPALIVE
uint8_t* vj_save_buffer(void) { return save; }

EMSCRIPTEN_KEEPALIVE
int vj_save_size(void) { return SAVE_BYTES; }

/* What mGBA actually attached, as the GBASavedataType enum. The test asserts
 * this rather than trusting SAVE_BYTES: EEPROM512 here would mean the 8 KiB
 * promotion never happened and only the first 512 bytes are real. */
EMSCRIPTEN_KEEPALIVE
int vj_save_type(void) {
	if (!core || !loaded || !core->board) {
		return -1;
	}
	return (int) ((struct GBA*) core->board)->memory.savedata.type;
}

/* Cheap change detector so the page can persist only when the cartridge save
 * actually moved, instead of writing to IndexedDB on a timer. */
EMSCRIPTEN_KEEPALIVE
unsigned vj_save_hash(void) {
	if (!save) {
		return 0;
	}
	unsigned h = 2166136261u;
	for (int i = 0; i < SAVE_BYTES; ++i) {
		h = (h ^ save[i]) * 16777619u;
	}
	return h;
}

/* How many bytes of the EEPROM are not erased (0x00/0xFF). A fresh cartridge
 * reads back all 0xFF, so a non-zero figure here means the game has written
 * something -- used to tell "the page restored a save" from "the page restored
 * 8 KiB of nothing". */
EMSCRIPTEN_KEEPALIVE
int vj_save_nonblank(void) {
	if (!save) {
		return 0;
	}
	int n = 0;
	for (int i = 0; i < SAVE_BYTES; ++i) {
		if (save[i] != 0xFF && save[i] != 0x00) {
			++n;
		}
	}
	return n;
}

/* Must be called before vj_load_rom(): mGBA reads the buffer when the save
 * media is attached. */
EMSCRIPTEN_KEEPALIVE
int vj_save_restore(const uint8_t* data, int size) {
	if (!save) {
		save = calloc(SAVE_BYTES, 1);
	}
	if (!data || size <= 0) {
		return 0;
	}
	if (size > SAVE_BYTES) {
		size = SAVE_BYTES;
	}
	memcpy(save, data, (size_t) size);
	return size;
}

/* ------------------------------------------------------------- savestates */

EMSCRIPTEN_KEEPALIVE
int vj_state_size(void) {
	return (core && loaded) ? (int) core->stateSize(core) : 0;
}

EMSCRIPTEN_KEEPALIVE
uint8_t* vj_state_save(void) {
	if (!core || !loaded) {
		return NULL;
	}
	size_t n = core->stateSize(core);
	if (n != stateLen) {
		free(state);
		state = malloc(n);
		stateLen = n;
	}
	if (!core->saveState(core, state)) {
		return NULL;
	}
	return state;
}

EMSCRIPTEN_KEEPALIVE
int vj_state_load(const uint8_t* data, int size) {
	if (!core || !loaded || !data) {
		return 0;
	}
	if ((size_t) size != core->stateSize(core)) {
		return 0;
	}
	return core->loadState(core, data) ? 1 : 0;
}

/* ------------------------------------------------------ emulated memory bus */

/* Reads through mCore's bus, which is how the gameplay test looks at the game's
 * own variables. The addresses it uses come from `arm-none-eabi-nm` on the ELF
 * this project built -- gMain, gRoomControls, gPlayerEntity -- never from a
 * wiki or a published memory map. */

EMSCRIPTEN_KEEPALIVE
int vj_bus_read8(unsigned addr) {
	return (core && loaded) ? (int) core->busRead8(core, addr) : -1;
}

EMSCRIPTEN_KEEPALIVE
int vj_bus_read16(unsigned addr) {
	return (core && loaded) ? (int) core->busRead16(core, addr) : -1;
}

EMSCRIPTEN_KEEPALIVE
unsigned vj_bus_read32(unsigned addr) {
	return (core && loaded) ? core->busRead32(core, addr) : 0u;
}

EMSCRIPTEN_KEEPALIVE
uint8_t* vj_peek_buffer(void) { return peek; }

/* Pulls up to sizeof(peek) bytes into vj_peek_buffer() in one call. Returns the
 * number of bytes read. */
EMSCRIPTEN_KEEPALIVE
int vj_read_block(unsigned addr, int len) {
	if (!core || !loaded || len <= 0) {
		return 0;
	}
	if (len > (int) sizeof(peek)) {
		len = (int) sizeof(peek);
	}
	for (int i = 0; i < len; ++i) {
		peek[i] = (uint8_t) core->busRead8(core, addr + (unsigned) i);
	}
	return len;
}

/* ------------------------------------------------------------------ probes */

/* Mean luma over the frame. The page's self-test uses this to tell "the core is
 * running" from "the core is running and something is actually on screen" --
 * a black frame compiles and ticks just fine. This is the core's own copy of
 * the framebuffer in linear memory, NOT a readback of a WebGL canvas, so it
 * does not hit the preserveDrawingBuffer false-black trap. */
EMSCRIPTEN_KEEPALIVE
double vj_mean_luma(void) {
	if (!vbuf) {
		return -1.0;
	}
	const uint8_t* p = (const uint8_t*) vbuf;
	double acc = 0.0;
	for (int i = 0; i < VID_W * VID_H; ++i) {
		acc += 0.2126 * p[i * 4 + 0] + 0.7152 * p[i * 4 + 1] + 0.0722 * p[i * 4 + 2];
	}
	return acc / (VID_W * VID_H);
}

/* FNV-1a of the visible frame, for comparing two frames exactly (savestate
 * round-trip checks). */
EMSCRIPTEN_KEEPALIVE
unsigned vj_frame_hash(void) {
	if (!vbuf) {
		return 0;
	}
	const uint8_t* p = (const uint8_t*) vbuf;
	unsigned h = 2166136261u;
	for (int i = 0; i < VID_W * VID_H * 4; ++i) {
		h = (h ^ p[i]) * 16777619u;
	}
	return h;
}

/* Game title and code from the cartridge header, so the page can say which ROM
 * it got (and refuse one that is not Minish Cap) without JS parsing the header.
 * USA retail is "GBAZELDA MC" / "BZME". */
EMSCRIPTEN_KEEPALIVE
const char* vj_game_title(void) {
	static char title[17];
	memset(title, 0, sizeof(title));
	if (rom && romLen >= 0xB0) {
		memcpy(title, rom + 0xA0, 12);
		memcpy(title + 12, rom + 0xAC, 4);
		/* The Minish Cap's title field is "GBAZELDA MC\0" -- NUL-padded at byte
		 * 11. Left alone, the C string would stop there and the four-character
		 * game code at index 12 would never be visible to JS. Pad with spaces
		 * so the layout is always 12 + 4. */
		for (int i = 0; i < 12; ++i) {
			if (!title[i]) {
				title[i] = ' ';
			}
		}
	}
	return title;
}

EMSCRIPTEN_KEEPALIVE
int vj_rom_revision(void) {
	/* Header byte 0xBC is the version/revision number. USA retail is 0. */
	return (rom && romLen > 0xBC) ? rom[0xBC] : -1;
}
