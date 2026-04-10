# Mouse Warp — Codex Agent Briefing

You are picking up development on Mouse Warp, a GNOME Shell extension that proportionally maps cursor movement between monitors of different sizes. This briefing tells you everything you need to hit the ground running.

## What This Project Is

Mouse Warp solves a real UX problem on Linux multi-monitor setups: when monitors in adjacent rows have different total widths (e.g. a 1920px TV above two 2560px desk monitors = 5120px), GNOME creates dead zones where the cursor can't cross. This extension intercepts cursor movement and proportionally remaps the X coordinate so the full width of one row maps onto the full width of the other.

It ships as a standard GNOME Shell extension (JavaScript/GJS) with a GSettings schema, GTK4 preferences UI, and a 537-assertion test suite.

## Where Things Stand

The extension is **production-ready for top/bottom monitor boundaries**. A major hardening pass was just completed (April 2, 2026) that added:

- **Single-monitor bypass** — zero overhead when only one display is connected. `_onPoll` and `_onButtonPress` bail before even calling `get_pointer()`.
- **Gap-safe warping** — `_snapToMonitors()` prevents cursor stranding in gaps between non-contiguous monitors. Applied to both overlap-remap crossings and dead-zone warps.
- **Source validation** — `_isOnMonitor()` prevents incorrect remapping when the source cursor position is in a gap within the source row's bounding box.
- **Defensive guards** — zero-width division, empty array protection, cooldown cleared on state reset, memory freed on disable.
- **537 assertions across 80 test groups** covering 12+ monitor layouts including negative coordinates, portrait monitors, 5-monitor arrays, and pathological edge cases.

Read `CLAUDE.md` for the full architecture, method table, and guard inventory.

## What's NOT Done Yet

### 1. Left/Right Dead Zones (Highest Priority)

The extension only handles **top/bottom** (horizontal) boundaries — monitors stacked vertically with different widths. It does NOT handle **left/right** (vertical) boundaries — monitors side by side with different heights.

Example that's broken:
```
┌──────────────┐┌──────────┐
│  2560×1440   ││ 1920×1080│  ← right monitor is shorter
│              ││          │
│              │└──────────┘
│              │ ↑ dead zone (bottom 360px of left monitor, right side)
└──────────────┘
```

The architecture for this would mirror the existing row-based system but with columns:
- `_colSpanAt(x, monitors)` — group monitors into columns by X position
- `_findDeadZoneHorizontal(x, y, monitors)` — detect left/right edge dead zones
- Same proportional formula on Y axis: `ratio = (y - srcTop) / srcHeight` → `newY = tgtTop + ratio * tgtHeight`
- Same `_snapToMonitors` for gap safety

### 2. Fractional Scaling Awareness

The extension works in GNOME's logical pixel space, which is correct for coordinate math. But with mixed scale factors (e.g. one monitor at 100%, another at 200%), the proportional mapping produces correct logical coordinates that feel visually wrong — moving halfway across a 4K@200% monitor doesn't cover the same visual distance as halfway across a 1080p@100% monitor.

A potential fix: read per-monitor scale factors from Mutter and weight the proportional ratio by physical pixel density rather than logical width. This is a UX improvement, not a correctness fix.

### 3. Preferences UI Gaps

`prefs.js` exposes sliders and toggles for the main settings but doesn't cover:
- `monitor-config` (per-monitor overlay colors) — currently schema-only, needs a JSON editor or per-monitor color pickers
- `row-tolerance` — no UI, only GSettings
- No visual preview of the current monitor layout in the preferences window

### 4. Extensions.gnome.org Distribution

The extension is installable via `make install` but hasn't been submitted to the GNOME Extensions website. The `make package` target creates the zip. Submission requires:
- Review of EGO metadata requirements
- Possibly bumping GNOME Shell version compatibility
- Screenshot assets

## Key Files to Read First

1. **`CLAUDE.md`** — architecture, core methods, defensive guards, tested configurations, known limitations
2. **`extension.js`** — 609 lines, the entire extension. Start with `_onPoll()` (line ~501) which is the main loop.
3. **`tests/test_extension_logic.js`** — 397 assertions, 80 test groups. The `TestableMouseWarp` class (line ~158) is a mock-friendly copy of the extension logic — keep it in sync with `extension.js`.
4. **`README.md`** — user-facing docs with supported configurations matrix and tuning guide.

## How to Work

### Running Tests

```bash
cd ~/dev/mouse-warp
make test                    # 537 assertions, ~2 seconds
docker compose run tests     # containerized, includes schema compilation
```

Tests are Node.js scripts with a custom assertion framework (no dependencies). The `TestableMouseWarp` class in `test_extension_logic.js` mirrors the real extension using mocks for GNOME APIs (Clutter, GLib, St, Main). **When you change extension.js, you must update TestableMouseWarp to match.**

### Making Changes

1. Edit `extension.js`
2. Mirror the change in `TestableMouseWarp` in `tests/test_extension_logic.js`
3. Add tests for the new behavior
4. If you added a new method or guard, add a structural check in `tests/test_metadata.js`
5. Run `make test`
6. If you changed settings, update `prefs.js` and the GSettings schema

### Installing and Testing Live

```bash
make install                                    # copies to ~/.local/share/gnome-shell/extensions/
gnome-extensions enable mouse-warp@djmsqrvve    # enable
# Log out and back in (Wayland requirement)

# Check logs:
journalctl -f /usr/bin/gnome-shell | grep mouse-warp

# Quick debug cycle:
# 1. Enable debug-logging in prefs
# 2. Edit extension.js
# 3. make install
# 4. Log out / log in
# 5. Check journal
```

## Architecture Patterns

- **No caching of monitor geometry.** Everything is computed live from `Main.layoutManager.monitors` on each poll. Monitor hot-plug is handled by resetting state on the `monitors-changed` signal.
- **Polling, not events.** Wayland only delivers `captured-event` motion on the primary monitor. The extension polls `global.get_pointer()` at ~120Hz via `GLib.timeout_add` to track cursor position across all monitors.
- **Two warp strategies, one formula.** Both overlap-remap (natural crossing) and dead-zone (pressure-based) use the same proportional ratio formula. The difference is the trigger: overlap-remap fires on row change, dead-zone fires after a time threshold at a stuck edge.
- **Snap before warp.** Every computed warp destination passes through `_snapToMonitors()` before being sent to `Clutter.warp_pointer()`. This is the universal safety net for gaps, negative coordinates, and overshoots.
- **Cooldown prevents feedback loops.** After each warp, a configurable cooldown (default 100ms) prevents the warped position from immediately triggering another crossing detection.

## Conventions

- All GSettings keys are loaded in `_loadSettings()` and cached as `this._fieldName`. Settings changes are handled via a `connect('changed', ...)` listener that calls `_loadSettings()` again.
- Error handling: every public-facing method (`_onPoll`, `_onButtonPress`, `_showVisualFeedback`, `_updateOverlay`) wraps logic in try/catch with `log()` — the extension must never crash the GNOME Shell.
- Test naming: tests are numbered sequentially (1-80). New tests go at the end with the next number. Group headers use `console.log('\n── N. Title ──')`.
- The `TestableMouseWarp` class in the test file is a simplified copy of the real extension that uses mock globals instead of real GNOME APIs. It must stay in sync — there is no automatic extraction.
