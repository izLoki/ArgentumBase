#!/usr/bin/env python3
"""
Cuts a raw character sheet into the atlas `client/src/render/sprites.js` expects.

    python tools/cut-sprite-atlas.py mage.png client/src/render/sprites/mage.png \
        --rows 0 1m 1 3

Raw sheets — hand drawn or generated — are never aligned well enough to use
directly: the cells drift by a few pixels and each pose has its own bounding
box, so swapping frames makes the character slide and bob. This finds every
sprite by its alpha, then re-lays them out on a fixed grid anchored where it
actually matters: THE FEET, and the centre of the body.

Output is 3 columns (walk frames) x 4 rows (DOWN, LEFT, RIGHT, UP), matching
`DIR`. `--rows` says which source row fills each of those four, and a trailing
`m` mirrors it — most sheets only draw one side, so the other is `Nm`.

Requires: pillow, numpy.
"""

import argparse
import os
import sys

import numpy as np
from PIL import Image

# Must match the constants in client/src/render/sprites.js.
CELL_W, CELL_H = 144, 192
FEET_Y = 186
TOP_MARGIN = 5
WALK_FRAMES = 3

# Alpha above this counts as sprite rather than as the resize's soft tail.
SOLID = 40


def bands(profile, gap=8):
    """Contiguous runs of occupied lines, merged across short gaps."""
    out, start, blank = [], None, 0
    for i, occupied in enumerate(profile):
        if occupied:
            if start is None:
                start = i - blank if blank and out and start is None else i
            blank = 0
        elif start is not None:
            blank += 1
            if blank > gap:
                out.append((start, i - blank))
                start, blank = None, 0
    if start is not None:
        out.append((start, len(profile) - 1))
    return out


def detect_grid(alpha, rows, cols):
    """Row and column bands of the source sheet, found from its alpha."""
    solid = alpha > SOLID
    found_rows = bands(solid.any(axis=1))
    found_cols = bands(solid.any(axis=0))
    if len(found_rows) != rows or len(found_cols) != cols:
        sys.exit(
            f"expected a {cols}x{rows} grid, found {len(found_cols)}x{len(found_rows)}.\n"
            f"  rows: {found_rows}\n  cols: {found_cols}"
        )
    return found_rows, found_cols


def anchor_of(solid, r0, r1, c0, c1):
    """Feet baseline and body centre of one sprite, in sheet coordinates."""
    sub = solid[r0 : r1 + 1, c0 : c1 + 1]
    ys, xs = np.nonzero(sub)
    top, bottom = ys.min(), ys.max()
    # Horizontal centre from the bottom fifth only. A staff or a swinging arm
    # drags the full bounding box sideways frame by frame; the feet do not.
    band = sub[max(top, bottom - (bottom - top) // 5) : bottom + 1, :]
    return dict(
        ax=c0 + np.nonzero(band)[1].mean(),
        ay=float(r0 + bottom),
        top=float(r0 + top),
        left=float(c0 + xs.min()),
        right=float(c0 + xs.max()),
    )


def restore_clipped_baselines(anchors, sheet_h):
    """
    Puts the feet back under a sprite the sheet cut off at its bottom edge.

    Generated sheets sometimes run a row off the canvas, taking the boots with
    it. Anchoring such a sprite on the cut would stand it on its shins: it would
    render short AND too low. There is nothing to recover the missing pixels
    from, but the BASELINE is recoverable — the intact poses agree on how tall
    this character is — so the sprite is placed at its true height and the few
    missing rows simply stay transparent.
    """
    clipped = [k for k, a in anchors.items() if a["ay"] >= sheet_h - 2]
    if not clipped:
        return

    intact = [a["ay"] - a["top"] for k, a in anchors.items() if k not in clipped]
    if not intact:
        sys.exit("every sprite in this sheet is clipped at the bottom edge")
    intended = float(np.median(intact))

    missing = 0.0
    for key in clipped:
        a = anchors[key]
        lost = max(0.0, intended - (a["ay"] - a["top"]))
        a["ay"] += lost
        missing = max(missing, lost)

    rows = sorted({ri for ri, _ in clipped})
    print(
        f"  WARNING: source row(s) {rows} run off the bottom of the sheet.\n"
        f"  Their baseline was reconstructed from the intact poses, so they stand\n"
        f"  at the right height — but ~{missing:.0f} px of feet are not in the\n"
        f"  source at all. Re-export the sheet taller to fix it properly.",
        file=sys.stderr,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("dest")
    ap.add_argument(
        "--rows",
        nargs=4,
        required=True,
        metavar=("DOWN", "LEFT", "RIGHT", "UP"),
        help="source row per direction; suffix 'm' mirrors it, e.g. 0 1m 1 3",
    )
    ap.add_argument("--source-rows", type=int, default=4)
    ap.add_argument(
        "--scale",
        type=float,
        default=1.0,
        help="trim the fitted scale, to match a class whose art has a tall plume "
        "or a raised weapon eating the cell (e.g. 0.95)",
    )
    args = ap.parse_args()

    plan = [(int(spec.rstrip("m")), spec.endswith("m")) for spec in args.rows]

    sheet = np.array(Image.open(args.source).convert("RGBA")).astype(np.float64)
    solid = sheet[..., 3] > SOLID
    row_bands, col_bands = detect_grid(sheet[..., 3], args.source_rows, WALK_FRAMES)

    anchors = {
        (ri, ci): anchor_of(solid, r0, r1, c0, c1)
        for ri, (r0, r1) in enumerate(row_bands)
        for ci, (c0, c1) in enumerate(col_bands)
    }
    restore_clipped_baselines(anchors, sheet.shape[0])
    used = [anchors[(ri, ci)] for ri, _ in plan for ci in range(WALK_FRAMES)]

    # One scale for every frame, so the directions keep their relative sizes.
    scale = args.scale * min(
        (FEET_Y - TOP_MARGIN) / max(a["ay"] - a["top"] for a in used),
        (CELL_W / 2 - 2) / max(max(a["ax"] - a["left"], a["right"] - a["ax"]) for a in used),
    )

    # Premultiply before resampling: over straight alpha the filter drags the
    # transparent black border into the outline and leaves a dark fringe.
    premultiplied = sheet.copy()
    premultiplied[..., :3] *= premultiplied[..., 3:4] / 255.0
    pad = max(CELL_W, CELL_H) * 3
    padded = np.zeros((sheet.shape[0] + 2 * pad, sheet.shape[1] + 2 * pad, 4))
    padded[pad : pad + sheet.shape[0], pad : pad + sheet.shape[1]] = premultiplied
    src = Image.fromarray(padded.astype(np.uint8), "RGBA")

    atlas = Image.new("RGBA", (CELL_W * WALK_FRAMES, CELL_H * len(plan)), (0, 0, 0, 0))
    for dst_row, (src_row, mirror) in enumerate(plan):
        for ci in range(WALK_FRAMES):
            a = anchors[(src_row, ci)]
            ax, ay = a["ax"] + pad, a["ay"] + pad
            # The source window that lands the anchor on (CELL_W/2, FEET_Y).
            box = (
                ax - (CELL_W / 2) / scale,
                ay - FEET_Y / scale,
                ax + (CELL_W / 2) / scale,
                ay + (CELL_H - FEET_Y) / scale,
            )
            cell = src.resize((CELL_W, CELL_H), Image.LANCZOS, box=box)
            if mirror:
                cell = cell.transpose(Image.FLIP_LEFT_RIGHT)
            atlas.paste(cell, (ci * CELL_W, dst_row * CELL_H))

    out = np.array(atlas).astype(np.float64)
    alpha = out[..., 3:4]
    out[..., :3] = np.where(alpha > 0, np.clip(out[..., :3] * 255.0 / np.maximum(alpha, 1e-6), 0, 255), 0)
    # Drop the near-invisible tail the resize smeared past the outline.
    out[..., 3] = np.where(out[..., 3] < 8, 0, out[..., 3])

    os.makedirs(os.path.dirname(os.path.abspath(args.dest)), exist_ok=True)
    Image.fromarray(out.astype(np.uint8), "RGBA").save(args.dest, optimize=True)
    print(f"{args.dest}  {atlas.size[0]}x{atlas.size[1]}  scale {scale:.4f}")


if __name__ == "__main__":
    main()
