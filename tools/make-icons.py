"""Regenerates icons/*.png from the mark described in icons/icon.svg.

Drawn with Pillow (4x supersampled, then downsampled) because the sandbox's
ImageMagick SVG renderer drops stroked paths. Run: python3 tools/make-icons.py
"""
import math
from PIL import Image, ImageDraw

BG = (10, 10, 10, 255)
GREEN = (74, 222, 128)
SS = 4  # supersampling factor


def mark(draw, size, scale):
    """Chip ring + rising results line, in 512-unit coordinates scaled to size."""
    k = size / 512 * scale
    off = size / 2 - 256 * k
    P = lambda x, y: (off + x * k, off + y * k)
    r, w = 150 * k, 22 * k
    cx, cy = P(256, 256)
    box = [cx - r, cy - r, cx + r, cy + r]
    # faint full ring, then 12 brighter chip segments
    draw.ellipse(box, outline=GREEN + (56,), width=round(w))
    for i in range(12):
        a0 = i * 30 - 90
        draw.arc(box, a0, a0 + 15.5, fill=GREEN + (150,), width=round(w))
    pts = [P(170, 312), P(222, 262), P(262, 290), P(344, 196)]
    lw = 26 * k
    draw.line(pts, fill=GREEN + (255,), width=round(lw), joint='curve')
    for p in (pts[0],):  # round start cap
        draw.ellipse([p[0] - lw / 2, p[1] - lw / 2, p[0] + lw / 2, p[1] + lw / 2], fill=GREEN + (255,))
    ex, ey = pts[-1]
    d = 20 * k
    draw.ellipse([ex - d, ey - d, ex + d, ey + d], fill=GREEN + (255,))


def render(size, maskable, flatten=False):
    big = size * SS
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    layer = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, big, big], fill=BG)
    else:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=112 * big / 512, fill=BG)
    mark(ImageDraw.Draw(layer), big, 0.78 if maskable else 1.0)
    img = Image.alpha_composite(img, layer).resize((size, size), Image.LANCZOS)
    if flatten:
        img = img.convert('RGB')
    return img


if __name__ == '__main__':
    for s in (192, 512):
        render(s, False).save(f'icons/icon-{s}.png', optimize=True)
        render(s, True).save(f'icons/icon-maskable-{s}.png', optimize=True)
    # iOS rounds the corners itself, so the touch icon is full-bleed and opaque.
    render(180, True, flatten=True).save('icons/apple-touch-icon.png', optimize=True)
