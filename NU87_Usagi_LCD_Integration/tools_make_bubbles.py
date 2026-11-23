#!/usr/bin/env python3
"""Hand-drawn style speech-bubble shells for the Home screen, pre-rasterised for the slow software-SPI LCD.
Six styles x two sizes (FULL 196x112, HALF 196x54). Each shell is composited on the Home background (#F8F8F8), quantised (no dithering), RLE coded into
usagi_bubbles.h; the same pixels are written as PNG for the web preview (nu87-editor/public/bubbles), so the preview equals what the LCD draws.
The text area of each shell is measured automatically (largest rectangle fully inside the white/pastel fill)."""
import json, math, random
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageChops

HERE = Path(__file__).resolve().parent
WEB = HERE.parent / "nu87-editor" / "public" / "bubbles"
S = 4
BG = (248, 248, 248); INK = (34, 34, 40)
FILL = {"white": (255, 255, 255), "yellow": (255, 243, 176), "pink": (253, 226, 238)}
OFFS = {"sky": (168, 216, 240), "pink": (242, 181, 204), "yellow": (255, 224, 138)}
SIZES = {"full": (196, 112), "half": (196, 54)}
STYLES = [  # name, fill, offset colour
    ("cloud", "white", "sky"), ("burst", "yellow", "pink"), ("spiky", "pink", "yellow"),
    ("shaky", "white", "pink"), ("soft", "white", "sky"), ("star", "pink", "yellow")]

def new(W, H): return Image.new("L", (W * S, H * S), 0)
def poly(m, pts): ImageDraw.Draw(m).polygon([(x * S, y * S) for x, y in pts], fill=255)
def circ(m, cx, cy, r): ImageDraw.Draw(m).ellipse([(cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S], fill=255)
def line(m, a, b, w): ImageDraw.Draw(m).line([(a[0] * S, a[1] * S), (b[0] * S, b[1] * S)], fill=255, width=int(w * S))
def dilate(m, t): return m.filter(ImageFilter.MaxFilter(2 * int(t * S) + 1))
def shift(m, dx, dy): return ImageChops.offset(m, int(dx * S), int(dy * S))

def rr_points(x0, y0, x1, y1, rad, n):  # points around a rounded rectangle, with outward normals
    pts = []
    per = 2 * ((x1 - x0) + (y1 - y0)) - 8 * rad + 2 * math.pi * rad
    for i in range(n):
        d = per * i / n; segs = [("h", x1 - x0 - 2 * rad), ("a", math.pi * rad / 2), ("v", y1 - y0 - 2 * rad), ("a", math.pi * rad / 2),
                                 ("h", x1 - x0 - 2 * rad), ("a", math.pi * rad / 2), ("v", y1 - y0 - 2 * rad), ("a", math.pi * rad / 2)]
        k = 0
        while d > segs[k % 8][1]: d -= segs[k % 8][1]; k += 1
        t = segs[k % 8][0]; ln = segs[k % 8][1]; f = d / ln if ln else 0; side = (k % 8) // 2
        if t == "h":
            x = x0 + rad + f * (x1 - x0 - 2 * rad) if side == 0 else x1 - rad - f * (x1 - x0 - 2 * rad); y = y0 if side == 0 else y1; nx, ny = 0, (-1 if side == 0 else 1)
        elif t == "v":
            y = y0 + rad + f * (y1 - y0 - 2 * rad) if side == 1 else y1 - rad - f * (y1 - y0 - 2 * rad); x = x1 if side == 1 else x0; nx, ny = (1 if side == 1 else -1), 0
        else:
            cxs = [x1 - rad, x1 - rad, x0 + rad, x0 + rad][side]; cys = [y0 + rad, y1 - rad, y1 - rad, y0 + rad][side]
            a0 = [-math.pi / 2, 0, math.pi / 2, math.pi][side]; a = a0 + f * math.pi / 2
            x = cxs + rad * math.cos(a); y = cys + rad * math.sin(a); nx, ny = math.cos(a), math.sin(a)
        pts.append((x, y, nx, ny))
    return pts

def shape(style, W, H, rnd):
    m = new(W, H); extra = []   # extra = (kind, args) ink-only decorations drawn on top
    half = H < 80
    bx0, by0, bx1, by1 = 17, 5, W - 9, H - 8
    cy = (by0 + by1) / 2
    amp = 5 if half else 8
    if style == "cloud":
        r = 8 if half else 12; pts = rr_points(bx0 + r * 0.9, by0 + r * 0.9, bx1 - r * 0.9, by1 - r * 0.9, 8 if half else 20, 18 if half else 24)
        poly(m, [(x, y) for x, y, nx, ny in pts])
        for (x, y, nx, ny) in pts: circ(m, x + nx * 1.5, y + ny * 1.5, r * rnd.uniform(0.85, 1.1))
        circ(m, 9, by1 - 4, 4.6 if not half else 3.4); circ(m, 3.5, by1 + 2, 2.6 if not half else 2)   # thought dots lead to the character
    elif style == "burst":
        bx1b, by0b = W - 16, 11; pts = rr_points(bx0 + 4, by0b + 2, bx1b - 4, by1 - 4, 26 if not half else 14, 40 if not half else 30); out = []
        for i, (x, y, nx, ny) in enumerate(pts):
            o = (amp + rnd.uniform(-1.5, 1.5)) if i % 2 == 0 else 0
            out.append((x + nx * o, y + ny * o))
        poly(m, out); poly(m, [(bx0 + 6, cy + 4), (1, by1 + 1), (bx0 + 16, cy + 16 if not half else cy + 9)])
        for dx, dy in ([(0, 0), (7, 3), (13, 9)] if not half else [(0, 0), (8, 4)]):
            extra.append(((W - 22 + dx, 8 + dy * 0.6), (W - 12 + dx * 0.6, 2 + dy * 0.3 + 2), 2))
    elif style == "spiky":
        pts = rr_points(bx0 + 3, by0 + 10, bx1 - 3, by1 - 5, 6, 28 if not half else 22); out = []
        for i, (x, y, nx, ny) in enumerate(pts):
            o = (amp + 1 + rnd.uniform(-1, 2)) if i % 2 == 0 else -1
            out.append((x + nx * o, y + ny * o))
        poly(m, out); poly(m, [(bx0 + 2, cy + 4), (1, by1 + 1), (bx0 + 16, cy + 18 if not half else cy + 11)])
    elif style == "shaky":
        pts = rr_points(bx0, by0 + 2, bx1 - 2, by1 - 1, 13 if not half else 10, 70 if not half else 54); out = []
        for i, (x, y, nx, ny) in enumerate(pts):
            o = 1.6 * math.sin(i * 0.9 + 1.3) + rnd.uniform(-1.3, 1.3); out.append((x + nx * o, y + ny * o))
        poly(m, out); poly(m, [(bx0 + 1, cy + 3), (1, by1), (bx0 + 15, cy + 16 if not half else cy + 10)])
    elif style == "soft":
        cx, cyy = (bx0 + bx1) / 2, cy; rx, ry = (bx1 - bx0) / 2, (by1 - by0) / 2; pts = []
        for i in range(120):
            a = 2 * math.pi * i / 120; c, s_ = math.cos(a), math.sin(a)
            e = 1 + 0.035 * math.sin(3 * a + 0.6) + 0.025 * math.sin(5 * a + 2.0)
            x = cx + rx * e * math.copysign(abs(c) ** (2 / 3.2), c); y = cyy + ry * e * math.copysign(abs(s_) ** (2 / 3.2), s_); pts.append((x, y))
        poly(m, pts); poly(m, [(bx0 + 6, cy + 1), (2, by1 + 1), (bx0 + 17, cy + 15 if not half else cy + 9)])
    else:  # star: celebration burst with broad soft points and confetti
        bx1b = W - 13; pts = rr_points(bx0 + 3, by0 + 5, bx1b - 3, by1 - 3, 24 if not half else 13, 24 if not half else 20); out = []
        for i, (x, y, nx, ny) in enumerate(pts):
            o = (amp - 1) if i % 2 == 0 else 0; out.append((x + nx * o, y + ny * o))
        poly(m, out); poly(m, [(bx0 + 5, cy + 5), (1, by1 + 1), (bx0 + 15, cy + 14 if not half else cy + 9)])
        for (px, py) in [(W - 5, 5), (W - 8, H - 8), (11, 4), (bx0 + 34, H - 3)]: extra.append(("dot", (px, py), 2))
    return m, extra

def render(style, fillk, offk, size):
    W, H = SIZES[size]; rnd = random.Random(hash((style, size)) & 0xFFFF)
    m, extra = shape(style, W, H, rnd)
    t = 2.0
    ink = dilate(m, t)
    if style == "shaky": ink = ImageChops.lighter(ink, dilate(shift(m, 1.4, -1.0), t))   # doubled, trembling outline
    off = shift(dilate(m, t), 3, 3)
    canvas = Image.new("RGB", (W * S, H * S), BG)
    canvas.paste(Image.new("RGB", canvas.size, OFFS[offk]), mask=off)
    canvas.paste(Image.new("RGB", canvas.size, INK), mask=ink)
    canvas.paste(Image.new("RGB", canvas.size, FILL[fillk]), mask=m)
    d = ImageDraw.Draw(canvas)
    for e in extra:
        if e[0] == "dot":
            cx, cy = e[1]; col = [OFFS["yellow"], OFFS["sky"], OFFS["pink"], OFFS["yellow"]][int(cx) % 4]; r = e[2]
            d.ellipse([(cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S], fill=col, outline=INK, width=S // 2)
        else:
            d.line([(e[0][0] * S, e[0][1] * S), (e[1][0] * S, e[1][1] * S)], fill=INK, width=int(e[2] * S))
    img = canvas.resize((W, H), Image.LANCZOS)
    # text rectangle: largest rectangle around the body centre that stays inside the fill (3 px margin)
    mask1 = m.resize((W, H), Image.LANCZOS).point(lambda v: 255 if v > 250 else 0).filter(ImageFilter.MinFilter(7))
    px = mask1.load(); cx0, cy0 = int((17 + W - 4) / 2), int(H / 2)
    if not px[cx0, cy0]: cx0 = int(W * 0.55)
    x0 = x1 = cx0; y0 = y1 = cy0; grew = True
    def ok_col(x, a, b): return all(px[x, y] for y in range(a, b + 1))
    def ok_row(y, a, b): return all(px[x, y] for x in range(a, b + 1))
    while grew:
        grew = False
        if x1 + 1 < W and ok_col(x1 + 1, y0, y1): x1 += 1; grew = True
        if x0 - 1 > 0 and ok_col(x0 - 1, y0, y1): x0 -= 1; grew = True
        if y1 + 1 < H and ok_row(y1 + 1, x0, x1): y1 += 1; grew = True
        if y0 - 1 > 0 and ok_row(y0 - 1, x0, x1): y0 -= 1; grew = True
    return img, (x0, y0, x1 - x0 + 1, y1 - y0 + 1)

def rgb565(c): return ((c[0] >> 3) << 11) | ((c[1] >> 2) << 5) | (c[2] >> 3)

out = ["// Generated by tools_make_bubbles.py. Do not hand-edit.", "#pragma once", "#include <Arduino.h>"]
assets, data, offs, meta = [], bytearray(), [], {}
WEB.mkdir(parents=True, exist_ok=True)
for name, fk, ok in STYLES:
    for size in ("full", "half"):
        img, rect = render(name, fk, ok, size)
        q = img.quantize(colors=32, method=Image.MEDIANCUT, dither=Image.NONE)
        pal = q.getpalette()[:96]; nc = len(pal) // 3; pal565 = [rgb565(tuple(pal[i * 3:i * 3 + 3])) for i in range(nc)] + [0] * (32 - nc)
        pal565[q.getpixel((0, 0)) if False else 0] = pal565[0]
        px = list(q.getdata()); stream = bytearray(); i = 0
        while i < len(px):
            r = 1
            while i + r < len(px) and px[i + r] == px[i] and r < 255: r += 1
            stream += bytes([r, px[i]]); i += r
        offs.append(len(data)); data += stream
        assets.append((name, size, img.size, rect, rgb565(FILL[fk]), pal565))
        q.convert("RGB").save(WEB / f"{name}_{size}.png"); meta[f"{name}_{size}"] = {"w": img.size[0], "h": img.size[1], "text": list(rect), "fill": "#%02x%02x%02x" % FILL[fk]}
        print(f"{name:6s} {size}: text rect {rect}  rle {len(stream)} B")
(WEB / "meta.json").write_text(json.dumps(meta, indent=1))
out.append(f"#define BUB_COUNT {len(assets)}")
out.append("enum BubStyle : uint8_t { " + ", ".join(f"BUBS_{n.upper()}" for n, *_ in STYLES) + " };  // asset id = style*2 + (0 full, 1 half)")
out.append("static const uint8_t BUB_W[BUB_COUNT] PROGMEM = {" + ",".join(str(a[2][0]) for a in assets) + "};")
out.append("static const uint8_t BUB_H[BUB_COUNT] PROGMEM = {" + ",".join(str(a[2][1]) for a in assets) + "};")
out.append("static const uint8_t BUB_TEXT[BUB_COUNT][4] PROGMEM = {" + ",".join("{%d,%d,%d,%d}" % a[3] for a in assets) + "};   // text rect x,y,w,h inside the shell")
out.append("static const uint16_t BUB_FILL[BUB_COUNT] PROGMEM = {" + ",".join("0x%04X" % a[4] for a in assets) + "};")
out.append("static const uint32_t BUB_OFF[BUB_COUNT + 1] PROGMEM = {" + ",".join(map(str, offs)) + f",{len(data)}" + "};")
out.append("static const uint16_t BUB_PAL[BUB_COUNT][32] PROGMEM = {\n" + ",\n".join("  {" + ",".join("0x%04X" % c for c in a[5]) + "}" for a in assets) + "\n};")
out.append(f"static const uint8_t BUB_DATA[{len(data)}] PROGMEM = {{")
for i in range(0, len(data), 32): out.append("  " + ",".join(f"0x{b:02X}" for b in data[i:i + 32]) + ",")
out.append("};")
(HERE / "usagi_bubbles.h").write_text("\n".join(out) + "\n")
print("total flash ~", len(data) + len(assets) * 64)
# contact sheet
sheet = Image.new("RGB", (196 * 2 + 30, (112 + 54 + 20) * 6), BG)
for i, (name, size, sz, rect, fill, pal) in enumerate(assets):
    im = Image.open(WEB / f"{name}_{size}.png"); sheet.paste(im, (10 if size == "full" else 216, (i // 2) * 186 + 6))
sheet.save("/tmp/bubbles_sheet.png")
