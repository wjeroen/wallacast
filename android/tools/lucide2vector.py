#!/usr/bin/env python3
"""Turns Lucide icons (the icon set the Wallacast app uses) into Android vector drawables, so the
watch app shows the same icons. Reads the icon shapes from the frontend's lucide-react package.

  python3 lucide2vector.py ../watch/res/drawable

Lucide is ISC licensed (https://lucide.dev, Copyright Lucide Contributors).
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.join(HERE, '..', '..', 'frontend', 'node_modules', 'lucide-react', 'dist', 'esm', 'icons')
# file name in lucide -> drawable name, filled or not
WANTED = {
    'play': ('ic_play', False),
    'pause': ('ic_pause', False),
    'skip-back': ('ic_skip_back', False),
    'skip-forward': ('ic_skip_forward', False),
    'rotate-ccw': ('ic_rotate_ccw', False),
    'rotate-cw': ('ic_rotate_cw', False),
    'shuffle': ('ic_shuffle', False),
    'archive': ('ic_archive', False),
    'archive-restore': ('ic_archive_restore', False),
    'star': ('ic_star', False),
}


def num(v):
    return float(v)


def rect_path(a):
    x, y, w, h = num(a.get('x', 0)), num(a.get('y', 0)), num(a['width']), num(a['height'])
    r = num(a.get('rx', a.get('ry', 0)))
    if r == 0:
        return f'M{x},{y}h{w}v{h}h{-w}z'
    return (f'M{x + r},{y}h{w - 2 * r}a{r},{r} 0 0 1 {r},{r}v{h - 2 * r}a{r},{r} 0 0 1 {-r},{r}'
            f'h{-(w - 2 * r)}a{r},{r} 0 0 1 {-r},{-r}v{-(h - 2 * r)}a{r},{r} 0 0 1 {r},{-r}z')


def circle_path(a):
    cx, cy, r = num(a['cx']), num(a['cy']), num(a['r'])
    return f'M{cx - r},{cy}a{r},{r} 0 1 0 {2 * r},0a{r},{r} 0 1 0 {-2 * r},0'


def points_path(a, close):
    pts = re.findall(r'-?[\d.]+', a['points'])
    pairs = [f'{pts[i]},{pts[i + 1]}' for i in range(0, len(pts), 2)]
    return 'M' + 'L'.join(pairs) + ('z' if close else '')


def shapes(source):
    node = source[source.index('__iconNode = ['):source.index('];', source.index('__iconNode = ['))]
    for kind, attrs in re.findall(r'\[\s*"(\w+)",\s*\{([^}]*)\}', node):
        a = dict(re.findall(r'(\w+):\s*"([^"]*)"', attrs))
        if kind == 'path':
            yield a['d']
        elif kind == 'rect':
            yield rect_path(a)
        elif kind == 'circle':
            yield circle_path(a)
        elif kind == 'line':
            yield f"M{a['x1']},{a['y1']}L{a['x2']},{a['y2']}"
        elif kind == 'polyline':
            yield points_path(a, False)
        elif kind == 'polygon':
            yield points_path(a, True)
        else:
            raise SystemExit(f'unknown shape {kind}')


def vector(paths, fill):
    lines = ['<?xml version="1.0" encoding="utf-8"?>',
             '<!-- A Lucide icon (ISC license, https://lucide.dev), made by android/tools/lucide2vector.py -->',
             '<vector xmlns:android="http://schemas.android.com/apk/res/android"',
             '    android:width="24dp" android:height="24dp"',
             '    android:viewportWidth="24" android:viewportHeight="24">']
    for d in paths:
        lines.append(f'    <path android:pathData="{d}"')
        lines.append('        android:strokeColor="#FFFFFFFF" android:strokeWidth="2"')
        lines.append('        android:strokeLineCap="round" android:strokeLineJoin="round"')
        lines.append(f'        android:fillColor="{"#FFFFFFFF" if fill else "#00000000"}" />')
    lines.append('</vector>')
    return '\n'.join(lines) + '\n'


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for name, (drawable, fill) in WANTED.items():
        with open(os.path.join(ICONS, name + '.js'), encoding='utf-8') as f:
            paths = list(shapes(f.read()))
        with open(os.path.join(out, drawable + '.xml'), 'w', encoding='utf-8') as f:
            f.write(vector(paths, fill))
        if name == 'star':
            with open(os.path.join(out, 'ic_star_filled.xml'), 'w', encoding='utf-8') as f:
                f.write(vector(paths, True))
    print('wrote', len(WANTED) + 1, 'icons to', out)


if __name__ == '__main__':
    main()
