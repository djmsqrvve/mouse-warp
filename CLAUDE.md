# DJ Mouse Warp

GNOME Shell extension for proportional cursor mapping between monitors of different sizes. The Linux answer to LittleBigMouse.

## Git Topology

Standalone repo. Remote: `origin https://github.com/djmsqrvve/dj-mouse-warp`

## Stack

JavaScript (GJS/GNOME Shell Extension API), GSettings, Clutter, St.

## Key Commands

```bash
make install                                  # Compile schemas + copy to extensions dir
make test                                     # Run 537 assertions (Node.js)
make package                                  # Create .zip for distribution
gnome-extensions enable dj-mouse-warp@djmsqrvve  # Enable (requires re-login on Wayland)
bash tests/run_tests.sh                       # Same as make test
docker compose run tests                      # Run tests in container

# Via dj CLI
dj mouse warp on          # Enable extension
dj mouse warp off         # Disable extension
dj mouse warp status      # Show extension state
dj mouse warp visualize   # Open visualizer with live settings injected
dj mouse warp reload      # make install + logout (fast debug cycle)
dj mouse status           # Full mouse config + warp state
dj session logout         # Log out GNOME session
```

## How It Works

Two strategies for cursor crossing between monitor rows of different widths:

1. **Overlap-zone remapping** — when cursor naturally crosses between rows, x-coordinate is remapped proportionally
2. **Dead-zone warping** — when cursor hits an edge with no monitor above/below, detects pressure (time at edge) then warps proportionally

Formula: `ratio = (x - srcLeft) / srcWidth` -> `newX = tgtLeft + ratio * tgtWidth`

## Architecture

```
extension.js       # Core: 609 lines — warp, snap, overlay, click flash, debug label, live geometry
prefs.js           # GTK4/Adwaita preferences (Warp Settings + Visual Feedback + Debug)
metadata.json      # Extension UUID + GNOME Shell version compat (47-50)
schemas/           # GSettings schema (14 keys)
visualizer.html    # Dual-tab visualizer: Physical Layout + OS Interpretation
tests/             # 537 assertions across 3 test files (Node.js), 80 test groups
  test_schema.js           # 64 assertions — GSettings XML validation
  test_extension_logic.js  # 397 assertions — core logic, 80 test groups
  test_metadata.js         # 76 assertions — file structure, method signatures, guards
Dockerfile         # Node 20 + libglib2.0-dev for containerized testing
docker-compose.yml # docker compose run tests
.github/workflows/ # CI on push/PR
Makefile           # install, uninstall, package, test, compile-schemas
```

## Core Methods (extension.js)

| Method | Purpose |
|--------|---------|
| `_rowSpanAt(y, monitors)` | Returns row span + monitor list for the row containing Y |
| `_isOnMonitor(x, y, candidates)` | True if (x,y) is on an actual monitor (not in a gap) |
| `_snapToMonitors(x, y, candidates)` | Snaps point to nearest monitor pixel — prevents gap stranding |
| `_findDeadZone(x, y, monitors)` | Detects if cursor is at an edge with no neighbor, returns warp target |
| `_onPoll()` | Main 120Hz loop — crossing detection, dead zone pressure, overlay |
| `_warp(x, y)` | Executes Clutter warp + cooldown + visual feedback |
| `_onButtonPress()` | Click flash handler (single-monitor bypass) |
| `_resetMotionState()` | Clears pressure, position, cooldown — called on disable/monitors-changed |

## Defensive Guards

| Guard | Location | Prevents |
|-------|----------|----------|
| `monitors.length < 2` | `_onPoll`, `_onButtonPress` | All processing on single monitor |
| `_isOnMonitor(sourceX, ...)` | Crossing logic | Remap when source is in a gap between monitors |
| `_snapToMonitors(newX, y, ...)` | Both warp sites | Landing in gaps between non-contiguous monitors |
| `row.length === 0` / `width <= 0` | `_rowSpanAt` | Empty filter result, zero-width division |
| `sourceRow.width <= 0` | Dead zone warp | Division by zero in ratio calculation |
| `_warpCooldownUntil` reset | `_resetMotionState` | Stale cooldown after monitors-changed |
| `_monitorConfig = null` | `disable()` | Holding parsed JSON in memory after disable |

## Configuration

Settings via `gnome-extensions prefs dj-mouse-warp@djmsqrvve` or GSettings:

Warp: `is-enabled`, `overlap-remap-enabled`, `warp-enabled`, `edge-tolerance` (2px), `pressure-threshold-ms` (150), `warp-cooldown-ms` (100)

Visual: `visual-feedback-enabled` (true), `overlay-enabled` (false), `click-flash-enabled` (false), `monitor-config` (JSON)

Shell: `hide-top-bar` (false)

Debug: `debug-logging` (false), `poll-rate-ms` (8), `row-tolerance` (5px)

## Monitor Layout (DJ's setup)

```
HDMI-1 (TV):  1920x1080 @ variable       <- position depends on display layout
DP-3 (Left):  2560x1440 @ (0, 1080)
DP-1 (Right): 2560x1440 @ (2560, 1080)   <- PRIMARY, 170Hz
```

TV position varies by layout (flush-left, centered, etc). Extension uses live geometry from `Main.layoutManager.monitors` — handles any position automatically.

## Tested Configurations

- 2-row (TV + dual desk) — primary use case, all variants
- 3-row stacked (top/middle/bottom) — including multi-row skip
- 4-monitor L-shape (2+2 different widths)
- 5-monitor array (3 upper + 2 lower)
- Portrait monitors (1440x2560 rotated)
- Mixed portrait + landscape in same row
- Negative coordinates (monitors above/left of primary)
- Non-contiguous rows (monitors with gaps)
- Same-width rows (no-op, offset remap)
- Single monitor (complete bypass)
- Zero-width pathological monitors

## Known Limitations

- Only handles top/bottom (horizontal) boundaries, not left/right height mismatches
- Requires Wayland session restart after install/update (`dj mouse warp reload`)
- Fractional scaling: correct in logical pixels, but visual proportions may differ at mixed scale factors
- NVIDIA cursor hotspot fix: `MUTTER_DEBUG_FORCE_KMS_MODE=simple` in `~/.config/environment.d/60-nvidia-cursor.conf`
