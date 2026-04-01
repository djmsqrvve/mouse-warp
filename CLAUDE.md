# Mouse Warp

GNOME Shell extension for proportional cursor mapping between monitors of different sizes. The Linux answer to LittleBigMouse.

## Git Topology

Standalone repo. Remote: `origin https://github.com/djmsqrvve/mouse-warp`

## Stack

JavaScript (GJS/GNOME Shell Extension API), GSettings, Clutter, St.

## Key Commands

```bash
make install                                  # Compile schemas + copy to extensions dir
make package                                  # Create .zip for distribution
gnome-extensions enable mouse-warp@djmsqrvve  # Enable (requires re-login on Wayland)
bash tests/run_tests.sh                       # Run 190 assertions (Node.js)
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

Formula: `ratio = (x - srcLeft) / srcWidth` → `newX = tgtLeft + ratio * tgtWidth`

## Architecture

```
extension.js       # Core: warp, overlay, click flash, debug label, live geometry
prefs.js           # GTK4/Adwaita preferences (Warp Settings + Visual Feedback + Debug)
metadata.json      # Extension UUID + GNOME Shell version compat (47-50)
schemas/           # GSettings schema (14 keys: warp, overlap-remap, cooldown, hide-top-bar, poll-rate, row-tolerance, etc)
visualizer.html    # Dual-tab visualizer: Physical Layout + OS Interpretation
tests/             # 190 assertions across 3 test files (Node.js)
```

## Configuration

Settings via `gnome-extensions prefs mouse-warp@djmsqrvve` or GSettings:

Warp Settings:

- `is-enabled` (default: true) — master toggle for all functionality
- `overlap-remap-enabled` (default: true) — proportionally remap x on boundary crossing (overlap zones)
- `warp-enabled` (default: true) — enable dead-zone pressure warping
- `edge-tolerance` (default: 2px) — distance from edge that triggers dead-zone detection
- `pressure-threshold-ms` (default: 150ms) — time cursor must push against edge before warping
- `warp-cooldown-ms` (default: 100ms) — cooldown after a warp before another can trigger

Visual Feedback:

- `visual-feedback-enabled` (default: true) — blue glow circle at warp destination
- `overlay-enabled` (default: false) — per-monitor colored cursor circle
- `click-flash-enabled` (default: false) — flash at true click position

Shell:

- `hide-top-bar` (default: false) — hide the GNOME top bar (panel), reclaims space and fixes top-edge hitbox issues

Debug:

- `debug-logging` (default: false) — log warp events to GNOME Shell journal
- `poll-rate-ms` (default: 8) — cursor polling interval in ms (lower = more responsive)
- `row-tolerance` (default: 5px) — Y-offset threshold for grouping monitors into the same row
- `monitor-config` (JSON) — per-monitor overlay color/size (schema only)

## Monitor Layout

```
HDMI-1 (TV):  1920x1080 @ variable       ← position depends on display layout
DP-3 (Left):  2560x1440 @ (0, 1080)
DP-1 (Right): 2560x1440 @ (2560, 1080)   ← PRIMARY, 170Hz
```

TV position varies by layout (flush-left, centered, etc). The extension uses live geometry from `Main.layoutManager.monitors` so it handles any position automatically.

Layout applied via `dj video layout 3`. Persisted in `~/.config/monitors.xml`.

## Known Issues

- Requires Wayland session restart after install/update (use `dj mouse warp reload`)
- Extension polls cursor via GLib at ~120Hz since Wayland only delivers motion events on primary monitor
- Only handles horizontal (top/bottom) boundaries, not left/right height mismatches
- NVIDIA cursor hotspot fix: `MUTTER_DEBUG_FORCE_KMS_MODE=simple` in `~/.config/environment.d/60-nvidia-cursor.conf`
