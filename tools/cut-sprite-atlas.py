#!/usr/bin/env python3
"""
Cuts a raw character sheet into the atlases `client/src/render/sprites.js` expects.

    # walk sheet -> 3 frames x 4 directions
    python tools/cut-sprite-atlas.py mage.png client/src/render/sprites/mage.png \
        --rows 0 1m 1 3

    # ability sheet -> one row of frames, on the same body scale
    python tools/cut-sprite-atlas.py warrior_attack_360.png \
        client/src/render/sprites/warrior-whirlwind.png --action --source-grid 3x2

Raw sheets — hand drawn or generated — are never aligned well enough to use
directly: the cells drift by a few pixels and each pose has its own bounding
box, so swapping frames makes the character slide and bob. This finds every
sprite by its alpha, then re-lays them out on a fixed grid anchored where it
actually matters: THE FEET, and the centre of the body.

WALK MODE writes 3 columns (frames) x 4 rows (DOWN, LEFT, RIGHT, UP), matching
`DIR`. `--rows` says which source row fills each of those four, and a trailing
`m` mirrors it — most sheets only draw one side, so the other is `Nm`.

ACTION MODE writes a single row of every frame, in reading order, into a wider
cell. Two things make it line up with the walk atlas rather than pop:

  * the body is normalised to the same height and the feet to the same
    baseline, so the swap is invisible;
  * anchoring IGNORES THE SPELL EFFECT. A sweep of light is half the width of
    the image and moves every frame — anchor on that and the knight jitters
    around inside his own animation.

Requires: pillow, numpy.
"""

import argparse
import os
import sys

import numpy as np
from PIL import Image

# Must match the constants in client/src/render/sprites.js.
CELL_W, CELL_H = 144, 192
ACTION_CELL_W = 352
FEET_Y = 186
TOP_MARGIN = 5
WALK_FRAMES = 3

# Alpha above this counts as sprite rather than as the resize's soft tail.
SOLID = 40

# --key-background: colour distance from the plate at which a pixel goes from
# fully transparent to fully opaque. The ramp between the two is what keeps the
# outline soft instead of leaving a hard fringe of the old background around it.
# LOW also has to clear the DROP SHADOW, which is the plate colour darkened —
# keep it and the character drags a purple puddle onto the grass.
KEY_LOW, KEY_HIGH = 46, 82


def bands(profile, gap=8):
    """Contiguous runs of occupied lines, merged across short gaps."""
    out, start, blank = [], None, 0
    for i, occupied in enumerate(profile):
        if occupied:
            if start is None:
                start = i
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
    """
    Row bands of the sheet, and the column bands WITHIN each one.

    Columns are found per row rather than once for the whole sheet. Poses do not
    line up between rows — a dragon's wings sit further out than its back view —
    so the union of every row's columns can cover the gaps and collapse the grid
    into a single band. Inside one row they always separate.

    @returns (row_bands, cols_per_row)
    """
    solid = alpha > SOLID
    found_rows = bands(solid.any(axis=1))
    per_row = [bands(solid[r0 : r1 + 1].any(axis=0)) for r0, r1 in found_rows]

    bad = [i for i, cs in enumerate(per_row) if len(cs) != cols]
    if len(found_rows) != rows or bad:
        detail = "\n".join(f"  row {i}: {per_row[i]}" for i in bad)
        sys.exit(
            f"expected a {cols}x{rows} grid, found {len(found_rows)} rows"
            f"{' with bad columns' if bad else ''}.\n"
            f"  rows: {found_rows}\n{detail}"
        )
    return found_rows, per_row


def key_background(sheet):
    """
    Turns a flat colour plate into transparency.

    Some sheets arrive matted onto a solid colour instead of cut out. The plate
    is the one colour that fills the border, and it is uniform to within a
    couple of levels, so distance from it separates cleanly — the armour here
    overlaps the background by 1% of pixels. Alpha ramps rather than switches,
    which is what stops a hard rim of the old colour surviving along the outline.
    """
    rgb = sheet[..., :3]
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    plate = np.median(border, axis=0)

    distance = np.linalg.norm(rgb - plate, axis=2)
    alpha = np.clip((distance - KEY_LOW) / (KEY_HIGH - KEY_LOW), 0, 1)[..., None]

    # UNDO THE MATTE, do not merely hide it. A soft pixel is `art * a + plate *
    # (1 - a)`; dropping alpha alone leaves the plate's colour mixed into it, and
    # dust clouds — which are soft all the way through — come out tinted purple
    # rather than brown. Recovering `art` costs one divide.
    art = np.where(alpha > 0.01, (rgb - plate * (1 - alpha)) / np.maximum(alpha, 1e-6), 0)

    out = sheet.copy()
    out[..., :3] = np.clip(art, 0, 255)
    out[..., 3] = alpha[..., 0] * 255
    print(f"  keyed out background {plate.astype(int)}")
    return out


def body_mask(sheet, drop_effect):
    """
    Everything that is the CHARACTER, optionally with a spell effect masked out.

    Effects in these sheets are saturated light — gold, and much hotter in red
    than in blue. Armour and cloth are near-grey even where they are bright, so
    the difference between the channels separates them without a hand-drawn
    mask. Trim on the armour is gold too, but it is a few pixels against a body
    of grey, so it never moves the anchor.

    ONLY ACTION SHEETS get this. On a walk sheet there is no effect to remove
    and the same test would eat the art itself — the hunter's blond hair is
    exactly the colour it looks for.
    """
    solid = sheet[..., 3] > SOLID
    if not drop_effect:
        return solid
    red, blue = sheet[..., 0], sheet[..., 2]
    return solid & ~((red - blue > 60) & (red > 190))


def anchor_of(mask, r0, r1, c0, c1):
    """Feet baseline and body centre of one sprite, in sheet coordinates."""
    sub = mask[r0 : r1 + 1, c0 : c1 + 1]
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


def isolate(src, row_band, col_band, pad):
    """
    The sheet with everything but this one sprite erased.

    The window a cell is sampled from is sized for the ART, not for the source
    grid, so a wide pose reaches past its own cell — an action cell is over 600
    source pixels across on a sheet whose frames sit 500 apart. Sampling the
    sheet directly drags the neighbour's sword sweep in as a bright crescent
    floating beside the character. Bands never touch, so cutting on them is
    exact.
    """
    r0, r1 = row_band
    c0, c1 = col_band
    only = Image.new("RGBA", src.size, (0, 0, 0, 0))
    box = (c0 + pad, r0 + pad, c1 + pad + 1, r1 + pad + 1)
    only.paste(src.crop(box), (box[0], box[1]))
    return only


def parse_grid(spec):
    try:
        cols, rows = (int(n) for n in spec.lower().split("x"))
        return cols, rows
    except ValueError:
        sys.exit(f"--source-grid wants COLSxROWS, got {spec!r}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("dest")
    ap.add_argument(
        "--rows",
        nargs=4,
        metavar=("DOWN", "LEFT", "RIGHT", "UP"),
        help="walk mode: source row per direction; 'm' mirrors it, e.g. 0 1m 1 3",
    )
    ap.add_argument(
        "--action",
        action="store_true",
        help="ability mode: one row of every frame, in a wider cell",
    )
    ap.add_argument("--source-grid", default=None, metavar="COLSxROWS")
    ap.add_argument(
        "--key-background",
        action="store_true",
        help="the sheet has a flat colour plate instead of transparency; drop it",
    )
    ap.add_argument(
        "--scale",
        type=float,
        default=1.0,
        help="trim the fitted scale, to match a class whose art has a tall plume "
        "or a raised weapon eating the cell (e.g. 0.95)",
    )
    args = ap.parse_args()

    if not args.action and not args.rows:
        sys.exit("pass --rows (walk sheet), --action (ability sheet), or both")

    cols, rows = parse_grid(args.source_grid) if args.source_grid else (
        (WALK_FRAMES, 2) if args.action and not args.rows else (WALK_FRAMES, 4)
    )

    sheet = np.array(Image.open(args.source).convert("RGBA")).astype(np.float64)
    if args.key_background:
        sheet = key_background(sheet)
    row_bands, cols_per_row = detect_grid(sheet[..., 3], rows, cols)
    mask = body_mask(sheet, drop_effect=args.action)

    anchors = {
        (ri, ci): anchor_of(mask, r0, r1, c0, c1)
        for ri, (r0, r1) in enumerate(row_bands)
        for ci, (c0, c1) in enumerate(cols_per_row[ri])
    }
    restore_clipped_baselines(anchors, sheet.shape[0])

    # (source row, source column, mirror) per destination cell, laid out left to
    # right then top to bottom. `--action` only widens the cell, so an ability
    # drawn per direction takes `--rows` exactly like a walk sheet.
    cell_w = ACTION_CELL_W if args.action else CELL_W
    if args.rows:
        grid_w = WALK_FRAMES
        plan = [
            [(int(spec.rstrip("m")), ci, spec.endswith("m")) for ci in range(WALK_FRAMES)]
            for spec in args.rows
        ]
    else:
        grid_w = cols * rows
        plan = [[(ri, ci, False) for ri in range(rows) for ci in range(cols)]]

    used = [anchors[(ri, ci)] for row in plan for ri, ci, _ in row]

    # One scale for every frame, so the poses keep their relative sizes. In
    # action mode the width is not a constraint: the cell is sized for the
    # effect, and only the BODY has to match what the walk atlas produced.
    fit = (FEET_Y - TOP_MARGIN) / max(a["ay"] - a["top"] for a in used)
    if not args.action:
        fit = min(
            fit,
            (CELL_W / 2 - 2) / max(max(a["ax"] - a["left"], a["right"] - a["ax"]) for a in used),
        )
    scale = args.scale * fit

    # Premultiply before resampling: over straight alpha the filter drags the
    # transparent black border into the outline and leaves a dark fringe.
    premultiplied = sheet.copy()
    premultiplied[..., :3] *= premultiplied[..., 3:4] / 255.0
    pad = max(cell_w, CELL_H) * 3
    padded = np.zeros((sheet.shape[0] + 2 * pad, sheet.shape[1] + 2 * pad, 4))
    padded[pad : pad + sheet.shape[0], pad : pad + sheet.shape[1]] = premultiplied
    src = Image.fromarray(padded.astype(np.uint8), "RGBA")

    atlas = Image.new("RGBA", (cell_w * grid_w, CELL_H * len(plan)), (0, 0, 0, 0))
    for dst_row, cells in enumerate(plan):
        for dst_col, (src_row, src_col, mirror) in enumerate(cells):
            a = anchors[(src_row, src_col)]
            ax, ay = a["ax"] + pad, a["ay"] + pad
            # The source window that lands the anchor on (cell_w / 2, FEET_Y).
            box = (
                ax - (cell_w / 2) / scale,
                ay - FEET_Y / scale,
                ax + (cell_w / 2) / scale,
                ay + (CELL_H - FEET_Y) / scale,
            )
            band = cols_per_row[src_row][src_col]
            cell = isolate(src, row_bands[src_row], band, pad).resize(
                (cell_w, CELL_H), Image.LANCZOS, box=box
            )
            if mirror:
                cell = cell.transpose(Image.FLIP_LEFT_RIGHT)
            atlas.paste(cell, (dst_col * cell_w, dst_row * CELL_H))

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
