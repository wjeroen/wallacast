"""Draws Player Link's icon (needs Pillow): two play triangle outlines, interlocked like the
links of a chain, white on amber.

  python3 icons.py sheet.png preview      a preview, big and at launcher size, plus the checks
  python3 icons.py RES/mipmap-xxxhdpi     the adaptive icon foreground (432 px) and the legacy
                                          icon, prints the background color for res/values/colors.xml

Coordinates are on the 432 px foreground canvas of an adaptive icon. A launcher shows its middle
288 px (72 of 108 dp) and a round mask the middle circle of 264 px. The glyph stays inside a
circle of radius MARGIN_RADIUS, which leaves room around it inside that mask.

Visual centering: a shape pointing right looks shifted right when its box is centered, and
shifted left when its weight (center of mass) is centered. The glyph is placed so the point
halfway between the two sits on the canvas center.

Everything is drawn as grey masks at 4x size and only then made white, so no colored fringes
appear. Where the outlines cross, the one on top cuts a gap into the one below.
"""
import math
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFont

SS = 4
N = 432 * SS
BG = (217, 119, 6)
CENTER = 216
MARGIN_RADIUS = 120

SIDE = 136      # side of each triangle
STROKE = 19
GAP = 7         # the gap around the outline that lies on top
DX = 60         # how far the second triangle sits right of the first


def blank():
    return Image.new('L', (N, N), 0)


def tri_outline(left, cy, side, width):
    """A play triangle outline with round corners and joins: flat side at x=left."""
    m = blank()
    d = ImageDraw.Draw(m)
    h, w = side / 2, side * 0.866
    pts = [(left * SS, (cy - h) * SS), ((left + w) * SS, cy * SS), (left * SS, (cy + h) * SS)]
    d.line(pts + pts[:2], fill=255, width=int(width * SS), joint='curve')
    r = width * SS / 2
    for x, y in pts:
        d.ellipse([x - r, y - r, x + r, y + r], fill=255)
    return m


def disc(cx, cy, r):
    m = blank()
    ImageDraw.Draw(m).ellipse([(cx - r) * SS, (cy - r) * SS, (cx + r) * SS, (cy + r) * SS], fill=255)
    return m


def glyph(shift=0.0):
    """The two interlocked triangles, the pair moved right by shift."""
    w = SIDE * 0.866
    h = SIDE / 2
    left_a = CENTER - (w + DX) / 2 + shift
    left_b = left_a + DX
    a = tri_outline(left_a, CENTER, SIDE, STROKE)
    a_wide = tri_outline(left_a, CENTER, SIDE, STROKE + 2 * GAP)
    b = tri_outline(left_b, CENTER, SIDE, STROKE)
    b_wide = tri_outline(left_b, CENTER, SIDE, STROKE + 2 * GAP)
    # a's slanted edges cross b's flat side twice: b lies on top at the upper crossing, a at the
    # lower one, so the outlines go over and under each other like chain links
    y_low = CENTER + h * (1 - DX / w)
    a_on_top = disc(left_b, y_low, STROKE * 1.7)
    a_vis = ImageChops.subtract(a, ImageChops.subtract(b_wide, a_on_top))
    b_vis = ImageChops.subtract(b, ImageChops.multiply(a_wide, a_on_top))
    return ImageChops.lighter(a_vis, b_vis)


def measure(mask):
    """Box center x, weight center x, the farthest pixel from the canvas center, box center y."""
    small = mask.resize((216, 216), Image.LANCZOS)
    px = small.load()
    box = small.getbbox()
    total = sx = 0.0
    far = 0.0
    for y in range(216):
        for x in range(216):
            v = px[x, y]
            if v:
                total += v
                sx += v * x
                if v > 60:
                    far = max(far, math.hypot(x * 2 + 1 - CENTER, y * 2 + 1 - CENTER))
    return (box[0] + box[2]) / 2 * 2, sx / total * 2 + 1, far, (box[1] + box[3]) / 2 * 2


def centered():
    """The glyph moved so the point halfway between its box center and its weight sits on the center."""
    box_x, mass_x, _, _ = measure(glyph())
    return glyph(CENTER - (box_x + mass_x) / 2)


def foreground(mask, size):
    img = Image.new('RGBA', (size, size), (255, 255, 255, 0))
    img.putalpha(mask.resize((size, size), Image.LANCZOS))
    return img


def launcher(mask, size):
    """The icon as a launcher shows it: amber rounded square, the glyph's middle 72 of 108."""
    im = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle([0, 0, size * SS - 1, size * SS - 1], radius=size * SS * 0.28, fill=BG + (255,))
    im = im.resize((size, size), Image.LANCZOS)
    g = foreground(mask, int(round(size * 108 / 72)))
    off = (size - g.width) // 2
    im.alpha_composite(g, (off, off))
    return im


if __name__ == '__main__':
    out = sys.argv[1]
    m = centered()
    box_x, mass_x, far, box_y = measure(m)
    print(f'box center x {box_x - CENTER:+.1f}, weight x {mass_x - CENTER:+.1f}, their middle {(box_x + mass_x) / 2 - CENTER:+.1f}, '
          f'box center y {box_y - CENTER:+.1f}, farthest pixel {far:.0f} (limit {MARGIN_RADIUS})')
    assert far <= MARGIN_RADIUS + 1, 'the glyph comes too close to the edge'
    if len(sys.argv) > 2 and sys.argv[2] == 'preview':
        sheet = Image.new('RGBA', (900, 640), (15, 23, 42, 255))
        sheet.alpha_composite(launcher(m, 420), (40, 40))
        sheet.alpha_composite(launcher(m, 96), (520, 80))
        sheet.alpha_composite(launcher(m, 64), (536, 230))
        sheet.alpha_composite(launcher(m, 48), (544, 340))
        d = ImageDraw.Draw(sheet)
        try:
            font = ImageFont.truetype('/system/fonts/Roboto-Regular.ttf', 30)
        except Exception:
            font = ImageFont.load_default()
        d.text((40, 500), 'Player Link: chained play buttons', fill=(241, 245, 249), font=font)
        d.text((40, 550), 'Right: at 96, 64 and 48 px', fill=(148, 163, 184), font=font)
        sheet.convert('RGB').save(out)
    else:
        foreground(m, 432).save(out + '/ic_launcher_foreground.png')
        launcher(m, 192).save(out + '/ic_launcher.png')
        print('#%02X%02X%02X' % BG)
