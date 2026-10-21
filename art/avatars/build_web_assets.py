# -*- coding: utf-8 -*-
"""把 art/avatars 的 1024 AI 成品压成头像素材，落到 Client/img。

源图：1024 方形 PNG（AI 生成，水印贴右下角——被圆形裁切自然丢弃）。
产出（照 Doc/头像方案.md §4.5）：
  art/avatars/<key>.png          512 母版（圆形内容 + 透明四角，不进站）
  Client/img/avatar-<key>-96.png   ≤40px 档
  Client/img/avatar-<key>-192.png  >40px 档
"""
from pathlib import Path

from PIL import Image, ImageDraw

SRC = Path(r"E:\Work\Gushen\art\avatars")
DST = Path(r"E:\Work\Gushen\Client\img")

# key -> 源文件（AI 产物文件名带时间戳，此处显式登记）
SOURCES = {
    "clipper":   SRC / "Square_avatar_illustration__ch_2026-10-21T02-52-04.png",
    "bull":      SRC / "Square_avatar_illustration__ch_2026-10-21T02-50-25.png",
    "bear":      SRC / "bear" / "Square_avatar_illustration__ch_2026-10-21T02-53-44.png",
    "zen":       SRC / "zen" / "Square_avatar_illustration__ch_2026-10-21T02-54-07.png",
    "yolo":      SRC / "Square_avatar_illustration__ch_2026-10-21T02-52-52.png",
    "keyboard":  SRC / "Square_avatar_illustration__ch_2026-10-21T02-52-59.png",
    "auntie":    SRC / "Square_avatar_illustration__ch_2026-10-21T02-52-57.png",
    "quant":     SRC / "quant" / "Square_avatar_illustration__ch_2026-10-21T02-56-05.png",
    "old":       SRC / "bagholder" / "Square_avatar_illustration__ch_2026-10-21T02-55-15.png",
    "student":   SRC / "bagholder" / "Square_avatar_illustration__ch_2026-10-21T02-54-38.png",
    "night":     SRC / "bagholder" / "Square_avatar_illustration__ch_2026-10-21T02-54-44.png",
    "bagholder": SRC / "bagholder" / "Square_avatar_illustration__ch_2026-10-21T02-55-01.png",
}

SIZES = (512, 192, 96)


def circle(im: Image.Image) -> Image.Image:
    """方形图裁成圆形内容（透明四角），半径 = 边长一半。"""
    w = im.size[0]
    mask = Image.new("L", (w, w), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, w, w), fill=255)
    out = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    out.paste(im, (0, 0), mask)
    return out


def main() -> None:
    total = 0.0
    for key, src in SOURCES.items():
        if not src.exists():
            print(f"!! 缺源 {key}: {src}")
            continue
        master = circle(Image.open(src).convert("RGBA").resize((512, 512), Image.LANCZOS))
        out_master = SRC / f"{key}.png"
        master.save(out_master, "PNG", optimize=True)
        for s in (192, 96):
            small = master.resize((s, s), Image.LANCZOS)
            out = DST / f"avatar-{key}-{s}.png"
            small.save(out, "PNG", optimize=True)
            kb = out.stat().st_size / 1024
            total += kb
            print(f"{out.name}: {kb:.0f} KB")
    print(f"合计 {total / 1024:.2f} MB")


if __name__ == "__main__":
    main()
