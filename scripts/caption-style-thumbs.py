#!/usr/bin/env python3
"""Draws public/caption-styles/<id>.webp: each caption style as the compositor really draws it.

Needs Pillow and numpy. Run after changing a style:
    python3 scripts/caption-style-thumbs.py
With --frame <image> --text "..." --sheet <out.png> it makes a proof sheet on a real frame instead.
"""
import argparse, json, os, subprocess, tempfile
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser()
ap.add_argument("--frame"); ap.add_argument("--text", default="your next video"); ap.add_argument("--sheet"); ap.add_argument("--dark", type=float, default=1.0)
ap.add_argument("--cols", type=int, default=8); ap.add_argument("--only", default="")
a = ap.parse_args()
tmp = tempfile.mkdtemp()
looks_path = os.path.join(tmp, "looks.json")
subprocess.run(["npx", "vitest", "run", "styleThumbs.gen"], cwd=ROOT, check=True, capture_output=True,
               env=dict(os.environ, CAPTION_THUMBS_OUT=looks_path, CAPTION_THUMBS_TEXT=a.text))
looks = json.load(open(looks_path))
if a.only:
    want = a.only.split(","); looks = [l for l in looks if l["name"] in want]
    json.dump(looks, open(looks_path, "w"))
r = subprocess.run(["cargo", "test", "--lib", "fx_look_sheet", "--", "--ignored", "--nocapture"], cwd=os.path.join(ROOT, "crates/compositor"),
                   env=dict(os.environ, FX_LOOKS=looks_path, FX_OUT=tmp), capture_output=True, text=True)
if "test result: ok" not in r.stdout:
    raise SystemExit(r.stdout[-2000:] + r.stderr[-2000:])
print("slowest:", sorted((int(x.split(": ")[1].split()[0]), x.split(":")[0]) for x in r.stderr.splitlines() + r.stdout.splitlines() if x.endswith(" ms"))[-3:])

if a.frame:
    bg = np.asarray(Image.open(a.frame).convert("RGB").resize((1080, 1920))).astype(np.float32) * a.dark
else:
    # A dark studio wall, not a person: these ship with the app.
    ys = np.linspace(0, 1, 1920)[:, None, None]
    bg = (np.array([70, 75, 86], np.float32) * (1 - ys) + np.array([22, 24, 29], np.float32) * ys) * np.ones((1920, 1080, 3), np.float32)

def load(l):
    m = int(open(os.path.join(tmp, l["name"] + ".margin")).read())
    raw = np.fromfile(os.path.join(tmp, l["name"] + ".bgra"), dtype=np.uint8).reshape(l["h"] + m * 2, l["w"] + m * 2, 4)
    return raw, m

def draw(l):
    raw, m = load(l)
    raw = raw.astype(np.float32)
    full = bg.copy()
    # The texture runs past the box by its margin, and may run past the frame.
    left, up = l["x"] - m, l["y"] - m
    y0, x0 = max(up, 0), max(left, 0)
    y1, x1 = min(up + raw.shape[0], 1920), min(left + raw.shape[1], 1080)
    region = full[y0:y1, x0:x1]
    raw = raw[y0 - up : y1 - up, x0 - left : x1 - left]
    alpha = raw[..., 3:4] / 255
    # The compositor's blend: One, OneMinusSourceAlpha.
    full[y0:y1, x0:x1] = np.clip(raw[..., [2, 1, 0]] + region * (1 - alpha), 0, 255)
    return full, (y0 + y1) // 2, l

if a.sheet:
    tile_w, tile_h = 300, 300
    rows = (len(looks) + a.cols - 1) // a.cols
    sheet = Image.new("RGB", (a.cols * tile_w, rows * tile_h), "#111")
    for i, l in enumerate(looks):
        full, cy, _ = draw(l)
        top = int(np.clip(cy - 540, 0, 1920 - 1080))
        tile = Image.fromarray(full[top:top + 1080].astype(np.uint8)).resize((tile_w, tile_h), Image.LANCZOS)
        sheet.paste(tile, ((i % a.cols) * tile_w, (i // a.cols) * tile_h))
    sheet.save(a.sheet)
    print([l["name"] for l in looks])
else:
    out = os.path.join(ROOT, "public/caption-styles")
    os.makedirs(out, exist_ok=True)
    for l in looks:
        full, _, _ = draw(l)
        # On the letters, not on the box they sit in: most of a caption's box is empty headroom.
        raw, m = load(l)
        rows = np.where(raw[..., 3].max(axis=1) > 200)[0]
        cy = l["y"] - m + (int(rows.mean()) if len(rows) else l["h"] // 2)
        band = 608  # The whole width of the frame, at 16:9.
        top = int(np.clip(cy - band // 2, 0, 1920 - band))
        crop = Image.fromarray(full[top:top + band].astype(np.uint8)).resize((320, 180), Image.LANCZOS)
        crop.save(os.path.join(out, l["name"] + ".webp"), quality=82, method=6)
    print(len(looks), "thumbnails")
