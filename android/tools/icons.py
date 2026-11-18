"""Draws Player Link's icon variants (needs Pillow).

  python3 icons.py sheet.png preview      a preview sheet with variants A, B and C
  python3 icons.py RES/mipmap-xxxhdpi C   variant C as the app's adaptive icon foreground
                                          (432 px) and legacy icon, prints its background color
                                          for res/values/colors.xml
"""
import math
import sys
from PIL import Image, ImageDraw, ImageFont

S = 4  # supersampling
OUT = sys.argv[1]


def tri(d, cx, cy, r, fill):
    # an equilateral play triangle pointing right, centered on its centroid, rounded a little
    pts = [(cx - r * 0.5, cy - r * 0.866), (cx + r, cy), (cx - r * 0.5, cy + r * 0.866)]
    d.polygon(pts, fill=fill)


def glyph_twins(size, fg):
    """Two play triangles joined by a bar under them: two players, linked."""
    im = Image.new('RGBA', (size * S, size * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    u = size * S / 432
    tri(d, 158 * u, 196 * u, 48 * u, fg)
    tri(d, 250 * u, 196 * u, 48 * u, fg)
    w = 18 * u
    # the link: a rounded bar from under the first triangle to under the second
    d.rounded_rectangle([134 * u, 262 * u, 298 * u, 262 * u + w], radius=w / 2, fill=fg)
    d.rounded_rectangle([134 * u, 242 * u, 134 * u + w, 262 * u + w], radius=w / 2, fill=fg)
    d.rounded_rectangle([298 * u - w, 242 * u, 298 * u, 262 * u + w], radius=w / 2, fill=fg)
    return im.resize((size, size), Image.LANCZOS)


def glyph_chain(size, fg, bg):
    """Two chain links."""
    big = size * S
    im = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    u = big / 432
    stroke = int(26 * u)
    # links drawn on a horizontal axis, then the whole layer turned 45 degrees
    d.rounded_rectangle([108 * u, 168 * u, 250 * u, 264 * u], radius=48 * u, outline=fg, width=stroke)
    d.rounded_rectangle([182 * u, 168 * u, 324 * u, 264 * u], radius=48 * u, outline=fg, width=stroke)
    im = im.rotate(35, resample=Image.BICUBIC, center=(big / 2, big / 2))
    return im.resize((size, size), Image.LANCZOS)


def glyph_sync(size, fg):
    """A play triangle inside two turning arrows: playback kept in sync."""
    big = size * S
    im = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    u = big / 432
    r = 96 * u
    c = big / 2
    w = int(22 * u)
    for start in (200, 20):
        d.arc([c - r, c - r, c + r, c + r], start=start, end=start + 130, fill=fg, width=w)
        a = math.radians(start + 130)
        hx, hy = c + r * math.cos(a), c + r * math.sin(a)
        # arrow head, pointing along the circle
        t = a + math.pi / 2
        p1 = (hx + 30 * u * math.cos(t), hy + 30 * u * math.sin(t))
        p2 = (hx + 26 * u * math.cos(a), hy + 26 * u * math.sin(a))
        p3 = (hx - 26 * u * math.cos(a), hy - 26 * u * math.sin(a))
        d.polygon([p1, p2, p3], fill=fg)
    tri(d, c + 6 * u, c, 44 * u, fg)
    return im.resize((size, size), Image.LANCZOS)


VARIANTS = [
    ('A', 'Two linked players', (13, 148, 136), glyph_twins),
    ('B', 'Chain link', (217, 119, 6), None),
    ('C', 'Sync', (124, 58, 237), glyph_sync),
]


def glyph(v, size):
    key, _, bg, fn = v
    if key == 'B':
        return glyph_chain(size, (255, 255, 255, 255), bg)
    return fn(size, (255, 255, 255, 255))


def launcher(v, size):
    """The icon as a launcher shows it: the background in a rounded square, the glyph on top."""
    im = Image.new('RGBA', (size * S, size * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, size * S - 1, size * S - 1], radius=size * S * 0.28, fill=v[2] + (255,))
    im = im.resize((size, size), Image.LANCZOS)
    # an adaptive icon shows the middle 72 of its 108 units
    g = glyph(v, int(size * 108 / 72))
    off = (size - g.width) // 2
    im.alpha_composite(g, (off, off))
    return im


if __name__ == '__main__':
    mode = sys.argv[2] if len(sys.argv) > 2 else 'preview'
    if mode == 'preview':
        sheet = Image.new('RGBA', (1080, 560), (15, 23, 42, 255))
        d = ImageDraw.Draw(sheet)
        try:
            font = ImageFont.truetype('/system/fonts/Roboto-Regular.ttf', 34)
        except Exception:
            font = ImageFont.load_default()
        for i, v in enumerate(VARIANTS):
            x = 60 + i * 340
            sheet.alpha_composite(launcher(v, 280), (x, 70))
            label = f'{v[0]}: {v[1]}'
            tw = d.textlength(label, font=font)
            d.text((x + 140 - tw / 2, 400), label, fill=(241, 245, 249), font=font)
        sheet.convert('RGB').save(OUT)
    else:
        v = next(x for x in VARIANTS if x[0] == mode)
        glyph(v, 432).save(OUT + '/ic_launcher_foreground.png')
        launcher(v, 192).save(OUT + '/ic_launcher.png')
        print('#%02X%02X%02X' % v[2])
