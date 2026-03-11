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

## How it works

1. On `enable()`, the extension reads `Main.layoutManager.monitors` and groups them into horizontal rows by Y-coordinate.
2. Adjacent rows with different total x-spans get a proportional mapping boundary registered.
3. A `captured-event` handler on the global stage watches every pointer motion event:
   - If the cursor just changed monitors across a boundary → remap x proportionally.
   - If the cursor is stuck in a dead zone at a boundary → count pressure, then warp after a threshold.
4. On monitor hot-plug (`monitors-changed`), boundaries are recalculated automatically.

No configuration needed — it auto-detects your layout.

## Compatibility

- GNOME Shell 47–50
- Wayland and X11 (uses `ClutterSeat.warp_pointer`)
- Any number of monitors in any row arrangement
- Nvidia and Mesa drivers

## License

MIT
