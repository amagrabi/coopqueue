#!/usr/bin/env python3
"""Generate public/brand/* from the source logo.

    python3 scripts/build-brand.py path/to/logo.png

Needs Pillow + numpy (`pip3 install pillow numpy`). The only Python in the repo,
and deliberately not wired into npm: it runs when the logo changes, which is
approximately never, and adding an image toolchain to a project whose whole point
is "no build step" for that would be a bad trade.

The source is the full lockup — controller glyph plus "Coop Queue" wordmark — as
bright content on a near-black field. Three things this has to get right:

  1. **Crop out the generator watermark.** The original source had one in the
     bottom-right corner. It sits below the lockup, so a tight content crop drops
     it, but the bounding box is found by ignoring anything below the wordmark
     rather than by trusting the whole image.

  2. **Transparency comes from a luminance ramp, not a colour key.** Background
     luminance is ~17 and the darkest part of the gradient is ~125, so a ramp
     between them separates the two while leaving antialiased edges as partial
     alpha. Keying one exact RGB value misses the compression noise around the
     glyphs and leaves a visible staircase.

  3. **Icons keep the dark field.** The three figures inside the controller are
     white, so a transparent favicon leaves them invisible against light browser
     chrome — you get a bare controller outline. The field is not decoration.
"""
import sys, os
from PIL import Image
import numpy as np

PLANE = (13, 13, 13)      # --plane in styles.css: the site's page background
OUT   = os.path.join(os.path.dirname(__file__), '..', 'public', 'brand')
# Displayed at 26-30px; 96 gives 3x for the densest screens without shipping the
# full-resolution crop, which was 116 KB for a mark nobody sees above 30px.
LOGO_H = 96


def content_box(a, thr=40.0):
    """Bounding box of everything brighter than the background.

    Returns the box of the *lockup*: rows are taken from the tallest run of
    content, which excludes a watermark sitting in its own band lower down.
    """
    lum = 0.2126 * a[:, :, 0] + 0.7152 * a[:, :, 1] + 0.0722 * a[:, :, 2]
    m = lum > thr
    rows = np.where(m.any(axis=1))[0]
    # split rows into contiguous bands, keep the tallest — the lockup
    bands, start = [], rows[0]
    for i in range(1, len(rows)):
        if rows[i] != rows[i - 1] + 1:
            bands.append((start, rows[i - 1])); start = rows[i]
    bands.append((start, rows[-1]))
    y0, y1 = max(bands, key=lambda b: b[1] - b[0])
    cols = np.where(m[y0:y1 + 1].any(axis=0))[0]
    return int(cols[0]), int(y0), int(cols[-1]) + 1, int(y1) + 1


def keyed(a, box, pad=16):
    x0, y0, x1, y1 = box
    h, w, _ = a.shape
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(w, x1 + pad), min(h, y1 + pad)
    sub = a[y0:y1, x0:x1]
    lum = 0.2126 * sub[:, :, 0] + 0.7152 * sub[:, :, 1] + 0.0722 * sub[:, :, 2]
    alpha = np.clip((lum - 20.0) / 25.0, 0, 1)
    return Image.fromarray(np.dstack([sub, alpha * 255]).astype(np.uint8))


def on_plane(img, size, pad_frac=0.0):
    w, h = img.size
    side = int(max(w, h) * (1 + pad_frac * 2))
    canvas = Image.new('RGBA', (side, side), PLANE + (255,))
    canvas.alpha_composite(img, ((side - w) // 2, (side - h) // 2))
    return canvas.convert('RGB').resize((size, size), Image.LANCZOS)


def main(src):
    os.makedirs(OUT, exist_ok=True)
    a = np.asarray(Image.open(src).convert('RGB')).astype(np.float64)

    lock_box = content_box(a)
    lock = keyed(a, lock_box)

    # The controller glyph is the leftmost content run; find it by scanning for
    # the first wide gap after it rather than hardcoding pixel columns.
    x0, y0, x1, y1 = lock_box
    lum = 0.2126 * a[:, :, 0] + 0.7152 * a[:, :, 1] + 0.0722 * a[:, :, 2]
    cols = (lum[y0:y1] > 40).any(axis=0)
    gap = None
    for x in range(x0, x1 - 30):
        if not cols[x:x + 30].any():
            gap = x
            break
    icon = keyed(a, (x0, y0, gap if gap else x1, y1), pad=8)

    h = LOGO_H
    lock.resize((round(lock.width * h / lock.height), h), Image.LANCZOS) \
        .save(f'{OUT}/logo.png', optimize=True)
    icon.save(f'{OUT}/icon.png', optimize=True)
    for size, name in [(16, 'favicon-16.png'), (32, 'favicon-32.png'),
                       (180, 'apple-touch-icon.png'), (512, 'icon-512.png')]:
        on_plane(icon, size, 0.06 if size >= 180 else 0.02) \
            .save(f'{OUT}/{name}', optimize=True)

    og = Image.new('RGB', (1200, 630), PLANE)          # alpha is unreliable in
    tw = 940                                           # link previews
    s = lock.resize((tw, round(lock.height * tw / lock.width)), Image.LANCZOS)
    og.paste(s, ((1200 - s.width) // 2, (630 - s.height) // 2), s)
    og.save(f'{OUT}/og.png', optimize=True)

    for f in sorted(os.listdir(OUT)):
        p = f'{OUT}/{f}'
        i = Image.open(p)
        print(f'  {f:24} {i.size[0]:5}x{i.size[1]:<5} {i.mode:5} {os.path.getsize(p)/1024:7.1f} KB')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
