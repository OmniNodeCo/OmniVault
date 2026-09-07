#!/usr/bin/env python3
"""
OmniVault icon generator.

Renders the shield + keyhole emblem (matching public/icons/icon.svg) straight
to PNG with PIL — no SVG toolchain required. Run from anywhere:

    python3 scripts/make-icons.py

Outputs into public/icons/.
"""

import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "public", "icons")

# palette (must match icon.svg)
BG_TOP = (19, 28, 56)      # #131c38
BG_BOTTOM = (11, 16, 32)   # #0b1020
SHIELD_TOP = (129, 140, 248)  # #818cf8
SHIELD_BOTTOM = (79, 70, 229)  # #4f46e5
DARK = (11, 16, 32)        # #0b1020

SS = 4  # supersampling factor


def cubic(p0, p1, p2, p3, steps=64):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        x = (1 - t) ** 3 * p0[0] + 3 * (1 - t) ** 2 * t * p1[0] + 3 * (1 - t) * t ** 2 * p2[0] + t ** 3 * p3[0]
        y = (1 - t) ** 3 * p0[1] + 3 * (1 - t) ** 2 * t * p1[1] + 3 * (1 - t) * t ** 2 * p2[1] + t ** 3 * p3[1]
        pts.append((x, y))
    return pts


def shield_points(scale=1.0, dx=0.0, dy=0.0):
    """Points for the shield path from icon.svg (512 viewBox)."""
    pts = [(256, 72), (400, 120), (400, 248)]
    pts += cubic((400, 248), (400, 344), (338.4, 404.8), (256, 440))
    pts += cubic((256, 440), (173.6, 404.8), (112, 344), (112, 248))
    pts += [(112, 120)]
    return [(dx + x * scale, dy + y * scale) for (x, y) in pts]


def diagonal_gradient(size, c1, c2):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(0, size, 1):
            t = min(1.0, max(0.0, (x / size + y / size) / 2))
            px[x, y] = (
                int(c1[0] + (c2[0] - c1[0]) * t),
                int(c1[1] + (c2[1] - c1[1]) * t),
                int(c1[2] + (c2[2] - c1[2]) * t),
            )
    return img


def vertical_gradient(w, h, c1, c2):
    img = Image.new("RGB", (w, h))
    for y in range(h):
        t = y / max(1, h - 1)
        color = (int(c1[0] + (c2[0] - c1[0]) * t), int(c1[1] + (c2[1] - c1[1]) * t), int(c1[2] + (c2[2] - c1[2]) * t))
        for x in range(w):
            img.putpixel((x, y), color)
    return img


def render(size, maskable=False, rounded=True):
    """Render one icon. maskable: full-bleed with emblem at 72% (safe zone)."""
    big = size * SS
    scale = big / 512.0

    # ---- background (rounded square or full bleed) -------------------------
    bg = diagonal_gradient(big, BG_TOP, BG_BOTTOM).convert("RGBA")

    if rounded:
        mask = Image.new("L", (big, big), 0)
        d = ImageDraw.Draw(mask)
        radius = int(112 * scale)
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=255)
        base = Image.new("RGBA", (big, big), (0, 0, 0, 0))
        base.paste(bg, (0, 0), mask)
    else:
        base = bg

    # ---- shield -------------------------------------------------------------
    if maskable:
        emblem_scale = 0.72
        off = (big - big * emblem_scale) / 2
        s = scale * emblem_scale
        pts = shield_points(s, off, off)
        keyhole_center = (off + 256 * s, off + 232 * s)
        keyhole_r = 42 * s
        slot = [off + 238 * s, off + 250 * s, off + 274 * s, off + 344 * s]
    else:
        pts = shield_points(scale)
        keyhole_center = (256 * scale, 232 * scale)
        keyhole_r = 42 * scale
        slot = [238 * scale, 250 * scale, 274 * scale, 344 * scale]

    shield_mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(shield_mask).polygon(pts, fill=255)

    shield_gradient = vertical_gradient(big, big, SHIELD_TOP, SHIELD_BOTTOM).convert("RGBA")
    base.paste(shield_gradient, (0, 0), shield_mask)

    # ---- keyhole ------------------------------------------------------------
    d = ImageDraw.Draw(base)
    cx, cy = keyhole_center
    d.ellipse([cx - keyhole_r, cy - keyhole_r, cx + keyhole_r, cy + keyhole_r], fill=DARK + (255,))
    d.rounded_rectangle(slot, radius=(slot[2] - slot[0]) / 2, fill=DARK + (255,))

    return base.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    outputs = {
        "icon-512.png": render(512, rounded=True),
        "icon-192.png": render(192, rounded=True),
        "favicon-32.png": render(32, rounded=True),
        "icon-maskable-512.png": render(512, maskable=True, rounded=False),
        "icon-maskable-192.png": render(192, maskable=True, rounded=False),
        "apple-touch-icon.png": render(180, maskable=True, rounded=False),
    }
    for name, img in outputs.items():
        path = os.path.join(OUT, name)
        img.save(path, "PNG", optimize=True)
        print(f"wrote {path} ({img.size[0]}x{img.size[1]})")


if __name__ == "__main__":
    main()
