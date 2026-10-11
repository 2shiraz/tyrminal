#!/usr/bin/env python3
"""Draws the original Tyrminal app icon (a prompt chevron and cursor) as a 1024px PNG.

Pure standard library so the artwork is reproducible without image tooling:
    python3 make-icon.py icon-source.png && pnpm --filter @tyrminal/desktop tauri icon design/icon-source.png
"""
import math, struct, sys, zlib

SIZE = 1024
INSET, RADIUS = 100, 185           # macOS-style safe area and corner radius
BG_TOP, BG_BOTTOM = (22, 33, 49), (11, 16, 22)
ACCENT, CURSOR, EDGE = (86, 148, 255), (232, 237, 243), (52, 70, 96)


def sd_round_rect(x, y, half, r):
    qx, qy = abs(x) - half + r, abs(y) - half + r
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r


def sd_segment(px, py, ax, ay, bx, by, radius):
    vx, vy, wx, wy = bx - ax, by - ay, px - ax, py - ay
    t = max(0.0, min(1.0, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
    return math.hypot(wx - t * vx, wy - t * vy) - radius


def cover(d):
    return max(0.0, min(1.0, 0.5 - d))


def blend(dst, src, a):
    return tuple(dst[i] * (1 - a) + src[i] * a for i in range(3))


def main(out):
    c = SIZE / 2
    half = c - INSET
    rows = bytearray()
    for y in range(SIZE):
        rows.append(0)
        for x in range(SIZE):
            px, py = x + 0.5 - c, y + 0.5 - c
            d = sd_round_rect(px, py, half, RADIUS)
            alpha = cover(d)
            if alpha <= 0:
                rows += b"\0\0\0\0"
                continue
            t = (py + half) / (2 * half)
            col = tuple(BG_TOP[i] * (1 - t) + BG_BOTTOM[i] * t for i in range(3))
            col = blend(col, EDGE, cover(abs(d + 5) - 2.5) * 0.9)                 # inner hairline
            chevron = min(sd_segment(px, py, -205, -150, -25, 0, 46), sd_segment(px, py, -25, 0, -205, 150, 46))
            col = blend(col, ACCENT, cover(chevron))
            col = blend(col, CURSOR, cover(sd_segment(px, py, 75, 150, 235, 150, 40)))
            rows += bytes((round(col[0]), round(col[1]), round(col[2]), round(alpha * 255)))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")
    open(out, "wb").write(png)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "icon-source.png")
