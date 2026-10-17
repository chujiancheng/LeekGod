# -*- coding: utf-8 -*-
"""清理开户四宫格漫画右下角生成水印，并按 A1..D4 落到项目目录。

用法: python clean_watermark.py
水印处理: 用水印框正上方同尺寸区域的平均色填充(背景为近似纯色奶油底,
肉眼在游戏展示尺寸下不可见),再叠加轻微噪点避免色块感。
"""
from pathlib import Path
import random

from PIL import Image, ImageDraw

SRC = Path(r"E:\Work\Gushen\onboarding-comic_assets")
DST = Path(r"E:\Work\Gushen\art\onboarding-comic")
DST.mkdir(parents=True, exist_ok=True)

PANELS = {
    "A1": "96f4f3ba-miora_edit_image-1792206040612-0-835c0601ff65.png",
    "A2": "2ed8c720-miora_edit_image-1792206046090-0-9b10db93472c.png",
    "A3": "a08e3479-miora_edit_image-1792206042476-0-6bec529144ae.png",
    "A4": "b65135d1-miora_edit_image-1792206044247-0-3da263256b89.png",
    "B1": "09611da3-miora_edit_image-1792206104511-0-9b7990c3d63b.png",
    "B2": "58ae9953-miora_edit_image-1792206099050-0-3a718a0087d7.png",
    "B3": "48867870-miora_edit_image-1792206103899-0-6c644bfde6c1.png",
    "B4": "404254f7-miora_edit_image-1792206103045-0-d2e34c0dae99.png",
    "C1": "104c3637-miora_edit_image-1792206161653-0-176ad81132a5.png",
    "C2": "21234b19-miora_edit_image-1792206163150-0-a1cf3a782bef.png",
    "C3": "d793f417-miora_edit_image-1792206161095-0-3d8fdb777daf.png",
    "C4": "fc93f950-miora_edit_image-1792206161649-0-240a1254e338.png",
    "D1": "0abc4768-miora_edit_image-1792206213913-0-8eb9c5db227b.png",
    "D2": "b22027f0-miora_edit_image-1792206213949-0-c38750062212.png",
    "D3": "0c1b8bc8-miora_edit_image-1792206213152-0-b3f4e0de71e8.png",
    "D4": "900f8d09-miora_edit_image-1792206213297-0-b67a519bcffe.png",
}


def clean(im: Image.Image) -> Image.Image:
    w, h = im.size
    # 水印框: 右下角 24% 宽 x 8% 高
    bw, bh = int(w * 0.24), int(h * 0.08)
    x0, y0 = w - bw, h - bh
    # 取水印框正上方同宽区域的平均色
    sample = im.crop((x0, y0 - bh, w, y0)).resize((1, 1), Image.LANCZOS)
    r, g, b = sample.getpixel((0, 0))[:3]
    # 轻微噪点填充,避免平色块感
    patch = Image.new("RGB", (bw, bh), (r, g, b))
    px = patch.load()
    rnd = random.Random(42)
    for yy in range(bh):
        for xx in range(bw):
            d = rnd.randint(-4, 4)
            px[xx, yy] = (
                max(0, min(255, r + d)),
                max(0, min(255, g + d)),
                max(0, min(255, b + d)),
            )
    im.paste(patch, (x0, y0))
    return im


def main() -> None:
    for key, name in PANELS.items():
        src = SRC / name
        im = Image.open(src).convert("RGB")
        im = clean(im)
        out = DST / f"{key}.png"
        im.save(out, "PNG", optimize=True)
        print(f"{key}: {im.size[0]}x{im.size[1]} -> {out}")


if __name__ == "__main__":
    main()
