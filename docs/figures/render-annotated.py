"""Render the three annotated README figures from real screenshots.

Each figure is one real capture with numbered callouts and a legend strip, built
for a documentation page rather than a social post: no headline, 1200px wide.

Privacy: the captures come from a real machine, so the SSH host list, the local
workspace list, the account name and the remote workspace chip are masked before
anything is drawn. Keep `MASK` in sync with the capture layout when replacing a
screenshot.

Usage:
    python docs/figures/render-annotated.py
Inputs:  docs/figures/source/*.png   (2557x1637 captures)
Outputs: docs/assets/fig-probe.png, fig-connect.png, fig-multi.png
"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SOURCE = os.path.join(HERE, "source")
ASSETS = os.path.join(ROOT, "docs", "assets")
os.makedirs(ASSETS, exist_ok=True)

PREVIEW = (1638, 1049)
WIDTH = 1200
PAD = 56
BG = (255, 255, 255)
INK = (24, 24, 24)
MUTED = (110, 110, 110)
ACCENT = (255, 46, 77)
FRAME = (226, 224, 218)
BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
REG = r"C:\Windows\Fonts\msyh.ttc"

# Regions (preview coordinates) that must never reach the public repository.
MASK = [
    (366, 292, 702, 548),   # ssh host list: addresses, users, ports
    (776, 486, 1010, 548),  # remote workspace chip in the embedded DSH
    (0, 470, 350, 968),     # local workspace and conversation list
    (0, 968, 150, 1040),    # account name at the sidebar foot
]


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(BOLD if bold else REG, size)


def mask_regions(shot: Image.Image) -> Image.Image:
    sx, sy = shot.width / PREVIEW[0], shot.height / PREVIEW[1]
    for x0, y0, x1, y1 in MASK:
        box = (int(x0 * sx), int(y0 * sy), int(x1 * sx), int(y1 * sy))
        patch = shot.crop(box).filter(ImageFilter.GaussianBlur(42 * max(sx, sy) / 1.56))
        shot.paste(patch, box)
    return shot


def callout(draw: ImageDraw.ImageDraw, origin: tuple[int, int, float],
            preview_box: tuple[int, int, int, int], number: str) -> None:
    x0, y0, scale = origin
    box = [x0 + preview_box[0] * scale, y0 + preview_box[1] * scale,
           x0 + preview_box[2] * scale, y0 + preview_box[3] * scale]
    draw.rounded_rectangle(box, radius=8, outline=ACCENT, width=4)
    r = 17
    cx, cy = box[0], box[1]
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ACCENT)
    f = font(21, bold=True)
    tw = draw.textlength(number, font=f)
    draw.text((cx - tw / 2, cy - 14), number, font=f, fill=(255, 255, 255))


def figure(source: str, out: str, callouts: list[tuple[str, tuple[int, int, int, int]]],
           legend: list[str]) -> None:
    shot = Image.open(os.path.join(SOURCE, source)).convert("RGB")
    shot = mask_regions(shot)
    target_w = WIDTH - 2 * PAD
    scale = target_w / PREVIEW[0]
    shot = shot.resize((target_w, int(shot.height * target_w / shot.width)), Image.LANCZOS)

    legend_h = 34 + len(legend) * 46
    height = shot.height + PAD * 2 + legend_h
    canvas = Image.new("RGB", (WIDTH, height), BG)
    canvas.paste(shot, (PAD, PAD))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle([PAD, PAD, PAD + shot.width, PAD + shot.height], radius=10, outline=FRAME, width=2)

    for number, box in callouts:
        callout(draw, (PAD, PAD, scale), box, number)

    y = PAD + shot.height + 34
    for index, text in enumerate(legend, start=1):
        r = 15
        dx, dy = PAD + r, y + r
        draw.ellipse([dx - r, dy - r, dx + r, dy + r], fill=INK)
        f = font(19, bold=True)
        label = str(index)
        tw = draw.textlength(label, font=f)
        draw.text((dx - tw / 2, dy - 13), label, font=f, fill=(255, 255, 255))
        draw.text((PAD + 44, y), text, font=font(25), fill=INK)
        y += 46

    canvas.save(os.path.join(ASSETS, out))
    print("wrote", os.path.join("docs/assets", out), canvas.size)


figure("shot-probe.png", "fig-probe.png",
       [("1", (726, 172, 1602, 342)), ("2", (926, 340, 1044, 384))],
       ["一次探测拿到系统、Node、dsh、tmux、磁盘与 CPU",
        "远程缺模型时，从这里移植本机配置"])

figure("shot-debian.png", "fig-connect.png",
       [("1", (368, 100, 690, 218)), ("2", (1198, 662, 1522, 712))],
       ["每台机器一条，点谁连谁",
        "模型与服务商自动对齐本机配置"])

figure("shot-grid.png", "fig-multi.png",
       [("1", (368, 100, 690, 218)), ("2", (770, 120, 1590, 700))],
       ["多个目标并存，各自独立",
        "右边是那台机器自己的 DSH 界面"])
