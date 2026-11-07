"""Generate the placeholder DarkLens icons: a magnifying glass over a warning triangle.

Usage: python3 tools/make-icons.py   (needs Pillow: pip install pillow)
Writes public/icon/{16,32,48,128}.png. Drawn large, then downsampled for smooth edges.
"""
from pathlib import Path

from PIL import Image, ImageDraw

S = 1024  # working canvas size
OUT = Path(__file__).resolve().parent.parent / "public" / "icon"

AMBER = (245, 166, 35, 255)
DARK = (31, 35, 40, 255)
GLASS = (255, 255, 255, 140)


def draw() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Warning triangle with a dark outline and "!"
    tri = [(S * 0.40, S * 0.06), (S * 0.04, S * 0.70), (S * 0.76, S * 0.70)]
    d.polygon(tri, fill=AMBER, outline=DARK, width=int(S * 0.035))
    d.rounded_rectangle(
        (S * 0.37, S * 0.24, S * 0.43, S * 0.50), radius=S * 0.03, fill=DARK
    )
    d.ellipse((S * 0.365, S * 0.55, S * 0.435, S * 0.62), fill=DARK)

    # Magnifying glass: lens at bottom right, overlapping the triangle
    cx, cy, r = S * 0.64, S * 0.62, S * 0.20
    ring = S * 0.065
    # Handle first so the lens ring covers its end
    d.line(
        [(cx + r * 0.65, cy + r * 0.65), (S * 0.95, S * 0.95)],
        fill=DARK,
        width=int(S * 0.11),
    )
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=GLASS, outline=DARK, width=int(ring))
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    big = draw()
    for size in (16, 32, 48, 128):
        big.resize((size, size), Image.LANCZOS).save(OUT / f"{size}.png")
        print(f"wrote {OUT / f'{size}.png'}")


if __name__ == "__main__":
    main()
