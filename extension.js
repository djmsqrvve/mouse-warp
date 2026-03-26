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
 * All geometry is computed live from Main.layoutManager.monitors on every
 * motion event — no pre-built boundary cache. This handles hot-plugged
 * monitors, resolution changes, and layout edits without requiring a restart.
 *
 * The math: ratio = (sourceX - sourceLeft) / sourceWidth
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
        this._feedbackWidgets = [];

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

        // Reset motion state on layout changes to prevent stale crossings
        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed',
            () => {
                this._resetMotionState();
                log('[mouse-warp] monitors changed — motion state reset');
            }
        );

        log(`[mouse-warp] enabled — ${Main.layoutManager.monitors.length} monitor(s)`);
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
        log('[mouse-warp] disabled');
    }

    // ── Live geometry helpers ─────────────────────────────────────

    /**
     * Compute the horizontal span of the monitor row containing the given Y.
     * Groups monitors within ROW_TOLERANCE of each other into the same row.
     * Returns null if Y is not inside any monitor.
     */
    _rowSpanAt(y, monitors) {
        let seedY = null;
        for (const m of monitors) {
            if (y >= m.y && y < m.y + m.height) {
                seedY = m.y;
                break;
            }
        }
        if (seedY === null) return null;

        const row = monitors.filter(m => Math.abs(m.y - seedY) <= ROW_TOLERANCE);
        const left = Math.min(...row.map(m => m.x));
        const right = Math.max(...row.map(m => m.x + m.width));
        const top = Math.min(...row.map(m => m.y));
        const bottom = Math.max(...row.map(m => m.y + m.height));
        return {left, right, width: right - left, top, bottom};
    }

    /**
     * Check if the cursor is in a dead zone — near the edge of its monitor
     * with no direct neighbor above/below at this X, but an adjacent row
     * exists at some other X range.
     *
     * Returns {sourceRow, targetRow, warpY} or null.
     */
    _findDeadZone(x, y, monitors) {
        const curMon = monitors.find(m =>
            x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
        if (!curMon) return null;

        const nearTop = (y - curMon.y) <= this._edgeTolerance;
        const nearBottom = (curMon.y + curMon.height - 1 - y) <= this._edgeTolerance;

        if (nearTop) {
            const hasAbove = monitors.some(m =>
                Math.abs((m.y + m.height) - curMon.y) <= ROW_TOLERANCE &&
                x >= m.x && x < m.x + m.width);
            if (!hasAbove) {
                const adj = monitors.filter(m =>
                    Math.abs((m.y + m.height) - curMon.y) <= ROW_TOLERANCE);
                if (adj.length > 0) {
                    const sourceRow = this._rowSpanAt(y, monitors);
                    const tLeft = Math.min(...adj.map(m => m.x));
                    const tRight = Math.max(...adj.map(m => m.x + m.width));
                    return {
                        sourceRow,
                        targetRow: {left: tLeft, right: tRight, width: tRight - tLeft},
                        warpY: curMon.y - this._edgeTolerance - 1,
                    };
                }
            }
        }

        if (nearBottom) {
            const bottomEdge = curMon.y + curMon.height;
            const hasBelow = monitors.some(m =>
                Math.abs(m.y - bottomEdge) <= ROW_TOLERANCE &&
                x >= m.x && x < m.x + m.width);
            if (!hasBelow) {
                const adj = monitors.filter(m =>
                    Math.abs(m.y - bottomEdge) <= ROW_TOLERANCE);
                if (adj.length > 0) {
                    const sourceRow = this._rowSpanAt(y, monitors);
                    const tLeft = Math.min(...adj.map(m => m.x));
                    const tRight = Math.max(...adj.map(m => m.x + m.width));
                    return {
                        sourceRow,
                        targetRow: {left: tLeft, right: tRight, width: tRight - tLeft},
                        warpY: bottomEdge + this._edgeTolerance + 1,
                    };
                }
            }
        }

        return null;
    }

    // ── Helpers ──────────────────────────────────────────────────────

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
            this._lastX = sx;
            this._lastY = sy;
            return;
        }

        const [x, y] = global.get_pointer();
        const monitors = Main.layoutManager.monitors;

        if (!monitors || monitors.length < 2) {
            this._lastX = x;
            this._lastY = y;
            return;
        }

        // ── Boundary crossing: detect row change via live geometry ──
        if (this._lastY >= 0) {
            const srcRow = this._rowSpanAt(this._lastY, monitors);
            const tgtRow = this._rowSpanAt(y, monitors);

            if (srcRow && tgtRow && srcRow.top !== tgtRow.top) {
                // Different rows — remap if spans differ
                if (Math.abs(srcRow.width - tgtRow.width) >= 2 ||
                    Math.abs(srcRow.left - tgtRow.left) >= 2) {
                    // Use _lastX (source position before GNOME moved the cursor)
                    const sourceX = this._lastX;
                    if (sourceX >= srcRow.left && sourceX < srcRow.right) {
                        const ratio = Math.max(0, Math.min(1,
                            (sourceX - srcRow.left) / srcRow.width));
                        const newX = Math.round(
                            tgtRow.left + ratio * (tgtRow.width - 1));
                        log(`[mouse-warp] CROSS ${tgtRow.top > srcRow.top ? 'DOWN' : 'UP'}: ` +
                            `src=[${srcRow.left},${srcRow.right}] tgt=[${tgtRow.left},${tgtRow.right}] ` +
                            `x=${sourceX}->${newX}`);
                        if (Math.abs(newX - x) > 1)
                            this._warp(newX, y);
                        const [px, py] = global.get_pointer();
                        this._lastX = px;
                        this._lastY = py;
                        this._pressureStartTime = 0;
                        return;
                    }
                }
            }
        }

        // ── Dead zone: cursor stuck at edge with no direct neighbor ──
        const deadZone = this._findDeadZone(x, y, monitors);
        if (deadZone) {
            if (this._pressureStartTime === 0) {
                this._pressureStartTime = GLib.get_monotonic_time();
            } else {
                const elapsedMs =
                    (GLib.get_monotonic_time() - this._pressureStartTime) / 1000;
                if (elapsedMs > this._pressureThresholdMs) {
                    const {sourceRow, targetRow, warpY} = deadZone;
                    const ratio = Math.max(0, Math.min(1,
                        (x - sourceRow.left) / sourceRow.width));
                    const newX = Math.round(
                        targetRow.left + ratio * (targetRow.width - 1));
                    this._warp(newX, warpY);
                    this._pressureStartTime = 0;
                }
            }
            this._lastX = x;
            this._lastY = y;
            return;
        }

        this._pressureStartTime = 0;
        this._lastX = x;
        this._lastY = y;
    }
}
