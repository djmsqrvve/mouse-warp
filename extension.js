/**
 * Mouse Warp — proportional cursor mapping between monitors of different sizes.
 *
 * When monitors above/below each other have different total widths, GNOME only
 * lets the cursor cross where the monitors physically overlap in logical
 * coordinates. This extension fixes that by:
 *
 *   1. Dead-zone warping — when the cursor is stuck at an edge with no monitor
 *      above/below, it detects "pressure" (consecutive motion events at the
 *      boundary) and warps the cursor proportionally to the adjacent row.
 *
 *   2. Overlap-zone remapping — when the cursor naturally crosses between rows,
 *      the x-coordinate is remapped proportionally so the full width of one row
 *      maps to the full width of the other.
 *
 * The math: ratio = (x - sourceLeft) / sourceWidth
 *           newX  = targetLeft + ratio * targetWidth
 */

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

// Tolerance for grouping monitors into the same row by Y coordinate
const ROW_TOLERANCE = 5;

export default class MouseWarpExtension extends Extension {
    enable() {
        this._settings = this.getSettings('org.gnome.shell.extensions.mouse-warp');
        this._loadSettings();

        this._settingsChangedId = this._settings.connect('changed', () => {
            this._loadSettings();
        });

        this._resetMotionState();
        this._boundaries = [];
        this._feedbackWidgets = [];

        this._buildBoundaries();

        this._stageEventId = global.stage.connect('captured-event', (_, event) => {
            if (event.type() === Clutter.EventType.MOTION) {
                try {
                    this._onMotion();
                } catch (e) {
                    // Never crash GNOME Shell — log and continue
                    log(`[mouse-warp] motion handler error: ${e.message}`);
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed',
            () => {
                try {
                    this._buildBoundaries();
                } catch (e) {
                    log(`[mouse-warp] boundary rebuild error: ${e.message}`);
                }
            }
        );

        log(`[mouse-warp] enabled — ${this._boundaries.length} boundary(s) detected`);
    }

    _loadSettings() {
        this._edgeTolerance = this._settings.get_int('edge-tolerance');
        this._pressureThresholdMs = this._settings.get_int('pressure-threshold-ms');
        this._isEnabled = this._settings.get_boolean('is-enabled');
        if (!this._isEnabled)
            this._resetMotionState();
    }

    _resetMotionState() {
        this._skipWarpEvent = false;
        this._pressureStartTime = 0;
        this._lastMonitorIndex = -1;
        this._lastY = -1;
        this._lastX = -1;
    }

    disable() {
        this._resetMotionState();

        // Clean up any remaining feedback widgets
        for (const w of this._feedbackWidgets) {
            try { w.destroy(); } catch (_) {}
        }
        this._feedbackWidgets = [];

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        this._settings = null;

        if (this._stageEventId) {
            global.stage.disconnect(this._stageEventId);
            this._stageEventId = null;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        this._boundaries = [];
        log('[mouse-warp] disabled');
    }

    // ── Layout analysis ──────────────────────────────────────────────

    _buildBoundaries() {
        const monitors = Main.layoutManager.monitors;
        this._boundaries = [];

        if (!monitors || monitors.length < 2)
            return;

        // Group monitors into rows by top-edge Y
        const rows = new Map();
        for (let i = 0; i < monitors.length; i++) {
            const my = monitors[i].y;
            let placed = false;
            for (const [rowY, members] of rows) {
                if (Math.abs(my - rowY) <= ROW_TOLERANCE) {
                    members.push(i);
                    placed = true;
                    break;
                }
            }
            if (!placed)
                rows.set(my, [i]);
        }

        // Sort rows top-to-bottom
        const sorted = [...rows.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, indices]) => indices);

        // Find pairs of adjacent rows that share a horizontal boundary
        for (let r = 0; r < sorted.length - 1; r++) {
            const upperIdx = sorted[r];
            const lowerIdx = sorted[r + 1];

            const upper = upperIdx.map(i => monitors[i]);
            const lower = lowerIdx.map(i => monitors[i]);

            const upperBottom = Math.max(...upper.map(m => m.y + m.height));
            const lowerTop = Math.min(...lower.map(m => m.y));

            if (Math.abs(upperBottom - lowerTop) > ROW_TOLERANCE)
                continue;

            const span = ms => {
                const l = Math.min(...ms.map(m => m.x));
                const r = Math.max(...ms.map(m => m.x + m.width));
                return {left: l, right: r, width: r - l};
            };
            const us = span(upper);
            const ls = span(lower);

            // Only care if spans differ (different widths or offsets)
            if (Math.abs(us.width - ls.width) < 2 && Math.abs(us.left - ls.left) < 2)
                continue;

            this._boundaries.push({
                y: Math.round((upperBottom + lowerTop) / 2),
                upper: {...us, indices: new Set(upperIdx)},
                lower: {...ls, indices: new Set(lowerIdx)},
            });

            log(`[mouse-warp] boundary at y=${upperBottom}: upper=[${us.left},${us.right}] w=${us.width}, lower=[${ls.left},${ls.right}] w=${ls.width}`);
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────

    _monitorIndexAt(x, y) {
        const monitors = Main.layoutManager.monitors;
        for (let i = 0; i < monitors.length; i++) {
            const m = monitors[i];
            if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height)
                return i;
        }
        return -1;
    }

    _warp(x, y) {
        this._skipWarpEvent = true;
        try {
            Clutter.get_default_backend().get_default_seat().warp_pointer(x, y);
            this._showVisualFeedback(x, y);
        } catch (e) {
            log(`[mouse-warp] warp error: ${e.message}`);
            this._skipWarpEvent = false;
        }
    }

    _showVisualFeedback(x, y) {
        try {
            const size = 40;
            const widget = new St.Widget({
                style: `border-radius: ${size/2}px; background-color: rgba(136, 204, 255, 0.4);`,
                x: x - size / 2,
                y: y - size / 2,
                width: size,
                height: size,
                reactive: false,
                can_focus: false,
            });

            Main.uiGroup.add_child(widget);
            this._feedbackWidgets.push(widget);

            widget.ease({
                opacity: 0,
                scale_x: 2.0,
                scale_y: 2.0,
                duration: 250,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    try {
                        widget.destroy();
                    } catch (_) {}
                    const idx = this._feedbackWidgets.indexOf(widget);
                    if (idx >= 0) this._feedbackWidgets.splice(idx, 1);
                }
            });
        } catch (e) {
            log(`[mouse-warp] visual feedback error: ${e.message}`);
        }
    }

    _warpProportional(x, _y, from, to, targetY) {
        const ratio = Math.max(0, Math.min(1, (x - from.left) / from.width));
        const newX = Math.round(to.left + ratio * (to.width - 1));
        if (Math.abs(newX - x) > 1 || targetY !== _y)
            this._warp(newX, targetY);
    }

    // ── Event handler ────────────────────────────────────────────────

    _onMotion() {
        if (!this._isEnabled) {
            this._resetMotionState();
            return;
        }

        // Skip the synthetic motion event generated by our own warp
        if (this._skipWarpEvent) {
            this._skipWarpEvent = false;
            const [sx, sy] = global.get_pointer();
            this._lastMonitorIndex = this._monitorIndexAt(sx, sy);
            this._lastX = sx;
            this._lastY = sy;
            return;
        }

        const [x, y] = global.get_pointer();
        const monIdx = this._monitorIndexAt(x, y);

        // ── Boundary crossing: detect when Y crosses a boundary line ──
        // This catches ALL crossings — even when Mutter silently moves the
        // cursor between overlapping monitors without triggering a monitor
        // index change in a single frame.
        if (this._lastY >= 0) {
            for (const b of this._boundaries) {
                const crossedDown = this._lastY <= b.y && y > b.y;
                const crossedUp = this._lastY >= b.y && y < b.y;

                if (crossedDown) {
                    // Came from upper row → entering lower row
                    // Remap x from upper span to lower span
                    if (x >= b.upper.left && x < b.upper.right) {
                        log(`[mouse-warp] CROSS DOWN at y=${b.y}: x=${x} from=[${b.upper.left},${b.upper.right}] to=[${b.lower.left},${b.lower.right}]`);
                        this._warpProportional(x, y, b.upper, b.lower, y);
                        this._lastMonitorIndex = this._monitorIndexAt(...global.get_pointer());
                        this._lastX = global.get_pointer()[0];
                        this._lastY = global.get_pointer()[1];
                        this._pressureStartTime = 0;
                        return;
                    }
                }

                if (crossedUp) {
                    // Came from lower row → entering upper row
                    // Remap x from lower span to upper span
                    if (x >= b.lower.left && x < b.lower.right) {
                        log(`[mouse-warp] CROSS UP at y=${b.y}: x=${x} from=[${b.lower.left},${b.lower.right}] to=[${b.upper.left},${b.upper.right}]`);
                        this._warpProportional(x, y, b.lower, b.upper, y);
                        this._lastMonitorIndex = this._monitorIndexAt(...global.get_pointer());
                        this._lastX = global.get_pointer()[0];
                        this._lastY = global.get_pointer()[1];
                        this._pressureStartTime = 0;
                        return;
                    }
                }
            }
        }

        // ── Dead zone: cursor stuck at edge ──
        for (const b of this._boundaries) {
            // Trying to go UP from lower row
            if (
                Math.abs(y - b.y) <= this._edgeTolerance &&
                x >= b.lower.left && x < b.lower.right &&
                (x < b.upper.left || x >= b.upper.right)
            ) {
                if (this._pressureStartTime === 0) {
                    this._pressureStartTime = GLib.get_monotonic_time();
                } else {
                    const elapsedMs = (GLib.get_monotonic_time() - this._pressureStartTime) / 1000;
                    if (elapsedMs > this._pressureThresholdMs) {
                        const ratio = Math.max(0, Math.min(1,
                            (x - b.lower.left) / b.lower.width));
                        const newX = Math.round(
                            b.upper.left + ratio * (b.upper.width - 1));
                        this._warp(newX, b.y - this._edgeTolerance - 1);
                        this._pressureStartTime = 0;
                    }
                }
                this._lastMonitorIndex = monIdx;
                return;
            }

            // Trying to go DOWN from upper row
            if (
                Math.abs(y - b.y) <= this._edgeTolerance &&
                x >= b.upper.left && x < b.upper.right &&
                (x < b.lower.left || x >= b.lower.right)
            ) {
                if (this._pressureStartTime === 0) {
                    this._pressureStartTime = GLib.get_monotonic_time();
                } else {
                    const elapsedMs = (GLib.get_monotonic_time() - this._pressureStartTime) / 1000;
                    if (elapsedMs > this._pressureThresholdMs) {
                        const ratio = Math.max(0, Math.min(1,
                            (x - b.upper.left) / b.upper.width));
                        const newX = Math.round(
                            b.lower.left + ratio * (b.lower.width - 1));
                        this._warp(newX, b.y + this._edgeTolerance + 1);
                        this._pressureStartTime = 0;
                    }
                }
                this._lastMonitorIndex = monIdx;
                return;
            }
        }

        this._pressureStartTime = 0;
        this._lastMonitorIndex = monIdx;
        this._lastX = x;
        this._lastY = y;
    }
}
