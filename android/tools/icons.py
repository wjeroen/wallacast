"""Draws Player Link's icon variants (needs Pillow): white chain links on amber.

  python3 icons.py sheet.png preview      a preview sheet with the variants, big and at launcher size,
                                          and a centering check of each in the terminal
  python3 icons.py RES/mipmap-xxxhdpi V   variant V as the app's adaptive icon foreground (432 px)
                                          and legacy icon, prints the background color for
                                          res/values/colors.xml

Coordinates are on the 432 px foreground canvas of an adaptive icon. A launcher shows at least its
middle 288 px (72 of 108 dp), and a round mask the middle circle of 264 px, so every glyph stays
inside a circle of radius 128 around the center.

Everything is drawn as grey masks at 4x size and only then made white, so no colored fringes
appear at the edges. Where two links cross, the one on top cuts a gap into the one below.
"""
import math
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFont

SS = 4
K = SS                      # 432 canvas units to supersampled pixels
N = 432 * SS
BG = (217, 119, 6)
CENTER = 216
LIMIT = 128


def blank():
    return Image.new('L', (N, N), 0)


def ring(cx, cy, r, width):
    """A circle outline: center line radius r, stroke width."""
    m = blank()
    d = ImageDraw.Draw(m)
    ro, ri = (r + width / 2) * K, (r - width / 2) * K
    d.ellipse([cx * K - ro, cy * K - ro, cx * K + ro, cy * K + ro], fill=255)
    d.ellipse([cx * K - ri, cy * K - ri, cx * K + ri, cy * K + ri], fill=0)
    return m


def disc(cx, cy, r):
    m = blank()
    ImageDraw.Draw(m).ellipse([(cx - r) * K, (cy - r) * K, (cx + r) * K, (cy + r) * K], fill=255)
    return m


def rounded_polygon(pts, radius, steps=12):
    """The outline of a convex polygon (clockwise or not) with each corner rounded by radius."""
    out = []
    n = len(pts)
    for i in range(n):
        p0, p1, p2 = pts[i - 1], pts[i], pts[(i + 1) % n]
        v1 = (p0[0] - p1[0], p0[1] - p1[1])
        v2 = (p2[0] - p1[0], p2[1] - p1[1])
        l1, l2 = math.hypot(*v1), math.hypot(*v2)
        v1, v2 = (v1[0] / l1, v1[1] / l1), (v2[0] / l2, v2[1] / l2)
        half = math.acos(max(-1.0, min(1.0, v1[0] * v2[0] + v1[1] * v2[1]))) / 2
        dist = radius / math.tan(half)               # from the corner to where the arc starts
        bis = (v1[0] + v2[0], v1[1] + v2[1])
        bl = math.hypot(*bis)
        c = (p1[0] + bis[0] / bl * radius / math.sin(half), p1[1] + bis[1] / bl * radius / math.sin(half))
        a1 = (p1[0] + v1[0] * dist, p1[1] + v1[1] * dist)
        a2 = (p1[0] + v2[0] * dist, p1[1] + v2[1] * dist)
        t1 = math.atan2(a1[1] - c[1], a1[0] - c[0])
        t2 = math.atan2(a2[1] - c[1], a2[0] - c[0])
        dt = (t2 - t1 + math.pi) % (2 * math.pi) - math.pi
        for k in range(steps + 1):
            t = t1 + dt * k / steps
            out.append((c[0] + radius * math.cos(t), c[1] + radius * math.sin(t)))
    return out


def play(cx, cy, height):
    """A solid play triangle with softly rounded corners, optically centered on (cx, cy): a
    triangle looks centered a little left of its box center, near 0.42 of its width."""
    m = blank()
    w = height * 0.866
    left = cx - 0.42 * w
    pts = [(left, cy - height / 2), (left + w, cy), (left, cy + height / 2)]
    shape = rounded_polygon(pts, height * 0.1)
    ImageDraw.Draw(m).polygon([(x * K, y * K) for x, y in shape], fill=255)
    return m


def pause(cx, cy, height):
    m = blank()
    d = ImageDraw.Draw(m)
    bar, gap = height * 0.3, height * 0.26
    for x0 in (cx - gap / 2 - bar, cx + gap / 2):
        d.rounded_rectangle([x0 * K, (cy - height / 2) * K, (x0 + bar) * K, (cy + height / 2) * K], radius=bar * 0.35 * K, fill=255)
    return m


def union(*ms):
    out = ms[0]
    for m in ms[1:]:
        out = ImageChops.lighter(out, m)
    return out


def minus(a, b):
    return ImageChops.subtract(a, b)


def inter(a, b):
    return ImageChops.multiply(a, b)


def interlock(a, a_wide, b, b_wide, a_on_top):
    """a and b cross twice. a_on_top is a mask around the crossing where a is on top;
    b is on top everywhere else."""
    a_vis = minus(a, minus(b_wide, a_on_top))
    b_vis = minus(b, inter(a_wide, a_on_top))
    return union(a_vis, b_vis)


GAP = 7  # the gap around a link that lies on top


def glyph_rings(left_sign, right_sign, deg=0.0):
    """Two interlocked rings along a line turned by deg (negative: rising to the right), with
    an upright sign in what is left free of each hole."""
    r, width, d = 60, 20, 88
    t = math.radians(deg)
    ux, uy = math.cos(t), math.sin(t)          # along the chain
    def at(along, across=0.0):
        return CENTER + along * ux - across * uy, CENTER + along * uy + across * ux
    cl, cr = at(-d / 2), at(d / 2)
    a, aw = ring(*cl, r, width), ring(*cl, r, width + 2 * GAP)
    b, bw = ring(*cr, r, width), ring(*cr, r, width + 2 * GAP)
    yc = math.sqrt(r * r - (d / 2) ** 2)
    top = disc(*at(0, -yc), width * 1.5)       # the first ring lies on top at this crossing
    m = interlock(a, aw, b, bw, top)
    # the free part of each hole runs from its own inner edge to the other ring's outer edge
    inner_edge = -d / 2 - (r - width / 2)
    other_edge = d / 2 - (r + width / 2) - GAP
    free = (inner_edge + other_edge) / 2
    # a pause sign looks heavier than a play sign of the same height
    def sized(sign):
        return 46 if sign is play else 38
    signs = [left_sign(*at(free), sized(left_sign)), right_sign(*at(-free), sized(right_sign))]
    return union(m, *signs)


VARIANTS = {
    'A': ('Play and pause links', lambda: glyph_rings(play, pause)),
    'B': ('Two play links', lambda: glyph_rings(play, play)),
    'C': ('Rising chain', lambda: glyph_rings(play, pause, -35)),
}


def foreground(mask, size):
    """The white glyph from its mask, at size px."""
    alpha = mask.resize((size, size), Image.LANCZOS)
    img = Image.new('RGBA', (size, size), (255, 255, 255, 0))
    img.putalpha(alpha)
    return img


def check(mask):
    """How far the glyph's box center is from the canvas center, and its farthest pixel."""
    small = mask.resize((432, 432), Image.LANCZOS)
    box = small.getbbox()
    cx, cy = (box[0] + box[2]) / 2 - CENTER, (box[1] + box[3]) / 2 - CENTER
    px = small.load()
    far = max(math.hypot(x - CENTER, y - CENTER) for y in range(432) for x in range(432) if px[x, y] > 60)
    return cx, cy, far


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
    out, mode = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else 'preview')
    if mode == 'preview':
        sheet = Image.new('RGBA', (1080, 600), (15, 23, 42, 255))
        d = ImageDraw.Draw(sheet)
        try:
            font = ImageFont.truetype('/system/fonts/Roboto-Regular.ttf', 32)
        except Exception:
            font = ImageFont.load_default()
        for i, (key, (name, fn)) in enumerate(VARIANTS.items()):
            m = fn()
            cx, cy, far = check(m)
            print(f'{key}: box center off by ({cx:+.1f}, {cy:+.1f}) px, farthest pixel {far:.0f} of {LIMIT}')
            x = 60 + i * 340
            sheet.alpha_composite(launcher(m, 280), (x, 40))
            sheet.alpha_composite(launcher(m, 64), (x + 108, 350))
            label = f'{key}: {name}'
            tw = d.textlength(label, font=font)
            d.text((x + 140 - tw / 2, 450), label, fill=(241, 245, 249), font=font)
        d.text((60, 530), 'Big, and below it at about launcher size', fill=(148, 163, 184), font=font)
        sheet.convert('RGB').save(out)
    else:
        m = VARIANTS[mode][1]()
        foreground(m, 432).save(out + '/ic_launcher_foreground.png')
        launcher(m, 192).save(out + '/ic_launcher.png')
        print('#%02X%02X%02X' % BG)
