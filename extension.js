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
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import St from 'gi://St';

// Tolerance for grouping monitors into the same row by Y coordinate
const ROW_TOLERANCE = 5;

export default class MouseWarpExtension extends Extension {
    enable() {
        this._settings = this.getSettings('org.gnome.shell.extensions.mouse-warp');
        this._edgeTolerance = this._settings.get_int('edge-tolerance');
        this._pressureThresholdMs = this._settings.get_int('pressure-threshold-ms');
        this._isEnabled = this._settings.get_boolean('is-enabled');

        this._settingsChangedId = this._settings.connect('changed', () => {
            this._edgeTolerance = this._settings.get_int('edge-tolerance');
            this._pressureThresholdMs = this._settings.get_int('pressure-threshold-ms');
            this._isEnabled = this._settings.get_boolean('is-enabled');
            if (!this._isEnabled)
                this._resetMotionState();
            this._updateTrayToggle();
        });

        this._createTrayIcon();

        this._resetMotionState();
        this._boundaries = [];

        this._buildBoundaries();

        this._stageEventId = global.stage.connect('captured-event', (_, event) => {
            if (event.type() === Clutter.EventType.MOTION)
                this._onMotion();
            return Clutter.EVENT_PROPAGATE;
        });

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed',
            () => this._buildBoundaries()
        );
    }

    _createTrayIcon() {
        this._indicator = new PanelMenu.Button(0.0, 'Mouse Warp Indicator', false);
        let icon = new St.Icon({
            icon_name: 'input-mouse-symbolic',
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(icon);

        this._toggleSwitch = new PopupMenu.PopupSwitchMenuItem('Enable Mouse Warp', this._isEnabled);
        this._toggleSwitch.connect('toggled', (item, state) => {
            this._settings.set_boolean('is-enabled', state);
        });

        this._indicator.menu.addMenuItem(this._toggleSwitch);
        Main.panel.addToStatusArea('mouse-warp-indicator', this._indicator);
    }

    _updateTrayToggle() {
        if (this._toggleSwitch) {
            this._toggleSwitch.setToggleState(this._isEnabled);
        }
    }

    _resetMotionState() {
        this._skipWarpEvent = false;
        this._pressureStartTime = 0;
        this._lastMonitorIndex = -1;
    }

    disable() {
        this._resetMotionState();

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
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

            // Only care if spans differ
            if (Math.abs(us.width - ls.width) < 2 && Math.abs(us.left - ls.left) < 2)
                continue;

            this._boundaries.push({
                y: Math.round((upperBottom + lowerTop) / 2),
                upper: {...us, indices: new Set(upperIdx)},
                lower: {...ls, indices: new Set(lowerIdx)},
            });
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
        Clutter.get_default_backend().get_default_seat().warp_pointer(x, y);
        this._showVisualFeedback(x, y);
    }

    _showVisualFeedback(x, y) {
        const size = 60;
        let widget = new St.Widget({
            style: 'border-radius: 30px; background-color: rgba(136, 204, 255, 0.5); box-shadow: 0 0 10px rgba(136, 204, 255, 0.8);',
            x: x - size / 2,
            y: y - size / 2,
            width: size,
            height: size,
        });

        Main.uiGroup.add_child(widget);

        widget.ease({
            opacity: 0,
            scale_x: 1.5,
            scale_y: 1.5,
            duration: 300,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => widget.destroy()
        });
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
            const [x, y] = global.get_pointer();
            this._lastMonitorIndex = this._monitorIndexAt(x, y);
            return;
        }

        const [x, y] = global.get_pointer();
        const monIdx = this._monitorIndexAt(x, y);

        // ── Overlap zone: cursor crossed between rows naturally ──
        if (
            this._lastMonitorIndex >= 0 &&
            monIdx >= 0 &&
            monIdx !== this._lastMonitorIndex
        ) {
            for (const b of this._boundaries) {
                // Crossed lower → upper
                if (
                    b.lower.indices.has(this._lastMonitorIndex) &&
                    b.upper.indices.has(monIdx)
                ) {
                    this._warpProportional(x, y, b.lower, b.upper, y);
                    this._lastMonitorIndex = monIdx;
                    this._pressureStartTime = 0;
                    return;
                }
                // Crossed upper → lower
                if (
                    b.upper.indices.has(this._lastMonitorIndex) &&
                    b.lower.indices.has(monIdx)
                ) {
                    this._warpProportional(x, y, b.upper, b.lower, y);
                    this._lastMonitorIndex = monIdx;
                    this._pressureStartTime = 0;
                    return;
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
    }
}
