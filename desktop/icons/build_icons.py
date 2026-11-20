#!/usr/bin/env python3
"""Render meridian_icon.svg into the platform icons Tauri bundles.

Writes directly into ``desktop/src-tauri/icons/`` so the next ``tauri
build`` picks them up with no copy step:

    icon.icns           macOS .app bundle icon
    icon.ico            Windows .exe / installer icon
    icon.png            generic PNG (used by some Tauri tooling)
    32x32.png
    128x128.png
    128x128@2x.png      (256×256)

Intermediate PNGs (the full .iconset and per-size Windows PNGs) land in
``build/`` next to this script — gitignored.

Requirements (macOS host, since iconutil is mac-only):
    brew install cairo
    DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib \
        uv run --with cairosvg --with Pillow python3 build_icons.py
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from io import BytesIO
from pathlib import Path

try:
    import cairosvg
except ImportError:
    sys.exit("Missing cairosvg — run: pip install cairosvg")

try:
    from PIL import Image
except ImportError:
    sys.exit("Missing Pillow — run: pip install Pillow")


SCRIPT_DIR = Path(__file__).resolve().parent
SVG_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else SCRIPT_DIR / "meridian_icon.svg"
BUILD_DIR = SCRIPT_DIR / "build"
ICONSET = BUILD_DIR / "meridian.iconset"
WIN_DIR = BUILD_DIR / "win"
TARGET_DIR = SCRIPT_DIR.parent / "src-tauri" / "icons"

if not SVG_PATH.exists():
    sys.exit(f"SVG not found: {SVG_PATH}")
if not TARGET_DIR.exists():
    sys.exit(f"Tauri icons dir not found: {TARGET_DIR}")

# Apple requires exactly these filenames inside a .iconset folder;
# iconutil compiles them into a .icns.
MACOS_SIZES = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

# ICO bundles all of these into one file.
WIN_SIZES = [16, 24, 32, 48, 64, 96, 128, 256]


# Apple's icon grid is technically 824/1024 = 0.8047, but that
# assumes the Big Sur "squircle" shape. Our SVG uses a rounded
# rectangle, which reads as visually heavier (the corners curve less
# gently than a squircle), so the icon still appears larger than
# first-party apps in the Dock at the strict Apple value. Shrinking
# to 0.75 compensates without redesigning the shape — first-party
# icons typically read as ~75-80% of the canvas including their
# shadow falloff.
#
# Source SVG stays at full canvas (no padding) — only icons get this
# treatment; the splash uses the artwork at full size.
_ICON_BODY_FRACTION = 0.75


def render(size: int) -> Image.Image:
    """Render the artwork into a transparent ``size×size`` canvas with
    icon-grid padding. The visible body is ~80% of the target.
    """
    body_size = max(int(round(size * _ICON_BODY_FRACTION)), 1)
    png_bytes = cairosvg.svg2png(
        url=str(SVG_PATH),
        output_width=body_size,
        output_height=body_size,
    )
    body = Image.open(BytesIO(png_bytes)).convert("RGBA")
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    offset = (size - body_size) // 2
    canvas.paste(body, (offset, offset), body)
    return canvas


def build_macos() -> None:
    print("\n── macOS .icns ───────────────────────────────────────")
    if ICONSET.exists():
        shutil.rmtree(ICONSET)
    ICONSET.mkdir(parents=True)

    rendered: dict[int, Image.Image] = {}
    for filename, size in MACOS_SIZES:
        if size not in rendered:
            print(f"  rendering {size}×{size}")
            rendered[size] = render(size)
        rendered[size].save(ICONSET / filename, "PNG")

    if not shutil.which("iconutil"):
        print("  iconutil not found — must run on macOS to produce .icns")
        return

    result = subprocess.run(
        ["iconutil", "-c", "icns", str(ICONSET), "-o", str(TARGET_DIR / "icon.icns")],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        sys.exit(f"iconutil failed: {result.stderr.strip()}")
    print(f"  ✓ {TARGET_DIR / 'icon.icns'}")

    # Also drop the three sizes Tauri lists in tauri.conf.json's
    # bundle.icon array (used in addition to the .icns on macOS and
    # standalone on Linux).
    for src_name, dst_name in (
        ("icon_32x32.png", "32x32.png"),
        ("icon_128x128.png", "128x128.png"),
        ("icon_128x128@2x.png", "128x128@2x.png"),
        ("icon_512x512.png", "icon.png"),
    ):
        shutil.copy2(ICONSET / src_name, TARGET_DIR / dst_name)
        print(f"  ✓ {TARGET_DIR / dst_name}")


def build_windows() -> None:
    print("\n── Windows .ico ──────────────────────────────────────")
    if WIN_DIR.exists():
        shutil.rmtree(WIN_DIR)
    WIN_DIR.mkdir(parents=True)

    images: list[Image.Image] = []
    for size in WIN_SIZES:
        print(f"  rendering {size}×{size}")
        img = render(size)
        images.append(img)
        img.save(WIN_DIR / f"meridian_{size}.png", "PNG")

    # Save the largest image as the ICO base — Pillow downsamples from
    # it to the requested sizes. Passing a small base + ``append_images``
    # silently produces an upscaled blurry file.
    ico_path = TARGET_DIR / "icon.ico"
    images[-1].save(
        ico_path,
        format="ICO",
        sizes=[(s, s) for s in WIN_SIZES],
    )
    print(f"  ✓ {ico_path} ({ico_path.stat().st_size // 1024} KB)")

    # Reuse the 64×64 for the Tauri ``64x64.png`` slot.
    shutil.copy2(WIN_DIR / "meridian_64.png", TARGET_DIR / "64x64.png")
    print(f"  ✓ {TARGET_DIR / '64x64.png'}")


if __name__ == "__main__":
    print("Meridian icon builder")
    print(f"  source: {SVG_PATH}")
    print(f"  target: {TARGET_DIR}")
    BUILD_DIR.mkdir(exist_ok=True)
    build_macos()
    build_windows()
    print("\n✓ done")
