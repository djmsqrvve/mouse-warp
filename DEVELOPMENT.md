# Development Notes

## Architecture

GNOME Shell extension with the following files:
- `extension.js` — core logic, system tray toggle, visual feedback
- `prefs.js` — GTK4/Adwaita preferences window
- `schemas/` — GSettings XML schema for user configuration

### Core flow

1. `enable()` → loads GSettings, creates system tray indicator, reads monitor layout, connects to stage motion events
2. `_buildBoundaries()` → groups monitors into horizontal rows by Y, finds adjacent rows with mismatched widths, registers proportional mapping boundaries
3. `_onMotion()` → on every pointer motion (if `is-enabled` is true):
   - **Overlap crossing**: if cursor changed monitors across a registered boundary, remap x proportionally
   - **Dead-zone pressure**: if cursor is stuck at a boundary edge (no monitor above/below), start a timer and warp after the configurable time threshold
4. `_showVisualFeedback()` → draws a glowing circle at the warp destination that fades out over 300ms

### Key APIs

- `Main.layoutManager.monitors` — array of `{x, y, width, height}` for each monitor
- `Clutter.get_default_backend().get_default_seat().warp_pointer(x, y)` — moves cursor (works on Wayland inside shell extensions)
- `global.stage.connect('captured-event', ...)` — intercept all input events
- `Main.layoutManager.connect('monitors-changed', ...)` — hot-plug detection

### Anti-recursion

`warp_pointer()` generates a synthetic motion event. The `_skipWarpEvent` flag prevents the handler from re-triggering on its own warp.

## Testing

Tested on: GNOME Shell 50.beta, Wayland, Nvidia (RTX 2080 Ti).

Monitor layout used during development:
- DP-1 (main): 2560x1440 @ +2560+1080
- DP-3 (second): 2560x1440 @ +0+1080
- HDMI-1 (TV): 1920x1080 @ +1600+0

### Automated tests (154 assertions)

Run locally with Node.js:
```bash
bash tests/run_tests.sh
```

Or via Docker (also validates schema compilation with glib):
```bash
docker compose run tests
```

Tests cover: schema validation, boundary building, proportional warp math, time-based pressure,
enable/disable lifecycle, tray toggle, visual feedback, settings sync, and file structure.

CI runs automatically on push/PR via GitHub Actions (`.github/workflows/test.yml`).

### Quick manual test cycle

```bash
make install
# Log out / log in (Wayland requires session restart)
gnome-extensions enable mouse-warp@djmsqrvve
```

Check `journalctl -f -o cat /usr/bin/gnome-shell` for extension errors.

To view extension logs with more detail:
```bash
journalctl -f --grep="mouse-warp" _COMM=gnome-shell
```

### Debug tips

- Add `console.log(...)` calls in extension.js — they appear in the GNOME Shell journal
- Use Looking Glass (`Alt+F2` → `lg`) to inspect `Main.layoutManager.monitors`
- `gnome-extensions info mouse-warp@djmsqrvve` shows enabled/error state

## Known limitations / TODO

- [ ] Only handles horizontal boundaries (top/bottom). Left/right side-by-side monitors with height mismatches are not handled yet.
- [ ] Overlap-zone remapping may feel surprising if the smaller monitor is physically centered — the proportional remap shifts x away from 1:1. Could add a config option to disable overlap remapping and only fix dead zones.
- [x] ~~Pressure threshold (5 events) is hardcoded.~~ Now configurable via GSettings (`pressure-threshold-ms`) and uses time-based measurement.
- [x] ~~No preferences UI yet.~~ Preferences window with GTK4/Adwaita + system tray toggle added.
- [ ] Not tested with fractional scaling — `monitors` coordinates may be logical, which should be fine, but needs verification.
- [ ] Not tested with more than 3 monitors or non-rectangular layouts.
- [ ] Consider publishing to extensions.gnome.org once stable (`make package` creates the zip).

## References

- [LittleBigMouse](https://github.com/mgth/LittleBigMouse) — Windows equivalent, inspiration for this project
- [GNOME Discourse: pointer warping on Wayland](https://discourse.gnome.org/t/pointer-warping-on-wayland/9197)
- [GNOME Discourse: ClutterSeat.warp_pointer in extensions](https://discourse.gnome.org/t/set-location-of-cursor-in-extension-to-a-fixed-place-for-visually-impaired-people/16860)
- [Mutter Issue #2053: weird behaviour near monitor edge](https://gitlab.gnome.org/GNOME/mutter/-/issues/2053)
- [Cursr](https://github.com/bitgapp/Cursr) — cross-platform alternative (no Wayland support yet)
