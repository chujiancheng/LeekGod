# -*- coding: utf-8 -*-
"""把 art/onboarding-comic 的 1024 成品压成网页用 512 图，落到 Client/img。

命名：comic-<set><n>.png（set = a/b/c/d，n = 1..4），与 http.js 白名单一一对应。
1024 母版留在 art/，只把 512 的送上站（开户弹层里每格最大约 250 CSS px，2 倍屏 500px 够）。
"""
from pathlib import Path

from PIL import Image

SRC = Path(r"E:\Work\Gushen\art\onboarding-comic")
DST = Path(r"E:\Work\Gushen\Client\img")
SIZE = 512

total = 0
for set_key in "ABCD":
    for i in range(1, 5):
        src = SRC / f"{set_key}{i}.png"
        im = Image.open(src).convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)
        out = DST / f"comic-{set_key.lower()}{i}.png"
        im.save(out, "PNG", optimize=True)
        kb = out.stat().st_size / 1024
        total += kb
        print(f"{out.name}: {kb:.0f} KB")
print(f"合计 {total / 1024:.2f} MB")
