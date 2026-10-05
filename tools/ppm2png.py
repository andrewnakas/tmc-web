#!/usr/bin/env python3
"""Convert binary PPM (P6, 8-bit) to PNG. Standard library only.

The frame dumps from the core tests are PPM because that needs no encoder on
the emulator side. This turns them into something a person can open, so an
aesthetic claim can actually be looked at rather than inferred from a mean-luma
number.

    ppm2png.py in.ppm [out.png]
    ppm2png.py --scale 3 in.ppm out.png
"""
import struct
import sys
import zlib


def read_ppm(path):
    with open(path, 'rb') as f:
        data = f.read()
    # P6 header: magic, width, height, maxval -- whitespace separated, with
    # '#' comments legal anywhere in the header.
    fields = []
    i = 0
    while len(fields) < 4:
        while i < len(data) and data[i : i + 1].isspace():
            i += 1
        if data[i : i + 1] == b'#':
            while i < len(data) and data[i] != 0x0A:
                i += 1
            continue
        j = i
        while j < len(data) and not data[j : j + 1].isspace():
            j += 1
        fields.append(data[i:j])
        i = j
    i += 1  # single whitespace byte after maxval
    if fields[0] != b'P6':
        raise ValueError('not a binary PPM (P6): %r' % fields[0])
    w, h, maxval = int(fields[1]), int(fields[2]), int(fields[3])
    if maxval != 255:
        raise ValueError('only 8-bit PPM supported, got maxval=%d' % maxval)
    px = data[i : i + w * h * 3]
    if len(px) != w * h * 3:
        raise ValueError('short pixel data: %d of %d' % (len(px), w * h * 3))
    return w, h, px


def write_png(path, w, h, rgb, scale=1):
    if scale > 1:
        rows = []
        for y in range(h):
            row = rgb[y * w * 3 : (y + 1) * w * 3]
            big = bytearray()
            for x in range(w):
                big += row[x * 3 : x * 3 + 3] * scale
            rows += [bytes(big)] * scale
        w, h = w * scale, h * scale
    else:
        rows = [rgb[y * w * 3 : (y + 1) * w * 3] for y in range(h)]

    raw = b''.join(b'\x00' + r for r in rows)  # filter type 0 per scanline

    def chunk(tag, payload):
        return (struct.pack('>I', len(payload)) + tag + payload
                + struct.pack('>I', zlib.crc32(tag + payload) & 0xFFFFFFFF))

    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)))
        f.write(chunk(b'IDAT', zlib.compress(raw, 9)))
        f.write(chunk(b'IEND', b''))


def main(argv):
    scale = 1
    args = []
    i = 0
    while i < len(argv):
        if argv[i] == '--scale':
            scale = int(argv[i + 1])
            i += 2
        else:
            args.append(argv[i])
            i += 1
    if not args:
        print(__doc__)
        return 2
    src = args[0]
    dst = args[1] if len(args) > 1 else (src.rsplit('.', 1)[0] + '.png')
    w, h, px = read_ppm(src)
    write_png(dst, w, h, px, scale)
    print('%s -> %s (%dx%d scale=%d)' % (src, dst, w, h, scale))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
