#!/usr/bin/env python3
"""Regenerate the toolbar icons: a phosphor download mark on a dark teal tile.

Run from the project root:  python3 tools/make-icons.py
"""

import os

from PIL import Image, ImageDraw

SCALE = 8          # supersample factor, downscaled at the end for smooth edges
BASE = 128         # icon design grid
SIZES = (16, 32, 48, 128)

PANEL = (12, 28, 27, 255)      # --panel
LINE = (27, 50, 48, 255)       # --line
PHOSPHOR = (60, 226, 194, 255) # --phosphor
MUTED = (47, 92, 87, 255)      # dimmed trace


def draw_icon() -> Image.Image:
    size = BASE * SCALE
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    s = SCALE

    draw.rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=26 * s, fill=PANEL, outline=LINE, width=2 * s
    )

    # Two log lines behind the mark, hinting at rows of text.
    for y, width in ((30, 58), (44, 40)):
        draw.rounded_rectangle(
            [24 * s, y * s, (24 + width) * s, (y + 7) * s], radius=3 * s, fill=MUTED
        )

    # Download arrow: shaft, head, tray.
    draw.rounded_rectangle([58 * s, 34 * s, 70 * s, 76 * s], radius=5 * s, fill=PHOSPHOR)
    draw.polygon(
        [(40 * s, 68 * s), (88 * s, 68 * s), (64 * s, 96 * s)], fill=PHOSPHOR
    )
    draw.rounded_rectangle([30 * s, 104 * s, 98 * s, 114 * s], radius=5 * s, fill=PHOSPHOR)

    return image


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "icons")
    os.makedirs(out_dir, exist_ok=True)

    master = draw_icon()
    for size in SIZES:
        master.resize((size, size), Image.LANCZOS).save(
            os.path.join(out_dir, f"icon{size}.png")
        )
        print(f"icons/icon{size}.png")


if __name__ == "__main__":
    main()
