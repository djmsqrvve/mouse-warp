# DJ Mouse Warp

A GNOME Shell extension that proportionally maps mouse cursor movement between monitors of different sizes. The Linux/Wayland answer to [LittleBigMouse](https://github.com/mgth/LittleBigMouse).

## The Problem

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

## The Fix

Mouse Warp scales the x-coordinate proportionally when the cursor crosses (or tries to cross) between monitor rows of different widths:

```
ratio = (x − sourceLeft) / sourceWidth
newX  = targetLeft + ratio × targetWidth
```

- **Dead zones** — detects pressure (time at edge) and warps to the proportional position on the adjacent row.
- **Overlap zones** — when the cursor crosses naturally, the x-coordinate is remapped so the full width of one row maps onto the full width of the other.

The result: moving the mouse straight up from the far-right of your desk monitors lands on the far-right of the TV, not at the overlap boundary.

## Install

```bash
make install
gnome-extensions enable dj-mouse-warp@djmsqrvve
```

Then log out and back in (Wayland requires a session restart).

To uninstall:

```bash
make uninstall
```

## Supported Configurations

Mouse Warp is tested against and designed for a wide range of monitor setups. All coordinate math uses GNOME's logical pixel space from `Main.layoutManager.monitors` — no hardcoded assumptions about positions, resolutions, or orientations.

### Monitor Arrangements

| Layout | Status | Notes |
|--------|--------|-------|
| Two rows (e.g. TV above desk monitors) | Fully supported | Primary use case |
| Three+ rows stacked | Fully supported | Multi-row skip works correctly |
| Side-by-side same height | No-op | No dead zones to fix, extension idles |
| Single monitor | No-op | Extension detects and does nothing — zero overhead |
| Side-by-side different heights | Not yet handled | Left/right dead zones planned |

### Monitor Types

| Type | Status | Notes |
|------|--------|-------|
| Standard landscape (1080p, 1440p, 4K) | Fully supported | |
| Portrait / rotated (e.g. 1440x2560) | Supported | Row grouping and index tracking tested |
| Mixed landscape + portrait in same row | Supported | Row span uses tallest monitor's height |
| HiDPI / fractional scaling | Works in logical pixels | Mapping is correct in GNOME's coordinate space; visual proportions may differ from physical proportions at mixed scale factors |
| Ultrawide (3440x1440, 5120x1440) | Supported | Treated as a wide monitor in its row |

### Coordinate Spaces

| Scenario | Status | Notes |
|----------|--------|-------|
| Negative X coordinates (monitor left of primary) | Supported | Tested with x=-1920 |
| Negative Y coordinates (monitor above primary) | Supported | Tested with y=-1080 |
| Non-contiguous rows (gaps between monitors) | Gap-safe | `_snapToMonitors` prevents cursor stranding in gaps |
| Primary monitor not at (0,0) | Supported | All math is relative, not origin-dependent |

### Edge Cases Defended Against

| Edge Case | Defense |
|-----------|---------|
| Warp destination lands in gap between monitors | `_snapToMonitors` snaps to nearest monitor pixel |
| Dead zone warpY overshoots into void | Snap corrects both X and Y before warp |
| Source position in gap during crossing | `_isOnMonitor` verifies source is on a real monitor before remapping |
| Zero-width row (pathological monitor) | `_rowSpanAt` returns null, skips all warp logic |
| Empty monitor filter (race condition) | Guard returns null before `Math.min/max` on empty arrays |
| Division by zero in ratio calculation | Width <= 0 check bails before division |
| Monitor hot-plug during operation | `monitors-changed` signal resets all motion state + cooldown |
| Rapid back-and-forth crossing | Warp cooldown (default 100ms) prevents double-warps |

## How It Works

1. On `enable()`, the extension starts a GLib polling loop (~120Hz) that reads `global.get_pointer()` for the cursor position across all monitors. (On Wayland, `captured-event` only delivers motion events on the primary monitor — polling bypasses this limitation.)

2. On each poll, geometry is computed live from `Main.layoutManager.monitors` — no pre-built cache:
   - `_rowSpanAt(y)` determines which monitor row the cursor is in, its full horizontal span, and the actual monitor objects in that row.
   - `_findDeadZone(x, y)` checks if the cursor is near an edge with no direct neighbor above/below.
   - `_isOnMonitor(x, y)` verifies the cursor is on a real monitor, not in a gap between monitors.

3. If the cursor crossed between rows (source row differs from target row), the x-coordinate is remapped proportionally using the source position (`_lastX`) for accurate mapping. The destination is snapped to an actual monitor to prevent landing in gaps.

4. If the cursor is stuck in a dead zone, a time-based pressure timer triggers a proportional warp after a configurable threshold. The warp destination is snapped to a real monitor.

5. On monitor hot-plug (`monitors-changed`), all motion state resets — the next event reads the new layout automatically.

6. With a single monitor, the extension does nothing — no polling overhead, no overlays, no calculations.

## Configuration

Open preferences via `gnome-extensions prefs dj-mouse-warp@djmsqrvve`.

### Warp Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `is-enabled` | true | Master toggle for all functionality |
| `overlap-remap-enabled` | true | Proportionally remap x on boundary crossing (overlap zones) |
| `warp-enabled` | true | Enable dead-zone pressure warping |
| `edge-tolerance` | 2px | Distance from edge that triggers dead-zone detection. Increase for high-DPI or if warps feel too sensitive. |
| `pressure-threshold-ms` | 150ms | Time cursor must push against edge before warping. Increase if you get accidental warps; decrease for faster response. |
| `warp-cooldown-ms` | 100ms | Cooldown after a warp before another can trigger. Prevents double-warps from fast crossings. |

### Visual Feedback

| Setting | Default | Description |
|---------|---------|-------------|
| `visual-feedback-enabled` | true | Blue glow circle at warp destination |
| `overlay-enabled` | false | Per-monitor colored cursor circle (changes color when crossing monitors) |
| `click-flash-enabled` | false | Flash a dot at the true click position |
| `monitor-config` | JSON | Per-monitor overlay color and size (schema-only setting) |

### Shell

| Setting | Default | Description |
|---------|---------|-------------|
| `hide-top-bar` | false | Hide the GNOME top bar (panel). Reclaims space and eliminates top-edge hitbox interference. |

### Debug

| Setting | Default | Description |
|---------|---------|-------------|
| `debug-logging` | false | Log warp events to GNOME Shell journal (`journalctl -f /usr/bin/gnome-shell`) |
| `poll-rate-ms` | 8ms | Cursor polling interval. Lower = more responsive but higher CPU. Default is ~120Hz. |
| `row-tolerance` | 5px | Y-offset threshold for grouping monitors into the same row. Increase if monitors have slight vertical misalignment in display settings. |

### Tuning Guide

**Warps feel too sensitive?** Increase `pressure-threshold-ms` (try 250-400ms) and `edge-tolerance` (try 5-10px).

**Warps feel sluggish?** Decrease `pressure-threshold-ms` (try 50-100ms). Decrease `poll-rate-ms` for faster detection (try 4ms).

**Getting double-warps?** Increase `warp-cooldown-ms` (try 150-200ms).

**Monitors not grouping into rows?** Increase `row-tolerance` if your monitors have slight vertical offset (check display settings alignment).

**Extension active but shouldn't be?** With a single monitor, the extension automatically idles — no need to disable it manually.

## Visualizer

An interactive HTML tool shows the monitor layout, dead zones, warp mapping lines, and proportional formula.

```bash
xdg-open dj-mouse-warp/visualizer.html
```

## Testing

537 assertions across 3 test files covering core logic, schema validation, and structural integrity.

```bash
# Local (Node.js required)
make test
# or
bash tests/run_tests.sh

# Docker (includes GSettings schema compilation)
docker compose run tests
```

CI runs automatically on push/PR via GitHub Actions.

### What's Tested

- **Geometry**: Row span computation for single, dual, triple, four, and five-monitor layouts. Portrait monitors. Negative coordinates. Y-misalignment tolerance.
- **Warp math**: Proportional ratio, clamping, identity mapping, narrow-to-wide precision, same-width/offset rows.
- **Dead zones**: Top edge, bottom edge, gaps in target row, warpY coordinate precision, large edge tolerance overshoot.
- **Gap safety**: Non-contiguous rows, wide gaps, snap to nearest monitor, source-in-gap prevention, 1px monitor edge case.
- **Pressure timing**: Threshold precision (> not >=), reset on cursor leave, cooldown interaction, rapid crossing prevention.
- **Negative coordinates**: Monitors above primary, monitors left of primary, snap with negative monitors.
- **Click flash**: Creation, positioning, animation, cleanup, multi-flash accumulation, single-monitor bypass.
- **Overlay/debug label**: Create, update, per-monitor color switching, position tracking, destroy on settings toggle, cleanup on disable.
- **Settings**: All 14 GSettings keys (type, default, summary, description). Dynamic reload. Toggle interactions.
- **Lifecycle**: Enable/disable cleanup, monitors-changed reset, cooldown cleared on state reset, monitorConfig freed on disable.
- **Structure**: File presence, Makefile consistency, prefs.js imports and bindings, extension.js method signatures and guards.

## Known Limitations

- **Left/right dead zones**: Only handles top/bottom (horizontal) boundaries. Side-by-side monitors with different heights will not get dead-zone detection at the height mismatch. This is planned for a future release.
- **Wayland session restart**: Required after install or update. Use `make install` then log out and back in.
- **Fractional scaling**: Proportional mapping is correct in GNOME's logical coordinate space. With mixed scale factors (e.g. one monitor at 100%, another at 200%), the visual cursor travel distance may not feel proportional to the physical monitor size, because logical pixels map differently to physical pixels at each scale factor.
- **Polling overhead**: The extension polls at ~120Hz via `GLib.timeout_add`. This is negligible on modern hardware but can be reduced via `poll-rate-ms` if needed.
- **NVIDIA cursor hotspot**: Some NVIDIA + Wayland combinations show a cursor hotspot offset. Fix: add `MUTTER_DEBUG_FORCE_KMS_MODE=simple` to `~/.config/environment.d/60-nvidia-cursor.conf`.

## Compatibility

- GNOME Shell 47 - 50
- Wayland and X11 (uses `ClutterSeat.warp_pointer`)
- Any number of monitors in any row arrangement
- NVIDIA and Mesa drivers

## License

MIT
