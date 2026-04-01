/**
 * Mouse Warp — proportional cursor mapping between monitors of different sizes.
 *
 * When monitors above/below each other have different total widths, GNOME only
 * lets the cursor cross where the monitors physically overlap in logical
 * coordinates. This extension fixes that by:
 *
 *   1. Dead-zone warping — when the cursor is stuck at an edge with no monitor
 *      above/below, it detects "pressure" (time at edge) and warps proportionally.
 *
 *   2. Overlap-zone remapping — when the cursor crosses between rows, the
 *      x-coordinate is remapped proportionally across the full row width.
 *
 * IMPORTANT: On Wayland, global.stage captured-event only delivers motion events
 * for the primary monitor. To track cursor position across ALL monitors, we poll
 * global.get_pointer() via GLib.timeout_add at ~120Hz. This works because
 * get_pointer() returns the real compositor cursor position regardless of which
 * monitor the pointer is on.
 *
 * Debug tools (toggle via prefs):
 *   - Per-monitor colored cursor overlay
 *   - Click flash at true click position
 *   - Coordinate label showing (x, y) and monitor index
 */

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

const DEFAULT_ROW_TOLERANCE = 5;
const DEFAULT_POLL_RATE_MS = 8; // ~120Hz pointer polling

export default class MouseWarpExtension extends Extension {
    enable() {
        this._settings = this.getSettings('org.gnome.shell.extensions.mouse-warp');
        this._loadSettings();

        this._settingsChangedId = this._settings.connect('changed', () => {
            const wasOverlay = this._overlayEnabled;
            const wasHideTopBar = this._hideTopBar;
            const wasPollRate = this._pollRateMs;
            this._loadSettings();
            if (wasOverlay && !this._overlayEnabled) {
                this._destroyOverlay();
                this._destroyDebugLabel();
            }
            if (this._hideTopBar !== wasHideTopBar)
                this._applyTopBar();
            if (this._pollRateMs !== wasPollRate)
                this._restartPolling();
        });

        this._resetMotionState();
        this._feedbackWidgets = [];
        this._overlayWidget = null;
        this._overlayLastMonitor = -1;
        this._debugLabel = null;
        this._warpCooldownUntil = 0;

        // Poll global.get_pointer() for cursor position on ALL monitors.
        // captured-event only delivers MOTION on the primary monitor (Wayland).
        this._startPolling();

        // Keep captured-event for BUTTON_PRESS (click flash) — works on primary
        this._stageEventId = global.stage.connect('captured-event', (_, event) => {
            if (event.type() === Clutter.EventType.BUTTON_PRESS) {
                try {
                    this._onButtonPress();
                } catch (e) {
                    log(`[mouse-warp] click handler error: ${e.message}`);
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed',
            () => {
                this._resetMotionState();
                this._overlayLastMonitor = -1;
                if (this._debugLogging)
                    log('[mouse-warp] monitors changed — state reset');
            }
        );

        this._applyTopBar();

        if (this._debugLogging)
            log(`[mouse-warp] enabled — ${Main.layoutManager.monitors.length} monitor(s), polling at ${this._pollRateMs}ms`);
    }

    _loadSettings() {
        this._edgeTolerance = this._settings.get_int('edge-tolerance');
        this._pressureThresholdMs = this._settings.get_int('pressure-threshold-ms');
        this._warpCooldownMs = this._settings.get_int('warp-cooldown-ms');
        this._isEnabled = this._settings.get_boolean('is-enabled');
        this._warpEnabled = this._settings.get_boolean('warp-enabled');
        this._overlapRemapEnabled = this._settings.get_boolean('overlap-remap-enabled');
        this._overlayEnabled = this._settings.get_boolean('overlay-enabled');
        this._clickFlashEnabled = this._settings.get_boolean('click-flash-enabled');
        this._visualFeedbackEnabled = this._settings.get_boolean('visual-feedback-enabled');
        this._debugLogging = this._settings.get_boolean('debug-logging');
        this._hideTopBar = this._settings.get_boolean('hide-top-bar');
        this._pollRateMs = this._settings.get_int('poll-rate-ms');
        this._rowTolerance = this._settings.get_int('row-tolerance');
        try {
            this._monitorConfig = JSON.parse(this._settings.get_string('monitor-config'));
        } catch (e) {
            log(`[mouse-warp] invalid monitor-config JSON: ${e.message}`);
            this._monitorConfig = {};
        }
        if (!this._isEnabled)
            this._resetMotionState();
    }

    _resetMotionState() {
        this._pressureStartTime = 0;
        this._lastY = -1;
        this._lastX = -1;
    }

    _startPolling() {
        this._pollTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._pollRateMs, () => {
            try {
                this._onPoll();
            } catch (e) {
                log(`[mouse-warp] poll error: ${e.message}`);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _restartPolling() {
        if (this._pollTimerId) {
            GLib.source_remove(this._pollTimerId);
            this._pollTimerId = null;
        }
        this._startPolling();
    }

    disable() {
        this._restoreTopBar();
        this._resetMotionState();

        if (this._pollTimerId) {
            GLib.source_remove(this._pollTimerId);
            this._pollTimerId = null;
        }

        for (const w of this._feedbackWidgets) {
            try { w.destroy(); } catch (_) {}
        }
        this._feedbackWidgets = [];

        this._destroyOverlay();
        this._destroyDebugLabel();

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
        if (this._debugLogging)
            log('[mouse-warp] disabled');
    }

    // ── Live geometry helpers ─────────────────────────────────────

    _rowSpanAt(y, monitors) {
        let seedY = null;
        for (const m of monitors) {
            if (y >= m.y && y < m.y + m.height) {
                seedY = m.y;
                break;
            }
        }
        if (seedY === null) return null;

        const row = monitors.filter(m => Math.abs(m.y - seedY) <= this._rowTolerance);
        const left = Math.min(...row.map(m => m.x));
        const right = Math.max(...row.map(m => m.x + m.width));
        const top = Math.min(...row.map(m => m.y));
        const bottom = Math.max(...row.map(m => m.y + m.height));
        return {left, right, width: right - left, top, bottom};
    }

    _findDeadZone(x, y, monitors) {
        const curMon = monitors.find(m =>
            x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
        if (!curMon) return null;

        const nearTop = (y - curMon.y) <= this._edgeTolerance;
        const nearBottom = (curMon.y + curMon.height - 1 - y) <= this._edgeTolerance;

        if (nearTop) {
            const hasAbove = monitors.some(m =>
                Math.abs((m.y + m.height) - curMon.y) <= this._rowTolerance &&
                x >= m.x && x < m.x + m.width);
            if (!hasAbove) {
                const adj = monitors.filter(m =>
                    Math.abs((m.y + m.height) - curMon.y) <= this._rowTolerance);
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
                Math.abs(m.y - bottomEdge) <= this._rowTolerance &&
                x >= m.x && x < m.x + m.width);
            if (!hasBelow) {
                const adj = monitors.filter(m =>
                    Math.abs(m.y - bottomEdge) <= this._rowTolerance);
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

    // ── Monitor identification ───────────────────────────────────

    _getMonitorIndexAt(x, y) {
        const monitors = Main.layoutManager.monitors;
        for (let i = 0; i < monitors.length; i++) {
            const m = monitors[i];
            if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height)
                return i;
        }
        return -1;
    }

    _getMonitorOverlayConfig(monitorIndex) {
        const key = String(monitorIndex);
        if (this._monitorConfig && this._monitorConfig[key])
            return this._monitorConfig[key];
        return {color: 'rgba(255,255,255,0.5)', size: 20};
    }

    // ── Visual debug tools ───────────────────────────────────────

    _updateOverlay(x, y) {
        try {
            const monIdx = this._getMonitorIndexAt(x, y);
            const cfg = this._getMonitorOverlayConfig(monIdx);
            const size = cfg.size || 20;
            const color = cfg.color || 'rgba(255,255,255,0.5)';

            if (!this._overlayWidget) {
                this._overlayWidget = new St.Widget({
                    reactive: false,
                    can_focus: false,
                    width: size,
                    height: size,
                    style: `border-radius: ${size / 2}px; background-color: ${color};`,
                });
                Main.uiGroup.add_child(this._overlayWidget);
            }

            if (this._overlayLastMonitor !== monIdx) {
                this._overlayLastMonitor = monIdx;
                this._overlayWidget.set_size(size, size);
                this._overlayWidget.style = `border-radius: ${size / 2}px; background-color: ${color};`;
            }

            this._overlayWidget.set_position(x - size / 2, y - size / 2);
        } catch (e) {
            log(`[mouse-warp] overlay error: ${e.message}`);
        }
    }

    _destroyOverlay() {
        if (this._overlayWidget) {
            try { this._overlayWidget.destroy(); } catch (_) {}
            this._overlayWidget = null;
            this._overlayLastMonitor = -1;
        }
    }

    _updateDebugLabel(x, y) {
        try {
            if (!this._debugLabel) {
                this._debugLabel = new St.Label({
                    style: 'font-size: 14px; color: white; background-color: rgba(0,0,0,0.7); padding: 4px 8px; border-radius: 4px;',
                    reactive: false,
                    can_focus: false,
                });
                Main.uiGroup.add_child(this._debugLabel);
            }

            const monIdx = this._getMonitorIndexAt(x, y);
            this._debugLabel.set_text(`(${x}, ${y}) mon:${monIdx}`);

            const primary = Main.layoutManager.primaryMonitor;
            if (primary)
                this._debugLabel.set_position(primary.x + 10, primary.y + 10);
        } catch (e) {
            log(`[mouse-warp] debug label error: ${e.message}`);
        }
    }

    _destroyDebugLabel() {
        if (this._debugLabel) {
            try { this._debugLabel.destroy(); } catch (_) {}
            this._debugLabel = null;
        }
    }

    // ── Top bar control ────────────────────────────────────────────

    _applyTopBar() {
        try {
            if (this._hideTopBar) {
                Main.panel.hide();
                // Also hide the panel's allocation so windows can use the space
                Main.panel.set_height(0);
            } else {
                this._restoreTopBar();
            }
        } catch (e) {
            log(`[mouse-warp] top bar error: ${e.message}`);
        }
    }

    _restoreTopBar() {
        try {
            Main.panel.show();
            // Reset height to default (-1 = natural height)
            Main.panel.set_height(-1);
        } catch (e) {
            log(`[mouse-warp] top bar restore error: ${e.message}`);
        }
    }

    _onButtonPress() {
        if (!this._isEnabled || !this._clickFlashEnabled) return;

        const [x, y] = global.get_pointer();
        const size = 8;
        const widget = new St.Widget({
            style: `border-radius: ${size / 2}px; background-color: rgba(255,255,255,0.9);`,
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
            scale_x: 3.0,
            scale_y: 3.0,
            duration: 300,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                try { widget.destroy(); } catch (_) {}
                const idx = this._feedbackWidgets.indexOf(widget);
                if (idx >= 0) this._feedbackWidgets.splice(idx, 1);
            },
        });
    }

    // ── Helpers ──────────────────────────────────────────────────────

    _warp(x, y) {
        // Set cooldown to prevent false crossings from the warp destination
        this._warpCooldownUntil = GLib.get_monotonic_time() + this._warpCooldownMs * 1000;
        try {
            Clutter.get_default_backend().get_default_seat().warp_pointer(x, y);
            if (this._visualFeedbackEnabled)
                this._showVisualFeedback(x, y);
            // Update tracking to warped position immediately
            this._lastX = x;
            this._lastY = y;
        } catch (e) {
            log(`[mouse-warp] warp error: ${e.message}`);
            this._warpCooldownUntil = 0;
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

    // ── Polled motion handler ─────────────────────────────────────

    _onPoll() {
        if (!this._isEnabled) {
            this._resetMotionState();
            return;
        }

        const [x, y] = global.get_pointer();

        // Skip if cursor hasn't moved AND no active pressure timer
        if (x === this._lastX && y === this._lastY && this._pressureStartTime === 0)
            return;

        // During warp cooldown, just track position
        if (GLib.get_monotonic_time() < this._warpCooldownUntil) {
            this._lastX = x;
            this._lastY = y;
            this._pressureStartTime = 0;
            return;
        }

        const monitors = Main.layoutManager.monitors;

        // Debug overlay + label (runs on ALL monitors now!)
        if (this._overlayEnabled) {
            this._updateOverlay(x, y);
            this._updateDebugLabel(x, y);
        }

        if (!monitors || monitors.length < 2) {
            this._lastX = x;
            this._lastY = y;
            return;
        }

        // ── Warp logic ──
        if (this._warpEnabled) {
            // Boundary crossing: detect row change via live geometry
            if (this._overlapRemapEnabled && this._lastY >= 0) {
                const srcRow = this._rowSpanAt(this._lastY, monitors);
                const tgtRow = this._rowSpanAt(y, monitors);

                if (srcRow && tgtRow && srcRow.top !== tgtRow.top) {
                    if (Math.abs(srcRow.width - tgtRow.width) >= 2 ||
                        Math.abs(srcRow.left - tgtRow.left) >= 2) {
                        const sourceX = this._lastX;
                        if (sourceX >= srcRow.left && sourceX < srcRow.right) {
                            const ratio = Math.max(0, Math.min(1,
                                (sourceX - srcRow.left) / srcRow.width));
                            const newX = Math.round(
                                tgtRow.left + ratio * (tgtRow.width - 1));
                            if (this._debugLogging)
                                log(`[mouse-warp] CROSS ${tgtRow.top > srcRow.top ? 'DOWN' : 'UP'}: ` +
                                    `src=[${srcRow.left},${srcRow.right}] tgt=[${tgtRow.left},${tgtRow.right}] ` +
                                    `x=${sourceX}->${newX}`);
                            if (Math.abs(newX - x) > 1)
                                this._warp(newX, y);
                            else {
                                this._lastX = x;
                                this._lastY = y;
                            }
                            this._pressureStartTime = 0;
                            return;
                        }
                    }
                }
            }

            // Dead zone: cursor stuck at edge with no direct neighbor
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
                        if (this._debugLogging)
                            log(`[mouse-warp] DEAD ZONE WARP: x=${x}->${newX} y=${y}->${warpY}`);
                        this._warp(newX, warpY);
                        this._pressureStartTime = 0;
                    }
                }
                this._lastX = x;
                this._lastY = y;
                return;
            }
        }

        this._pressureStartTime = 0;
        this._lastX = x;
        this._lastY = y;
    }
}
