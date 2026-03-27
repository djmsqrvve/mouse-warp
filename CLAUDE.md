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
prefs.js           # GTK4/Adwaita preferences (General + Debug Tools groups)
metadata.json      # Extension UUID + GNOME Shell version compat (47-50)
schemas/           # GSettings schema (7 keys: warp, overlay, click-flash, monitor-config, etc)
visualizer.html    # Dual-tab visualizer: Physical Layout + OS Interpretation
tests/             # 190 assertions across 3 test files (Node.js)
```

## Configuration

Settings via `gnome-extensions prefs mouse-warp@djmsqrvve` or GSettings:

- `edge-tolerance` (default: 2px) — distance from edge that triggers dead-zone detection
- `pressure-threshold-ms` (default: 150ms) — time cursor must push against edge before warping
- `is-enabled` (default: true) — master toggle
- `warp-enabled` (default: true) — toggle warp independently from debug tools
- `overlay-enabled` (default: false) — per-monitor colored cursor circle
- `click-flash-enabled` (default: false) — flash at true click position
- `monitor-config` (JSON) — per-monitor overlay color/size + physical dimensions

## Monitor Layout

```
HDMI-1 (TV):  1920x1080 @ (0, 0)         ← flush-left for proper mapping
DP-3 (Left):  2560x1440 @ (0, 1080)
DP-1 (Right): 2560x1440 @ (2560, 1080)   ← PRIMARY, 170Hz
```

Layout applied via `dj video layout 3`. Persisted in `~/.config/monitors.xml`.

## Known Issues

- Requires Wayland session restart after install/update (use `dj mouse warp reload`)
- Extension only receives motion events on primary monitor (DP-1) — Mutter/Wayland limitation under investigation
- Only handles horizontal (top/bottom) boundaries, not left/right height mismatches
- NVIDIA cursor hotspot fix: `MUTTER_DEBUG_FORCE_KMS_MODE=simple` in `~/.config/environment.d/60-nvidia-cursor.conf`
