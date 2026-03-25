# Mouse Warp

A GNOME Shell extension that proportionally maps mouse cursor movement between monitors of different sizes. The Linux/Wayland answer to [LittleBigMouse](https://github.com/mgth/LittleBigMouse).

## The problem

When a smaller monitor sits above (or below) a wider monitor row, GNOME only lets the cursor cross where the monitors physically overlap in logical pixel space. The edges outside that overlap are dead zones — the cursor gets stuck.

```
            ┌──────────────┐
            │   1920×1080  │  ← TV
            └──────────────┘
  ┌──────────────┐┌──────────────┐
  │  2560×1440   ││  2560×1440   │  ← two desk monitors
  └──────────────┘└──────────────┘
  ↑ dead zone               dead zone ↑
```

You can only reach the TV from the narrow center strip. Moving the mouse up from the far left or right hits an invisible wall.

## The fix

Mouse Warp scales the x-coordinate proportionally when the cursor crosses (or tries to cross) between monitor rows of different widths:

```
ratio = (x − sourceLeft) / sourceWidth
newX  = targetLeft + ratio × targetWidth
```

- **Dead zones** — detects pressure (consecutive motion events stuck at the edge) and warps the cursor to the proportional position on the adjacent row.
- **Overlap zone** — when the cursor crosses naturally, the x-coordinate is remapped so the full width of one row maps onto the full width of the other.

The result: moving the mouse straight up from the far-right of your desk monitors lands on the far-right of the TV, not at the overlap boundary.

## Install

```bash
make install
gnome-extensions enable mouse-warp@djmsqrvve
```

Then log out and back in (Wayland requires a session restart).

To uninstall:

```bash
make uninstall
```

## dj-cli integration

The `dj display 3` command (Full Array layout) positions HDMI-1 flush-left at `(0, 0)` so Mouse Warp can proportionally map the full 1920px top row onto the 5120px bottom row (DP-3 + DP-1). This eliminates dead zones at both edges of the TV.

```
┌──────────────────┐
│     HDMI-1       │
│  1920×1080 @60Hz │
│     (0, 0)       │
├──────────────────┴──────────┬─────────────────────────────┐
│         DP-3                │          DP-1 ★primary      │
│    2560×1440 @60Hz          │     2560×1440 @170Hz        │
│       (0, 1080)             │       (2560, 1080)          │
└─────────────────────────────┴─────────────────────────────┘
```

Enable the extension after switching to layout 3 — the proportional mapping and visual feedback activate automatically.

## How it works

1. On `enable()`, the extension reads `Main.layoutManager.monitors` and groups them into horizontal rows by Y-coordinate.
2. Adjacent rows with different total x-spans get a proportional mapping boundary registered.
3. A `captured-event` handler on the global stage watches every pointer motion event:
   - If the cursor just changed monitors across a boundary → remap x proportionally.
   - If the cursor is stuck in a dead zone at a boundary → count pressure, then warp after a threshold.
4. On monitor hot-plug (`monitors-changed`), boundaries are recalculated automatically.

No configuration needed for layout detection — it auto-detects your layout.

## Configuration

This extension comes with a preferences window and a system tray toggle to customize your experience:

- **Settings Menu**: Adjust the 'Edge Tolerance' and 'Pressure Threshold (ms)' to fine-tune the warping sensitivity.
- **System Tray**: A quick toggle is available from the GNOME system tray status area (look for the mouse icon), letting you enable or disable the warp functionality instantly.
- **Time-Based Physics Engine**: The dead-zone physics engine uses a time-based approach for smooth and hardware-agnostic warping, independent of your monitor's refresh rate.
- **Visual Feedback**: The warped pointer leaves a temporary glowing visual ripple so you never lose track of your cursor when traversing massive screen expanses.

## Testing

Run the full test suite (154 assertions) locally:

```bash
bash tests/run_tests.sh
```

Or via Docker (includes GSettings schema compilation validation):

```bash
docker compose run tests
```

CI runs automatically on push/PR via GitHub Actions.

## Compatibility

- GNOME Shell 47–50
- Wayland and X11 (uses `ClutterSeat.warp_pointer`)
- Any number of monitors in any row arrangement
- Nvidia and Mesa drivers

## License

MIT
