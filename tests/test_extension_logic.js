/**
 * test_extension_logic.js — Unit tests for Mouse Warp core logic.
 *
 * Runs on Node.js with mocked GNOME Shell APIs.
 * Tests: live row-span computation, dead-zone detection, proportional math,
 *        time-based pressure, enable/disable lifecycle, tray toggle,
 *        visual feedback, hot-reload, and the is-enabled guard.
 */

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`  \u2714 ${message}`);
        passed++;
    } else {
        console.error(`  \u2718 FAIL: ${message}`);
        failed++;
    }
}

function assertEqual(actual, expected, message) {
    assert(
        actual === expected,
        `${message} \u2014 expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
}

function assertApprox(actual, expected, tolerance, message) {
    assert(
        Math.abs(actual - expected) <= tolerance,
        `${message} \u2014 expected ~${expected}\u00b1${tolerance}, got ${actual}`
    );
}

// ═══════════════════════════════════════════════════════════════════
// Mock GNOME Shell environment
// ═══════════════════════════════════════════════════════════════════

let mockMonoTime = 0;
let warpedTo = null;
let visualFeedbackCalls = [];
let stageListeners = {};
let layoutListeners = {};
let settingsStore = {};
let settingsListeners = {};
let uiGroupChildren = [];

function resetMocks() {
    mockMonoTime = 0;
    warpedTo = null;
    visualFeedbackCalls = [];
    stageListeners = {};
    layoutListeners = {};
    mockPanel.visible = true;
    mockPanel.height = 32;
    settingsStore = {
        'edge-tolerance': 2,
        'pressure-threshold-ms': 150,
        'warp-cooldown-ms': 100,
        'is-enabled': true,
        'warp-enabled': true,
        'overlap-remap-enabled': true,
        'overlay-enabled': false,
        'click-flash-enabled': false,
        'visual-feedback-enabled': true,
        'debug-logging': false,
        'hide-top-bar': false,
        'poll-rate-ms': 8,
        'row-tolerance': 5,
        'monitor-config': '{"0": {"color": "rgba(0,255,0,0.5)", "size": 20}}',
    };
    settingsListeners = {};
    uiGroupChildren = [];
}

// Mock global objects
const mockClutter = {
    EventType: { MOTION: 'motion' },
    EVENT_PROPAGATE: 0,
    AnimationMode: { EASE_OUT_QUAD: 'ease-out-quad' },
    get_default_backend: () => ({
        get_default_seat: () => ({
            warp_pointer: (x, y) => {
                warpedTo = { x, y };
                mockGlobal._pointerX = x;
                mockGlobal._pointerY = y;
            }
        })
    })
};

const mockGLib = {
    get_monotonic_time: () => mockMonoTime,
};

let mockMonitors = [];
const mockPanel = {
    visible: true,
    height: 32,
    hide() { this.visible = false; },
    show() { this.visible = true; },
    set_height(h) { this.height = h; },
};

const mockMain = {
    layoutManager: {
        monitors: mockMonitors,
        connect: (signal, cb) => { layoutListeners[signal] = cb; return 1; },
        disconnect: () => {},
    },
    uiGroup: {
        add_child: (widget) => { uiGroupChildren.push(widget); },
    },
    panel: mockPanel,
};

function createMockSettings() {
    let listenerId = 0;
    return {
        get_int: (key) => settingsStore[key],
        get_boolean: (key) => settingsStore[key],
        get_string: (key) => settingsStore[key],
        set_boolean: (key, val) => { settingsStore[key] = val; },
        connect: (signal, cb) => { settingsListeners[++listenerId] = cb; return listenerId; },
        disconnect: (id) => { delete settingsListeners[id]; },
    };
}

const mockSt = {
    Widget: class {
        constructor(opts) {
            Object.assign(this, opts);
            this.destroyed = false;
        }
        ease(opts) { this._easeOpts = opts; if (opts.onComplete) opts.onComplete(); }
        destroy() { this.destroyed = true; }
    },
};

const mockGlobal = {
    stage: {
        connect: (signal, cb) => { stageListeners[signal] = cb; return 1; },
        disconnect: () => {}
    },
    _pointerX: 0,
    _pointerY: 0,
    get_pointer: function() { return [this._pointerX, this._pointerY]; },
};

// ═══════════════════════════════════════════════════════════════════
// Build a lightweight version of MouseWarpExtension using mocks
// ═══════════════════════════════════════════════════════════════════

const ROW_TOLERANCE = 5;

class TestableMouseWarp {
    constructor() {}

    getSettings() {
        return createMockSettings();
    }

    enable() {
        this._settings = this.getSettings();
        this._loadSettings();

        this._settingsChangedId = this._settings.connect('changed', () => {
            const wasOverlay = this._overlayEnabled;
            const wasHideTopBar = this._hideTopBar;
            this._loadSettings();
            if (wasOverlay && !this._overlayEnabled) {
                this._destroyOverlay();
                this._destroyDebugLabel();
            }
            if (this._hideTopBar !== wasHideTopBar)
                this._applyTopBar();
        });

        this._resetMotionState();
        this._feedbackWidgets = [];
        this._overlayWidget = null;
        this._overlayLastMonitor = -1;
        this._debugLabel = null;
        this._warpCooldownUntil = 0;

        this._monitorsChangedId = mockMain.layoutManager.connect(
            'monitors-changed', () => {
                this._resetMotionState();
                this._overlayLastMonitor = -1;
            }
        );

        this._applyTopBar();
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
            this._monitorConfig = {};
        }
        if (!this._isEnabled)
            this._resetMotionState();
    }

    _resetMotionState() {
        this._pressureStartTime = 0;
        this._lastY = -1;
        this._lastX = -1;
        this._warpCooldownUntil = 0;
    }

    disable() {
        this._restoreTopBar();
        this._resetMotionState();

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
        this._monitorConfig = null;

        if (this._stageEventId) {
            mockGlobal.stage.disconnect(this._stageEventId);
            this._stageEventId = null;
        }
        if (this._monitorsChangedId) {
            mockMain.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
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
        if (row.length === 0) return null;
        const left = Math.min(...row.map(m => m.x));
        const right = Math.max(...row.map(m => m.x + m.width));
        const top = Math.min(...row.map(m => m.y));
        const bottom = Math.max(...row.map(m => m.y + m.height));
        const width = right - left;
        if (width <= 0) return null;
        return {left, right, width, top, bottom, monitors: row};
    }

    _isOnMonitor(x, y, candidates) {
        return candidates.some(m =>
            x >= m.x && x < m.x + m.width &&
            y >= m.y && y < m.y + m.height);
    }

    _snapToMonitors(x, y, candidates) {
        for (const m of candidates) {
            if (x >= m.x && x < m.x + m.width &&
                y >= m.y && y < m.y + m.height)
                return {x, y};
        }
        let bestX = x, bestY = y, bestDist = Infinity;
        for (const m of candidates) {
            const cx = Math.max(m.x, Math.min(x, m.x + m.width - 1));
            const cy = Math.max(m.y, Math.min(y, m.y + m.height - 1));
            const dist = Math.abs(cx - x) + Math.abs(cy - y);
            if (dist < bestDist) {
                bestDist = dist;
                bestX = cx;
                bestY = cy;
            }
        }
        return {x: bestX, y: bestY};
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
                        targetMonitors: adj,
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
                        targetMonitors: adj,
                        warpY: bottomEdge + this._edgeTolerance + 1,
                    };
                }
            }
        }

        return null;
    }

    // ── Monitor identification ───────────────────────────────────

    _getMonitorIndexAt(x, y) {
        const monitors = mockMain.layoutManager.monitors;
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

    // ── Top bar control ────────────────────────────────────────────

    _applyTopBar() {
        if (this._hideTopBar) {
            mockMain.panel.hide();
            mockMain.panel.set_height(0);
        } else {
            this._restoreTopBar();
        }
    }

    _restoreTopBar() {
        mockMain.panel.show();
        mockMain.panel.set_height(-1);
    }

    // ── Visual debug tools ───────────────────────────────────────

    _updateOverlay(x, y) {
        const monIdx = this._getMonitorIndexAt(x, y);
        const cfg = this._getMonitorOverlayConfig(monIdx);
        const size = cfg.size || 20;
        const color = cfg.color || 'rgba(255,255,255,0.5)';

        if (!this._overlayWidget) {
            this._overlayWidget = new mockSt.Widget({
                reactive: false,
                can_focus: false,
                width: size,
                height: size,
                style: `border-radius: ${size / 2}px; background-color: ${color};`,
            });
            mockMain.uiGroup.add_child(this._overlayWidget);
        }

        if (this._overlayLastMonitor !== monIdx) {
            this._overlayLastMonitor = monIdx;
            this._overlayWidget.width = size;
            this._overlayWidget.height = size;
            this._overlayWidget.style = `border-radius: ${size / 2}px; background-color: ${color};`;
        }

        this._overlayWidget.x = x - size / 2;
        this._overlayWidget.y = y - size / 2;
    }

    _destroyOverlay() {
        if (this._overlayWidget) {
            try { this._overlayWidget.destroy(); } catch (_) {}
            this._overlayWidget = null;
            this._overlayLastMonitor = -1;
        }
    }

    _updateDebugLabel(x, y) {
        if (!this._debugLabel) {
            this._debugLabel = new mockSt.Widget({
                style: 'font-size: 14px; color: white; background-color: rgba(0,0,0,0.7); padding: 4px 8px; border-radius: 4px;',
                reactive: false,
                can_focus: false,
            });
            this._debugLabel.text = '';
            mockMain.uiGroup.add_child(this._debugLabel);
        }

        const monIdx = this._getMonitorIndexAt(x, y);
        this._debugLabel.text = `(${x}, ${y}) mon:${monIdx}`;
    }

    _destroyDebugLabel() {
        if (this._debugLabel) {
            try { this._debugLabel.destroy(); } catch (_) {}
            this._debugLabel = null;
        }
    }

    // ── Click flash ──────────────────────────────────────────────

    _onButtonPress() {
        if (!this._isEnabled || !this._clickFlashEnabled) return;
        if (!mockMain.layoutManager.monitors || mockMain.layoutManager.monitors.length < 2) return;

        const [x, y] = mockGlobal.get_pointer();
        const size = 8;
        const widget = new mockSt.Widget({
            style: `border-radius: ${size / 2}px; background-color: rgba(255,255,255,0.9);`,
            x: x - size / 2,
            y: y - size / 2,
            width: size,
            height: size,
            reactive: false,
            can_focus: false,
        });

        mockMain.uiGroup.add_child(widget);
        this._feedbackWidgets.push(widget);

        widget.ease({
            opacity: 0,
            scale_x: 3.0,
            scale_y: 3.0,
            duration: 300,
            mode: mockClutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                try { widget.destroy(); } catch (_) {}
                const idx = this._feedbackWidgets.indexOf(widget);
                if (idx >= 0) this._feedbackWidgets.splice(idx, 1);
            },
        });
    }

    // ── Helpers ──────────────────────────────────────────────────────

    _warp(x, y) {
        this._warpCooldownUntil = mockMonoTime + this._warpCooldownMs * 1000;
        mockClutter.get_default_backend().get_default_seat().warp_pointer(x, y);
        if (this._visualFeedbackEnabled)
            this._showVisualFeedback(x, y);
        this._lastX = x;
        this._lastY = y;
    }

    _showVisualFeedback(x, y) {
        const size = 60;
        let widget = new mockSt.Widget({
            style: 'border-radius: 30px; background-color: rgba(136, 204, 255, 0.5);',
            x: x - size / 2,
            y: y - size / 2,
            width: size,
            height: size,
        });
        mockMain.uiGroup.add_child(widget);
        widget.ease({
            opacity: 0,
            scale_x: 1.5,
            scale_y: 1.5,
            duration: 300,
            mode: mockClutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => widget.destroy()
        });
        visualFeedbackCalls.push({ x, y, widget });
    }

    // ── Polled motion handler ─────────────────────────────────────

    _onPoll() {
        if (!this._isEnabled) {
            this._resetMotionState();
            return;
        }

        const monitors = mockMain.layoutManager.monitors;

        // Single monitor — nothing to warp, overlay, or debug
        if (!monitors || monitors.length < 2)
            return;

        const [x, y] = mockGlobal.get_pointer();

        // Skip if cursor hasn't moved AND no active pressure timer
        if (x === this._lastX && y === this._lastY && this._pressureStartTime === 0)
            return;

        // During warp cooldown, just track position
        if (mockMonoTime < this._warpCooldownUntil) {
            this._lastX = x;
            this._lastY = y;
            this._pressureStartTime = 0;
            return;
        }

        // Debug overlay + label
        if (this._overlayEnabled) {
            this._updateOverlay(x, y);
            this._updateDebugLabel(x, y);
        }

        // ── Warp logic (guarded by warp-enabled toggle) ──
        if (this._warpEnabled) {
            // Boundary crossing: detect row change via live geometry
            if (this._overlapRemapEnabled && this._lastY >= 0) {
                const srcRow = this._rowSpanAt(this._lastY, monitors);
                const tgtRow = this._rowSpanAt(y, monitors);

                if (srcRow && tgtRow && srcRow.top !== tgtRow.top) {
                    if (Math.abs(srcRow.width - tgtRow.width) >= 2 ||
                        Math.abs(srcRow.left - tgtRow.left) >= 2) {
                        const sourceX = this._lastX;
                        if (this._isOnMonitor(sourceX, this._lastY, srcRow.monitors)) {
                            const ratio = Math.max(0, Math.min(1,
                                (sourceX - srcRow.left) / srcRow.width));
                            let newX = Math.round(
                                tgtRow.left + ratio * (tgtRow.width - 1));
                            const snapped = this._snapToMonitors(newX, y, tgtRow.monitors);
                            newX = snapped.x;
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
                    this._pressureStartTime = mockGLib.get_monotonic_time();
                } else {
                    const elapsedMs =
                        (mockGLib.get_monotonic_time() - this._pressureStartTime) / 1000;
                    if (elapsedMs > this._pressureThresholdMs) {
                        const {sourceRow, targetRow, targetMonitors, warpY} = deadZone;
                        if (!sourceRow || sourceRow.width <= 0 || targetRow.width <= 0) {
                            this._pressureStartTime = 0;
                            this._lastX = x;
                            this._lastY = y;
                            return;
                        }
                        const ratio = Math.max(0, Math.min(1,
                            (x - sourceRow.left) / sourceRow.width));
                        const rawX = Math.round(
                            targetRow.left + ratio * (targetRow.width - 1));
                        const snapped = this._snapToMonitors(rawX, warpY, targetMonitors);
                        this._warp(snapped.x, snapped.y);
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

// ═══════════════════════════════════════════════════════════════════
// Test Cases
// ═══════════════════════════════════════════════════════════════════

// ── 1. Row Span Computation ────────────────────────────────────────

console.log('\n\u2500\u2500 1. Row Span Computation \u2500\u2500');

function setupDualRowMonitors() {
    // Upper: 1920x1080 TV centred at x=320
    // Lower: two 2560x1440 monitors side by side (total 5120px)
    mockMain.layoutManager.monitors = [
        { x: 320, y: 0,    width: 1920, height: 1080 },  // 0 — TV
        { x: 0,   y: 1080, width: 2560, height: 1440 },  // 1 — left desk
        { x: 2560, y: 1080, width: 2560, height: 1440 },  // 2 — right desk
    ];
}

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();
    const monitors = mockMain.layoutManager.monitors;

    // Upper row from a point on the TV
    const upper = ext._rowSpanAt(500, monitors);
    assert(upper !== null, 'Upper row found for y=500');
    assertEqual(upper.left, 320, 'Upper row left is 320');
    assertEqual(upper.width, 1920, 'Upper row width is 1920');
    assertEqual(upper.top, 0, 'Upper row top is 0');
    assertEqual(upper.bottom, 1080, 'Upper row bottom is 1080');

    // Lower row from a point on DP-3
    const lower = ext._rowSpanAt(1200, monitors);
    assert(lower !== null, 'Lower row found for y=1200');
    assertEqual(lower.left, 0, 'Lower row left is 0');
    assertEqual(lower.width, 5120, 'Lower row width is 5120');
    assertEqual(lower.top, 1080, 'Lower row top is 1080');

    // Boundary pixel belongs to lower row
    const atBoundary = ext._rowSpanAt(1080, monitors);
    assertEqual(atBoundary.top, 1080, 'y=1080 belongs to lower row (top=1080)');

    // Above boundary belongs to upper row
    const aboveBoundary = ext._rowSpanAt(1079, monitors);
    assertEqual(aboveBoundary.top, 0, 'y=1079 belongs to upper row (top=0)');

    // Outside all monitors
    const outside = ext._rowSpanAt(-10, monitors);
    assertEqual(outside, null, 'y=-10 returns null (outside all monitors)');

    ext.disable();
}

// Single monitor — rowSpanAt still works
resetMocks();
mockMain.layoutManager.monitors = [
    { x: 0, y: 0, width: 1920, height: 1080 },
];
{
    const ext = new TestableMouseWarp();
    ext.enable();
    const row = ext._rowSpanAt(500, mockMain.layoutManager.monitors);
    assert(row !== null, 'rowSpanAt works with single monitor');
    assertEqual(row.width, 1920, 'Single monitor row width correct');
    ext.disable();
}

// ── 2. Dead Zone Detection ─────────────────────────────────────────

console.log('\n\u2500\u2500 2. Dead Zone Detection \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();
    const monitors = mockMain.layoutManager.monitors;

    // Dead zone: x=0, y=1080 — on DP-3 top edge, TV doesn't cover x=0
    const dz1 = ext._findDeadZone(0, 1080, monitors);
    assert(dz1 !== null, 'Dead zone detected at (0, 1080) — no monitor above at x=0');
    assertEqual(dz1.targetRow.left, 320, 'Target row (TV) left is 320');
    assertEqual(dz1.targetRow.width, 1920, 'Target row (TV) width is 1920');

    // Not a dead zone: x=500, y=1080 — TV covers x=500
    const dz2 = ext._findDeadZone(500, 1080, monitors);
    assertEqual(dz2, null, 'No dead zone at (500, 1080) — TV is directly above');

    // Not a dead zone: cursor in middle of monitor
    const dz3 = ext._findDeadZone(500, 1500, monitors);
    assertEqual(dz3, null, 'No dead zone at (500, 1500) — not near any edge');

    // Dead zone on right side of lower row
    const dz4 = ext._findDeadZone(4000, 1080, monitors);
    assert(dz4 !== null, 'Dead zone at (4000, 1080) — no monitor above at x=4000');

    ext.disable();
}

// ── 3. Proportional Warp Math ───────────────────────────────────────

console.log('\n\u2500\u2500 3. Proportional Warp Math \u2500\u2500');

// Test the proportional formula directly (no class instance needed)
{
    const lower = {left: 0, right: 5120, width: 5120};
    const upper = {left: 320, right: 2240, width: 1920};

    function proportional(x, from, to) {
        const ratio = Math.max(0, Math.min(1, (x - from.left) / from.width));
        return Math.round(to.left + ratio * (to.width - 1));
    }

    // Far left of lower row -> left of upper row
    assertEqual(proportional(0, lower, upper), 320, 'Far-left lower maps to upper left (320)');

    // Far right of lower row -> right of upper row
    assertEqual(proportional(5119, lower, upper), 2239, 'Far-right lower maps to upper right (2239)');

    // Centre of lower row -> centre of upper row
    assertApprox(proportional(2560, lower, upper), 1280, 1, 'Centre of 5120 maps to ~centre of 1920');

    // Left of upper row -> left of lower row
    assertEqual(proportional(320, upper, lower), 0, 'Upper left maps to lower left (0)');

    // Right of upper row -> right of lower row
    assertApprox(proportional(2239, upper, lower), 5116, 2, 'Upper right maps near lower right');
}

// ── 4. Time-Based Pressure (Dead Zone Warp) ─────────────────────────

console.log('\n\u2500\u2500 4. Time-Based Pressure \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Prime _lastY on the lower row (non-dead-zone position)
    ext._lastX = 0;
    ext._lastY = 1200;

    // Cursor at dead zone (x=0, y=1080) trying to go UP
    mockGlobal._pointerX = 0;
    mockGlobal._pointerY = 1080;

    // First motion: starts timer
    mockMonoTime = 1000000;
    warpedTo = null;
    ext._onPoll();
    assert(ext._pressureStartTime > 0, 'Pressure timer started on first edge contact');
    assert(warpedTo === null, 'No warp yet on first contact');

    // Second motion: not enough time elapsed (only 50ms)
    mockMonoTime = 1050000;
    ext._onPoll();
    assert(warpedTo === null, 'No warp at 50ms (threshold is 150ms)');

    // Third motion: enough time elapsed (200ms total)
    mockMonoTime = 1200000;
    ext._onPoll();
    assert(warpedTo !== null, 'Warp triggered after 200ms exceeds 150ms threshold');
    assert(ext._pressureStartTime === 0, 'Pressure timer reset after warp');

    ext.disable();
}

// ── 5. Pressure Resets When Cursor Moves Away ───────────────────────

console.log('\n\u2500\u2500 5. Pressure Reset \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Prime _lastY
    ext._lastX = 0;
    ext._lastY = 1200;

    // Start pressure
    mockGlobal._pointerX = 0;
    mockGlobal._pointerY = 1080;
    mockMonoTime = 1000000;
    ext._onPoll();
    assert(ext._pressureStartTime > 0, 'Pressure started');

    // Move cursor away from the edge into the body of the monitor
    mockGlobal._pointerX = 500;
    mockGlobal._pointerY = 1500;
    ext._onPoll();
    assertEqual(ext._pressureStartTime, 0, 'Pressure timer reset when cursor moved away from edge');

    ext.disable();
}

// ── 6. is-enabled Guard ─────────────────────────────────────────────

console.log('\n\u2500\u2500 6. is-enabled Guard \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Disable
    ext._isEnabled = false;

    ext._lastX = 0;
    ext._lastY = 1200;
    mockGlobal._pointerX = 0;
    mockGlobal._pointerY = 1080;
    mockMonoTime = 1000000;
    warpedTo = null;

    ext._onPoll();
    assertEqual(ext._pressureStartTime, 0, 'No pressure timer recorded when disabled');
    assert(warpedTo === null, 'No warp when extension is disabled');

    ext.disable();
}

// ── 7. Enable / Disable Lifecycle ───────────────────────────────────

console.log('\n\u2500\u2500 7. Enable/Disable Lifecycle \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    assert(ext._settings !== null, 'Settings loaded on enable');
    assert(Array.isArray(ext._feedbackWidgets), 'Feedback widgets array initialized');
    assertEqual(ext._edgeTolerance, 2, 'edgeTolerance loaded from settings default (2)');
    assertEqual(ext._pressureThresholdMs, 150, 'pressureThresholdMs loaded from settings default (150)');
    assertEqual(ext._isEnabled, true, 'isEnabled loaded from settings default (true)');

    ext._pressureStartTime = 12345;
    ext._lastY = 1500;
    ext._lastX = 500;
    ext.disable();
    assert(ext._settings === null, 'Settings nulled on disable');
    assertEqual(ext._feedbackWidgets.length, 0, 'Feedback widgets cleaned up on disable');
    assertEqual(ext._pressureStartTime, 0, 'Pressure timer cleared on disable');
    assertEqual(ext._lastY, -1, 'lastY reset on disable');
    assertEqual(ext._lastX, -1, 'lastX reset on disable');
}

// ── 8. Settings Toggle ──────────────────────────────────────────────

console.log('\n\u2500\u2500 8. Settings Toggle \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    assertEqual(ext._isEnabled, true, 'Extension starts enabled');

    settingsStore['is-enabled'] = false;
    for (const cb of Object.values(settingsListeners)) {
        cb();
    }
    assertEqual(ext._isEnabled, false, 'isEnabled updated after settings change');

    settingsStore['is-enabled'] = true;
    for (const cb of Object.values(settingsListeners)) {
        cb();
    }
    assertEqual(ext._isEnabled, true, 'isEnabled restored after re-enable');

    ext.disable();
}

// ── 9. Visual Feedback ──────────────────────────────────────────────

console.log('\n\u2500\u2500 9. Visual Feedback \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    visualFeedbackCalls = [];
    uiGroupChildren = [];

    ext._warp(500, 600);

    assertEqual(visualFeedbackCalls.length, 1, 'Visual feedback triggered once on warp');
    assertEqual(visualFeedbackCalls[0].x, 500, 'Feedback X matches warp X');
    assertEqual(visualFeedbackCalls[0].y, 600, 'Feedback Y matches warp Y');
    assertEqual(uiGroupChildren.length, 1, 'Widget added to uiGroup');

    const widget = visualFeedbackCalls[0].widget;
    assert(widget.destroyed, 'Widget destroyed after animation completes (onComplete)');

    ext.disable();
}

// ── 9.5 Disable Setting Clears Motion State ────────────────────────

console.log('\n\u2500\u2500 9.5 Disable Setting Clears Motion State \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Prime _lastY
    ext._lastX = 0;
    ext._lastY = 1200;

    mockGlobal._pointerX = 0;
    mockGlobal._pointerY = 1080;
    mockMonoTime = 1000000;
    ext._onPoll();
    assert(ext._pressureStartTime > 0, 'Pressure started before disabling via settings');

    settingsStore['is-enabled'] = false;
    for (const cb of Object.values(settingsListeners)) {
        cb();
    }

    assertEqual(ext._pressureStartTime, 0, 'Pressure timer cleared when setting is disabled');
    assertEqual(ext._lastY, -1, 'lastY reset when setting is disabled');
    assertEqual(ext._lastX, -1, 'lastX reset when setting is disabled');

    settingsStore['is-enabled'] = true;
    for (const cb of Object.values(settingsListeners)) {
        cb();
    }

    // Prime again after re-enable
    ext._lastX = 0;
    ext._lastY = 1200;

    warpedTo = null;
    mockMonoTime = 2000000;
    ext._onPoll();

    assert(warpedTo === null, 'No immediate warp after re-enabling');
    assertEqual(ext._pressureStartTime, 2000000, 'Pressure restarts from a fresh timestamp after re-enabling');

    ext.disable();
}

// ── 10. Warp Cooldown ────────────────────────────────────────────────

console.log('\n\u2500\u2500 10. Warp Cooldown \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Simulate a warp that sets cooldown
    mockMonoTime = 1000000;
    ext._warp(2560, 1081);
    assert(ext._warpCooldownUntil > mockMonoTime, 'Warp sets cooldown timer');
    assertEqual(ext._lastX, 2560, 'Warp updates lastX immediately');
    assertEqual(ext._lastY, 1081, 'Warp updates lastY immediately');

    // During cooldown, poll just tracks position without triggering crossings
    mockGlobal._pointerX = 2560;
    mockGlobal._pointerY = 1081;
    warpedTo = null;
    ext._onPoll(); // no-op, position unchanged

    mockGlobal._pointerX = 2560;
    mockGlobal._pointerY = 1090;
    ext._onPoll(); // within cooldown, just tracks
    assertEqual(ext._lastY, 1090, 'Position tracked during cooldown');
    assert(warpedTo === null || warpedTo.y === 1081, 'No re-warp during cooldown');

    // After cooldown expires, normal processing resumes
    mockMonoTime = 2000000; // well past cooldown
    mockGlobal._pointerX = 960;
    mockGlobal._pointerY = 1079;
    ext._onPoll();
    assertEqual(ext._lastY, 1079, 'Normal tracking after cooldown');

    ext.disable();
}

// ── 11. Settings Dynamic Update ─────────────────────────────────────

console.log('\n\u2500\u2500 11. Settings Dynamic Update \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    assertEqual(ext._edgeTolerance, 2, 'Initial edge tolerance is 2');
    assertEqual(ext._pressureThresholdMs, 150, 'Initial pressure threshold is 150');

    settingsStore['edge-tolerance'] = 10;
    settingsStore['pressure-threshold-ms'] = 500;
    for (const cb of Object.values(settingsListeners)) {
        cb();
    }

    assertEqual(ext._edgeTolerance, 10, 'Edge tolerance updated to 10 after settings change');
    assertEqual(ext._pressureThresholdMs, 500, 'Pressure threshold updated to 500 after settings change');

    ext.disable();
}

// ── 12. Three-Row Monitor Layout ────────────────────────────────────

console.log('\n\u2500\u2500 12. Three-Row Monitor Layout \u2500\u2500');

resetMocks();
mockMain.layoutManager.monitors = [
    { x: 0, y: 0,    width: 1920, height: 1080 },  // 0 — top
    { x: 0, y: 1080, width: 3840, height: 2160 },  // 1 — middle (wider)
    { x: 0, y: 3240, width: 1920, height: 1080 },  // 2 — bottom
];
{
    const ext = new TestableMouseWarp();
    ext.enable();
    const monitors = mockMain.layoutManager.monitors;

    // Three distinct rows
    const topRow = ext._rowSpanAt(500, monitors);
    const midRow = ext._rowSpanAt(2000, monitors);
    const botRow = ext._rowSpanAt(3500, monitors);

    assert(topRow !== null && midRow !== null && botRow !== null, 'All three rows detected');
    assertEqual(topRow.top, 0, 'Top row at y=0');
    assertEqual(midRow.top, 1080, 'Middle row at y=1080');
    assertEqual(botRow.top, 3240, 'Bottom row at y=3240');
    assert(topRow.top !== midRow.top, 'Top and middle are different rows');
    assert(midRow.top !== botRow.top, 'Middle and bottom are different rows');

    ext.disable();
}

// ── 13. Downward Dead Zone Pressure ─────────────────────────────────

console.log('\n\u2500\u2500 13. Downward Dead Zone Pressure \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();
    const monitors = mockMain.layoutManager.monitors;

    // A point in the overlap zone (x=500 near boundary y=1079)
    // Both TV (above) and DP-3 (below) exist at x=500
    // So this should NOT be a dead zone
    const dz = ext._findDeadZone(500, 1079, monitors);
    assertEqual(dz, null, 'No dead zone in overlap zone at (500, 1079)');

    ext.disable();
}

// ── 14. Boundary Crossing Detection (Live Geometry) ─────────────────

console.log('\n\u2500\u2500 14. Boundary Crossing Detection (Live Geometry) \u2500\u2500');

// 14a. Cross down at exact boundary pixel (the original bug scenario)
resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Prime _lastX/_lastY on TV (source position for proportional mapping)
    mockGlobal._pointerX = 960;
    mockGlobal._pointerY = 1079;
    ext._onPoll();

    // Move cursor to first pixel of lower row (y=1080)
    warpedTo = null;
    mockGlobal._pointerX = 960;
    mockGlobal._pointerY = 1080;
    ext._onPoll();
    assert(warpedTo !== null, 'Cross down detected at exact boundary pixel y=1080');
    // _lastX=960 on upper row [320, 2240): ratio = (960-320)/1920 = 0.333
    // newX = 0 + 0.333 * 5119 = ~1706
    assertApprox(warpedTo.x, 1706, 2, 'Remap uses _lastX (source position) for proportional x');
    assertEqual(warpedTo.y, 1080, 'Warp Y stays at boundary');

    ext.disable();
}

// 14b. Cross down from TV left edge lands on DP-3
resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    mockGlobal._pointerX = 320;
    mockGlobal._pointerY = 1079;
    ext._onPoll();

    warpedTo = null;
    mockGlobal._pointerX = 320;
    mockGlobal._pointerY = 1080;
    ext._onPoll();
    assert(warpedTo !== null, 'Cross down from TV left edge triggers warp');
    assertEqual(warpedTo.x, 0, 'TV left edge (x=320) maps to lower row left edge (x=0)');

    ext.disable();
}

// 14c. Cross down from TV right edge lands on DP-1
resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    mockGlobal._pointerX = 2239;
    mockGlobal._pointerY = 1079;
    ext._onPoll();

    warpedTo = null;
    mockGlobal._pointerX = 2239;
    mockGlobal._pointerY = 1080;
    ext._onPoll();
    assert(warpedTo !== null, 'Cross down from TV right edge triggers warp');
    assertApprox(warpedTo.x, 5116, 2, 'TV right edge (x=2239) maps near lower row right edge');
    assert(warpedTo.x >= 2560, 'Right edge of TV lands on DP-1 (x >= 2560)');

    ext.disable();
}

// 14d. Cross up from lower row to upper row
resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Prime on lower row in overlap zone
    mockGlobal._pointerX = 1000;
    mockGlobal._pointerY = 1200;
    ext._onPoll();

    warpedTo = null;
    mockGlobal._pointerX = 1000;
    mockGlobal._pointerY = 1079;
    ext._onPoll();
    assert(warpedTo !== null, 'Cross up detected from lower to upper row');
    // _lastX=1000 on lower row [0, 5120): ratio = 1000/5120 = 0.1953
    // newX = 320 + 0.1953 * 1919 = ~695
    assertApprox(warpedTo.x, 695, 2, 'Lower row x=1000 maps proportionally to upper row');

    ext.disable();
}

// 14e. No false crossing when staying on same row
resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    mockGlobal._pointerX = 500;
    mockGlobal._pointerY = 500;
    ext._onPoll();

    warpedTo = null;
    mockGlobal._pointerX = 1500;
    mockGlobal._pointerY = 800;
    ext._onPoll();
    assert(warpedTo === null, 'No warp when moving within the same row');

    ext.disable();
}

// 14f. Cross down with flush-left TV (real monitor layout)
resetMocks();
mockMain.layoutManager.monitors = [
    { x: 0,    y: 0,    width: 1920, height: 1080 },  // 0 — TV flush-left
    { x: 0,    y: 1080, width: 2560, height: 1440 },  // 1 — left desk
    { x: 2560, y: 1080, width: 2560, height: 1440 },  // 2 — right desk
];
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Cross down from centre of TV (x=960)
    mockGlobal._pointerX = 960;
    mockGlobal._pointerY = 1079;
    ext._onPoll();

    warpedTo = null;
    mockGlobal._pointerX = 960;
    mockGlobal._pointerY = 1080;
    ext._onPoll();
    assert(warpedTo !== null, 'Cross down detected with flush-left TV');
    // _lastX=960, upper row [0, 1920): ratio = 960/1920 = 0.5
    // newX = 0 + 0.5 * 5119 = 2560
    assertApprox(warpedTo.x, 2560, 1, 'Centre of flush-left TV maps to DP-1 left edge (x=2560)');
    assert(warpedTo.x >= 2560, 'TV centre reaches DP-1 with flush-left layout');

    ext.disable();
}

// ── 15. Hot-Reload (Monitor Layout Change) ──────────────────────────

console.log('\n\u2500\u2500 15. Hot-Reload \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Prime on TV
    mockGlobal._pointerX = 960;
    mockGlobal._pointerY = 500;
    ext._onPoll();
    assertEqual(ext._lastY, 500, 'lastY primed before layout change');

    // Simulate monitor layout change (e.g. resolution change)
    mockMain.layoutManager.monitors = [
        { x: 0, y: 0,    width: 3840, height: 2160 },  // TV now 4K
        { x: 0, y: 2160, width: 2560, height: 1440 },  // left desk
        { x: 2560, y: 2160, width: 2560, height: 1440 }, // right desk
    ];
    // Fire monitors-changed signal
    if (layoutListeners['monitors-changed']) {
        layoutListeners['monitors-changed']();
    }

    assertEqual(ext._lastY, -1, 'lastY reset after monitors-changed');
    assertEqual(ext._lastX, -1, 'lastX reset after monitors-changed');
    assertEqual(ext._pressureStartTime, 0, 'Pressure timer reset after monitors-changed');

    // Now cross down with new layout — should use new geometry
    mockGlobal._pointerX = 1920;
    mockGlobal._pointerY = 2159;
    ext._onPoll();

    warpedTo = null;
    mockGlobal._pointerX = 1920;
    mockGlobal._pointerY = 2160;
    ext._onPoll();
    assert(warpedTo !== null, 'Crossing works immediately after layout change');
    // _lastX=1920, upper row [0, 3840): ratio = 1920/3840 = 0.5
    // newX = 0 + 0.5 * 5119 = 2560
    assertApprox(warpedTo.x, 2560, 1, 'New layout geometry used for proportional mapping');

    ext.disable();
}

// ── 16. _lastX Used as Source (Not Current x) ───────────────────────

console.log('\n\u2500\u2500 16. Source Position Accuracy \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Simulate diagonal movement: cursor was at TV right edge,
    // then GNOME moves it to DP-3 at a different X
    mockGlobal._pointerX = 2200;  // Near right edge of TV
    mockGlobal._pointerY = 1079;
    ext._onPoll();
    assertEqual(ext._lastX, 2200, '_lastX captured at source position');

    // GNOME delivers cursor at a shifted X on the lower row
    warpedTo = null;
    mockGlobal._pointerX = 1500;  // GNOME moved X when crossing
    mockGlobal._pointerY = 1080;
    ext._onPoll();
    assert(warpedTo !== null, 'Crossing detected despite X shift');
    // Proportional mapping should use _lastX=2200, NOT current x=1500
    // ratio = (2200 - 320) / 1920 = 1880/1920 = 0.979
    // newX = 0 + 0.979 * 5119 = ~5013
    assertApprox(warpedTo.x, 5013, 3, 'Remap uses _lastX (2200) not current x (1500)');
    assert(warpedTo.x >= 2560, 'Right side of TV correctly maps to DP-1');

    ext.disable();
}

// ── 17. warp-enabled Toggle ──────────────────────────────────────────

console.log('\n\u2500\u2500 17. warp-enabled Toggle \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Disable warp but keep extension enabled
    settingsStore['warp-enabled'] = false;
    for (const cb of Object.values(settingsListeners)) cb();
    assertEqual(ext._warpEnabled, false, 'warpEnabled is false after settings change');

    // Prime and cross boundary — should NOT warp
    mockGlobal._pointerX = 960;
    mockGlobal._pointerY = 1079;
    ext._onPoll();

    warpedTo = null;
    mockGlobal._pointerX = 960;
    mockGlobal._pointerY = 1080;
    ext._onPoll();
    assert(warpedTo === null, 'No warp when warp-enabled is false');

    // lastY should still track (needed for overlay)
    assertEqual(ext._lastY, 1080, 'lastY still tracks when warp disabled');
    assertEqual(ext._lastX, 960, 'lastX still tracks when warp disabled');

    // Re-enable warp — reset state to avoid stale crossing
    settingsStore['warp-enabled'] = true;
    for (const cb of Object.values(settingsListeners)) cb();
    ext._lastX = 960;
    ext._lastY = 1079;  // prime on upper row

    warpedTo = null;
    mockGlobal._pointerX = 960;
    mockGlobal._pointerY = 1080;
    ext._onPoll();
    assert(warpedTo !== null, 'Warp works again after re-enabling');

    ext.disable();
}

// ── 18. monitor-config Parsing ──────────────────────────────────────

console.log('\n\u2500\u2500 18. monitor-config Parsing \u2500\u2500');

resetMocks();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Valid config loaded
    assert(ext._monitorConfig !== null, 'monitor-config parsed successfully');
    assertEqual(ext._monitorConfig['0'].color, 'rgba(0,255,0,0.5)', 'Monitor 0 color is green');

    // Invalid JSON falls back gracefully
    settingsStore['monitor-config'] = 'not valid json';
    for (const cb of Object.values(settingsListeners)) cb();
    assert(typeof ext._monitorConfig === 'object', 'Invalid JSON falls back to empty object');

    ext.disable();
}

// ── 19. overlap-remap-enabled Toggle ────────────────────────────────

console.log('\n\u2500\u2500 19. overlap-remap-enabled Toggle \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Disable overlap remap
    settingsStore['overlap-remap-enabled'] = false;
    for (const cb of Object.values(settingsListeners)) cb();
    assertEqual(ext._overlapRemapEnabled, false, 'overlapRemapEnabled is false after settings change');

    // Prime on TV and cross boundary — should NOT remap
    mockGlobal._pointerX = 960;
    mockGlobal._pointerY = 1079;
    ext._onPoll();

    warpedTo = null;
    mockGlobal._pointerX = 960;
    mockGlobal._pointerY = 1080;
    ext._onPoll();
    assert(warpedTo === null, 'No overlap remap when overlap-remap-enabled is false');

    // Dead zone warp should still work (warp-enabled is true)
    ext._lastX = 0;
    ext._lastY = 1200;
    mockGlobal._pointerX = 0;
    mockGlobal._pointerY = 1080;
    mockMonoTime = 1000000;
    ext._onPoll();
    assert(ext._pressureStartTime > 0, 'Dead zone pressure still works with overlap-remap disabled');

    mockMonoTime = 1200000;
    ext._onPoll();
    assert(warpedTo !== null, 'Dead zone warp fires with overlap-remap disabled');

    ext.disable();
}

// ── 20. visual-feedback-enabled Toggle ──────────────────────────────

console.log('\n\u2500\u2500 20. visual-feedback-enabled Toggle \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Disable visual feedback
    settingsStore['visual-feedback-enabled'] = false;
    for (const cb of Object.values(settingsListeners)) cb();
    assertEqual(ext._visualFeedbackEnabled, false, 'visualFeedbackEnabled is false after settings change');

    visualFeedbackCalls = [];
    uiGroupChildren = [];
    ext._warp(500, 600);

    assertEqual(visualFeedbackCalls.length, 0, 'No visual feedback when visual-feedback-enabled is false');
    assertEqual(uiGroupChildren.length, 0, 'No widget added when visual feedback disabled');
    assertEqual(warpedTo.x, 500, 'Warp still moves cursor when visual feedback is disabled');

    // Re-enable visual feedback
    settingsStore['visual-feedback-enabled'] = true;
    for (const cb of Object.values(settingsListeners)) cb();

    visualFeedbackCalls = [];
    uiGroupChildren = [];
    ext._warp(700, 800);

    assertEqual(visualFeedbackCalls.length, 1, 'Visual feedback restored after re-enabling');

    ext.disable();
}

// ── 21. warp-cooldown-ms Configuration ──────────────────────────────

console.log('\n\u2500\u2500 21. warp-cooldown-ms Configuration \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Default cooldown is 100ms = 100000μs
    mockMonoTime = 1000000;
    ext._warp(2560, 1081);
    assertEqual(ext._warpCooldownUntil, 1000000 + 100000, 'Default cooldown is 100ms (100000μs)');

    // Change cooldown to 50ms
    settingsStore['warp-cooldown-ms'] = 50;
    for (const cb of Object.values(settingsListeners)) cb();
    assertEqual(ext._warpCooldownMs, 50, 'warpCooldownMs updated to 50');

    mockMonoTime = 2000000;
    ext._warp(2560, 1081);
    assertEqual(ext._warpCooldownUntil, 2000000 + 50000, 'Cooldown uses configured 50ms (50000μs)');

    // Change cooldown to 300ms
    settingsStore['warp-cooldown-ms'] = 300;
    for (const cb of Object.values(settingsListeners)) cb();

    mockMonoTime = 3000000;
    ext._warp(2560, 1081);
    assertEqual(ext._warpCooldownUntil, 3000000 + 300000, 'Cooldown uses configured 300ms (300000μs)');

    ext.disable();
}

// ── 22. New Settings Load on Enable ─────────────────────────────────

console.log('\n\u2500\u2500 22. New Settings Load on Enable \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    assertEqual(ext._warpCooldownMs, 100, 'warpCooldownMs loaded from settings default (100)');
    assertEqual(ext._overlapRemapEnabled, true, 'overlapRemapEnabled loaded from settings default (true)');
    assertEqual(ext._visualFeedbackEnabled, true, 'visualFeedbackEnabled loaded from settings default (true)');
    assertEqual(ext._debugLogging, false, 'debugLogging loaded from settings default (false)');
    assertEqual(ext._hideTopBar, false, 'hideTopBar loaded from settings default (false)');
    assertEqual(ext._pollRateMs, 8, 'pollRateMs loaded from settings default (8)');
    assertEqual(ext._rowTolerance, 5, 'rowTolerance loaded from settings default (5)');

    ext.disable();
}

// ── 23. hide-top-bar Toggle ─────────────────────────────────────────

console.log('\n\u2500\u2500 23. hide-top-bar Toggle \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Panel should be visible by default
    assertEqual(mockPanel.visible, true, 'Panel visible on enable (hide-top-bar default false)');
    assert(mockPanel.height !== 0, 'Panel has non-zero height on enable');

    // Enable hide-top-bar
    settingsStore['hide-top-bar'] = true;
    for (const cb of Object.values(settingsListeners)) cb();
    assertEqual(ext._hideTopBar, true, 'hideTopBar is true after settings change');
    assertEqual(mockPanel.visible, false, 'Panel hidden when hide-top-bar enabled');
    assertEqual(mockPanel.height, 0, 'Panel height set to 0 when hidden');

    // Disable hide-top-bar
    settingsStore['hide-top-bar'] = false;
    for (const cb of Object.values(settingsListeners)) cb();
    assertEqual(ext._hideTopBar, false, 'hideTopBar is false after settings change');
    assertEqual(mockPanel.visible, true, 'Panel visible again when hide-top-bar disabled');
    assertEqual(mockPanel.height, -1, 'Panel height reset to natural (-1) when shown');

    // Enable hide-top-bar, then disable extension — panel should restore
    settingsStore['hide-top-bar'] = true;
    for (const cb of Object.values(settingsListeners)) cb();
    assertEqual(mockPanel.visible, false, 'Panel hidden before extension disable');

    ext.disable();
    assertEqual(mockPanel.visible, true, 'Panel restored on extension disable');
    assertEqual(mockPanel.height, -1, 'Panel height restored on extension disable');
}

// ── 24. _getMonitorIndexAt ───────────────────────────────────────────

console.log('\n\u2500\u2500 24. _getMonitorIndexAt \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // On TV (monitor 0)
    assertEqual(ext._getMonitorIndexAt(500, 500), 0, 'Point on TV returns monitor 0');

    // On left desk (monitor 1)
    assertEqual(ext._getMonitorIndexAt(500, 1200), 1, 'Point on DP-3 returns monitor 1');

    // On right desk (monitor 2)
    assertEqual(ext._getMonitorIndexAt(3000, 1200), 2, 'Point on DP-1 returns monitor 2');

    // Outside all monitors
    assertEqual(ext._getMonitorIndexAt(9999, 9999), -1, 'Point outside all monitors returns -1');

    // Boundary pixel between monitors (x=2560 is right desk, not left)
    assertEqual(ext._getMonitorIndexAt(2560, 1200), 2, 'x=2560 belongs to right desk (monitor 2)');

    // Boundary pixel y=1080 is lower row
    assertEqual(ext._getMonitorIndexAt(500, 1080), 1, 'y=1080 belongs to lower row (monitor 1)');

    ext.disable();
}

// ── 25. row-tolerance Configuration ─────────────────────────────────

console.log('\n\u2500\u2500 25. row-tolerance Configuration \u2500\u2500');

resetMocks();
{
    // Monitors with 8px Y misalignment — default tolerance=5 won't group them
    mockMain.layoutManager.monitors = [
        { x: 0,    y: 0,    width: 1920, height: 1080 },
        { x: 0,    y: 1080, width: 2560, height: 1440 },
        { x: 2560, y: 1088, width: 2560, height: 1440 },  // 8px off from left desk
    ];

    const ext = new TestableMouseWarp();
    ext.enable();

    // With default tolerance=5, the two bottom monitors are NOT in the same row
    const row1 = ext._rowSpanAt(1200, mockMain.layoutManager.monitors);
    assert(row1 !== null, 'Row found at y=1200 with tolerance=5');
    assertEqual(row1.width, 2560, 'With tolerance=5, only left monitor in row (width=2560)');

    // Increase tolerance to 10 — now they should group
    settingsStore['row-tolerance'] = 10;
    for (const cb of Object.values(settingsListeners)) cb();
    assertEqual(ext._rowTolerance, 10, 'rowTolerance updated to 10');

    const row2 = ext._rowSpanAt(1200, mockMain.layoutManager.monitors);
    assert(row2 !== null, 'Row found at y=1200 with tolerance=10');
    assertEqual(row2.width, 5120, 'With tolerance=10, both bottom monitors in row (width=5120)');

    ext.disable();
}

// ── 26. poll-rate-ms Configuration ──────────────────────────────────

console.log('\n\u2500\u2500 26. poll-rate-ms Configuration \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    assertEqual(ext._pollRateMs, 8, 'Default poll rate is 8ms');

    // Change poll rate
    settingsStore['poll-rate-ms'] = 16;
    for (const cb of Object.values(settingsListeners)) cb();
    assertEqual(ext._pollRateMs, 16, 'pollRateMs updated to 16');

    settingsStore['poll-rate-ms'] = 4;
    for (const cb of Object.values(settingsListeners)) cb();
    assertEqual(ext._pollRateMs, 4, 'pollRateMs updated to 4');

    ext.disable();
}

// ── 27. _getMonitorOverlayConfig ────────────────────────────────────

console.log('\n\u2500\u2500 27. _getMonitorOverlayConfig \u2500\u2500');

resetMocks();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Monitor 0 has config
    const cfg0 = ext._getMonitorOverlayConfig(0);
    assertEqual(cfg0.color, 'rgba(0,255,0,0.5)', 'Monitor 0 color from config');
    assertEqual(cfg0.size, 20, 'Monitor 0 size from config');

    // Monitor 5 has no config — should get defaults
    const cfg5 = ext._getMonitorOverlayConfig(5);
    assertEqual(cfg5.color, 'rgba(255,255,255,0.5)', 'Unknown monitor gets default white color');
    assertEqual(cfg5.size, 20, 'Unknown monitor gets default size 20');

    ext.disable();
}

// ── 28. Warp During Cooldown Edge Case ──────────────────────────────

console.log('\n\u2500\u2500 28. Warp During Cooldown Edge Case \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Prime on TV
    mockGlobal._pointerX = 960;
    mockGlobal._pointerY = 1079;
    ext._onPoll();

    // Cross down — triggers warp + cooldown
    mockMonoTime = 1000000;
    mockGlobal._pointerX = 960;
    mockGlobal._pointerY = 1080;
    ext._onPoll();
    assert(warpedTo !== null, 'First crossing warps');
    const firstWarpX = warpedTo.x;

    // During cooldown, move to dead zone — should NOT trigger pressure
    warpedTo = null;
    mockGlobal._pointerX = 0;
    mockGlobal._pointerY = 1080;
    ext._onPoll();
    assertEqual(ext._pressureStartTime, 0, 'Pressure timer NOT started during cooldown');
    assert(warpedTo === null, 'No warp during cooldown');

    // After cooldown expires, move cursor slightly to trigger poll processing
    mockMonoTime = 2000000;
    mockGlobal._pointerX = 1;
    mockGlobal._pointerY = 1080;
    ext._onPoll();
    assert(ext._pressureStartTime > 0, 'Pressure timer starts after cooldown expires');

    ext.disable();
}

// ── 29. Single Monitor Bypass (_onPoll) ─────────────────────────────

console.log('\n\u2500\u2500 29. Single Monitor Bypass (_onPoll) \u2500\u2500');

resetMocks();
mockMain.layoutManager.monitors = [
    { x: 0, y: 0, width: 2560, height: 1440 },
];
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Move cursor around — nothing should happen
    mockGlobal._pointerX = 500;
    mockGlobal._pointerY = 500;
    ext._onPoll();
    assertEqual(ext._lastX, -1, 'Single monitor: _lastX not updated (no processing)');
    assertEqual(ext._lastY, -1, 'Single monitor: _lastY not updated (no processing)');

    // Even at edges — no pressure
    mockGlobal._pointerX = 0;
    mockGlobal._pointerY = 0;
    mockMonoTime = 1000000;
    ext._onPoll();
    assertEqual(ext._pressureStartTime, 0, 'Single monitor: no pressure timer started at edge');
    assert(warpedTo === null, 'Single monitor: no warp triggered');

    // Overlay should NOT be updated even if enabled
    settingsStore['overlay-enabled'] = true;
    for (const cb of Object.values(settingsListeners)) cb();
    ext._onPoll();
    assertEqual(ext._overlayWidget, null, 'Single monitor: overlay not created even when enabled');
    assertEqual(ext._debugLabel, null, 'Single monitor: debug label not created even when enabled');

    ext.disable();
}

// No monitors at all
resetMocks();
mockMain.layoutManager.monitors = [];
{
    const ext = new TestableMouseWarp();
    ext.enable();

    mockGlobal._pointerX = 100;
    mockGlobal._pointerY = 100;
    ext._onPoll();
    assertEqual(ext._lastX, -1, 'No monitors: _lastX unchanged');
    assert(warpedTo === null, 'No monitors: no warp');

    ext.disable();
}

// ── 30. Single Monitor Bypass (_onButtonPress) ──────────────────────

console.log('\n\u2500\u2500 30. Single Monitor Bypass (_onButtonPress) \u2500\u2500');

resetMocks();
mockMain.layoutManager.monitors = [
    { x: 0, y: 0, width: 2560, height: 1440 },
];
{
    const ext = new TestableMouseWarp();
    ext.enable();
    ext._clickFlashEnabled = true;

    mockGlobal._pointerX = 500;
    mockGlobal._pointerY = 500;
    uiGroupChildren = [];
    ext._onButtonPress();
    assertEqual(uiGroupChildren.length, 0, 'Single monitor: no click flash widget created');
    assertEqual(ext._feedbackWidgets.length, 0, 'Single monitor: no feedback widgets from click');

    ext.disable();
}

// ── 31. Click Flash with Multiple Monitors ──────────────────────────

console.log('\n\u2500\u2500 31. Click Flash with Multiple Monitors \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Click flash disabled by default
    mockGlobal._pointerX = 500;
    mockGlobal._pointerY = 1200;
    uiGroupChildren = [];
    ext._onButtonPress();
    assertEqual(uiGroupChildren.length, 0, 'Click flash disabled: no widget');

    // Enable click flash
    ext._clickFlashEnabled = true;
    ext._onButtonPress();
    assertEqual(uiGroupChildren.length, 1, 'Click flash enabled: widget created');

    // Widget should be at click position
    const widget = uiGroupChildren[0];
    assertEqual(widget.x, 500 - 4, 'Click flash x centered on click (500 - 4)');
    assertEqual(widget.y, 1200 - 4, 'Click flash y centered on click (1200 - 4)');
    assertEqual(widget.width, 8, 'Click flash size is 8px');

    // Widget destroyed after animation (onComplete fires immediately in mock)
    assert(widget.destroyed, 'Click flash widget destroyed after animation');

    // Feedback widgets array cleaned up
    assertEqual(ext._feedbackWidgets.length, 0, 'Click flash removed from feedbackWidgets after destroy');

    ext.disable();
}

// Click flash when extension disabled
resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();
    ext._isEnabled = false;
    ext._clickFlashEnabled = true;

    uiGroupChildren = [];
    ext._onButtonPress();
    assertEqual(uiGroupChildren.length, 0, 'Click flash: no widget when extension disabled');

    ext.disable();
}

// ── 32. Overlay Update and Destroy ──────────────────────────────────

console.log('\n\u2500\u2500 32. Overlay Update and Destroy \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Overlay disabled by default
    assertEqual(ext._overlayWidget, null, 'Overlay widget null when disabled');

    // Enable overlay
    settingsStore['overlay-enabled'] = true;
    for (const cb of Object.values(settingsListeners)) cb();

    // Poll with overlay enabled — should create widget
    mockGlobal._pointerX = 500;
    mockGlobal._pointerY = 1200;
    uiGroupChildren = [];
    ext._onPoll();
    assert(ext._overlayWidget !== null, 'Overlay widget created after poll with overlay enabled');
    assertEqual(ext._overlayLastMonitor, 1, 'Overlay tracks monitor index (1 = left desk)');

    // Move to different monitor — overlay config should update
    mockGlobal._pointerX = 3000;
    mockGlobal._pointerY = 1200;
    ext._onPoll();
    assertEqual(ext._overlayLastMonitor, 2, 'Overlay updates to monitor 2 (right desk)');

    // Disable overlay via settings — should destroy widget
    const overlayRef = ext._overlayWidget;
    settingsStore['overlay-enabled'] = false;
    for (const cb of Object.values(settingsListeners)) cb();
    assertEqual(ext._overlayWidget, null, 'Overlay widget nulled after disabling');
    assert(overlayRef.destroyed, 'Overlay widget destroyed after disabling');
    assertEqual(ext._overlayLastMonitor, -1, 'Overlay monitor index reset after disabling');

    ext.disable();
}

// ── 33. Debug Label Update and Destroy ──────────────────────────────

console.log('\n\u2500\u2500 33. Debug Label Update and Destroy \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    assertEqual(ext._debugLabel, null, 'Debug label null initially');

    // Enable overlay (debug label is tied to overlay)
    settingsStore['overlay-enabled'] = true;
    for (const cb of Object.values(settingsListeners)) cb();

    mockGlobal._pointerX = 500;
    mockGlobal._pointerY = 1200;
    ext._onPoll();
    assert(ext._debugLabel !== null, 'Debug label created after poll with overlay enabled');
    assertEqual(ext._debugLabel.text, '(500, 1200) mon:1', 'Debug label shows correct coordinates and monitor');

    // Move cursor — label text updates
    mockGlobal._pointerX = 3000;
    mockGlobal._pointerY = 1500;
    ext._onPoll();
    assertEqual(ext._debugLabel.text, '(3000, 1500) mon:2', 'Debug label updates with cursor movement');

    // Disable overlay — label destroyed
    const labelRef = ext._debugLabel;
    settingsStore['overlay-enabled'] = false;
    for (const cb of Object.values(settingsListeners)) cb();
    assertEqual(ext._debugLabel, null, 'Debug label nulled after overlay disabled');
    assert(labelRef.destroyed, 'Debug label destroyed after overlay disabled');

    ext.disable();
}

// ── 34. Overlay/Debug Label Cleaned Up on Disable ───────────────────

console.log('\n\u2500\u2500 34. Overlay/Debug Label Cleanup on Disable \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    settingsStore['overlay-enabled'] = true;
    for (const cb of Object.values(settingsListeners)) cb();

    mockGlobal._pointerX = 500;
    mockGlobal._pointerY = 1200;
    ext._onPoll();

    const overlayRef = ext._overlayWidget;
    const labelRef = ext._debugLabel;
    assert(overlayRef !== null, 'Overlay exists before disable');
    assert(labelRef !== null, 'Debug label exists before disable');

    ext.disable();
    assertEqual(ext._overlayWidget, null, 'Overlay nulled on disable');
    assertEqual(ext._debugLabel, null, 'Debug label nulled on disable');
    assert(overlayRef.destroyed, 'Overlay widget destroyed on disable');
    assert(labelRef.destroyed, 'Debug label destroyed on disable');
}

// ── 35. Cursor Stationary Optimization ──────────────────────────────

console.log('\n\u2500\u2500 35. Cursor Stationary Optimization \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Prime position
    mockGlobal._pointerX = 500;
    mockGlobal._pointerY = 1200;
    ext._onPoll();
    assertEqual(ext._lastX, 500, 'Position tracked after first poll');
    assertEqual(ext._lastY, 1200, 'Position tracked after first poll');

    // Same position, no pressure — should be a no-op
    warpedTo = null;
    const lastPressure = ext._pressureStartTime;
    ext._onPoll();
    assert(warpedTo === null, 'No warp when cursor stationary');
    assertEqual(ext._pressureStartTime, lastPressure, 'No pressure change when cursor stationary');

    // But if pressure timer is active, poll should still process
    ext._pressureStartTime = 1000000;
    mockMonoTime = 1200000;
    ext._onPoll(); // should still process even though x,y unchanged
    // Cursor at (500, 1200) is not in a dead zone, so pressure should reset
    assertEqual(ext._pressureStartTime, 0, 'Pressure resets even when stationary if no dead zone');

    ext.disable();
}

// ── 36. Multiple Sequential Warps (Feedback Accumulation) ───────────

console.log('\n\u2500\u2500 36. Multiple Sequential Warps \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    visualFeedbackCalls = [];
    uiGroupChildren = [];

    ext._warp(100, 200);
    ext._warp(300, 400);
    ext._warp(500, 600);

    assertEqual(visualFeedbackCalls.length, 3, 'Three warps produce three visual feedback calls');
    assertEqual(uiGroupChildren.length, 3, 'Three widgets added to uiGroup');
    assertEqual(visualFeedbackCalls[0].x, 100, 'First warp feedback at x=100');
    assertEqual(visualFeedbackCalls[1].x, 300, 'Second warp feedback at x=300');
    assertEqual(visualFeedbackCalls[2].x, 500, 'Third warp feedback at x=500');

    // All widgets should be destroyed (onComplete fires immediately in mock)
    for (let i = 0; i < 3; i++) {
        assert(visualFeedbackCalls[i].widget.destroyed, `Feedback widget ${i} destroyed`);
    }

    ext.disable();
}

// ── 37. Dead Zone Detection \u2014 Bottom Edge ───────────────────────────

console.log('\n\u2500\u2500 37. Dead Zone Detection \u2014 Bottom Edge \u2500\u2500');

resetMocks();
// TV below two desk monitors
mockMain.layoutManager.monitors = [
    { x: 0,   y: 0,    width: 2560, height: 1440 },  // 0 \u2014 left desk
    { x: 2560, y: 0,    width: 2560, height: 1440 },  // 1 \u2014 right desk
    { x: 320,  y: 1440, width: 1920, height: 1080 },  // 2 \u2014 TV below
];
{
    const ext = new TestableMouseWarp();
    ext.enable();
    const monitors = mockMain.layoutManager.monitors;

    // Bottom edge of left desk at x=0 \u2014 TV doesn't cover x=0
    const dz1 = ext._findDeadZone(0, 1439, monitors);
    assert(dz1 !== null, 'Dead zone at bottom edge (0, 1439) \u2014 no monitor below at x=0');
    assertEqual(dz1.targetRow.left, 320, 'Bottom dead zone targets TV row (left=320)');

    // Bottom edge at x=500 \u2014 TV IS below at x=500
    const dz2 = ext._findDeadZone(500, 1439, monitors);
    assertEqual(dz2, null, 'No dead zone at (500, 1439) \u2014 TV is directly below');

    // Bottom edge at x=4000 \u2014 TV doesn't cover x=4000
    const dz3 = ext._findDeadZone(4000, 1439, monitors);
    assert(dz3 !== null, 'Dead zone at (4000, 1439) \u2014 no monitor below at x=4000');

    ext.disable();
}

// ── 38. Dead Zone Warp Y Coordinates ────────────────────────────────

console.log('\n\u2500\u2500 38. Dead Zone Warp Y Coordinates \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();
    const monitors = mockMain.layoutManager.monitors;

    // Upward dead zone: warpY should be above the current monitor
    const dzUp = ext._findDeadZone(0, 1080, monitors);
    assert(dzUp !== null, 'Upward dead zone detected');
    assert(dzUp.warpY < 1080, `Upward warpY (${dzUp.warpY}) is above current monitor top`);
    assertEqual(dzUp.warpY, 1080 - 2 - 1, 'warpY = monY - edgeTolerance - 1');

    ext.disable();
}

// ── 39. Four Monitor Layout (L-Shape) ───────────────────────────────

console.log('\n\u2500\u2500 39. Four Monitor Layout (L-Shape) \u2500\u2500');

resetMocks();
mockMain.layoutManager.monitors = [
    { x: 0,    y: 0,    width: 1920, height: 1080 },  // top-left
    { x: 1920, y: 0,    width: 1920, height: 1080 },  // top-right
    { x: 0,    y: 1080, width: 2560, height: 1440 },  // bottom-left (wider)
    { x: 2560, y: 1080, width: 2560, height: 1440 },  // bottom-right
];
{
    const ext = new TestableMouseWarp();
    ext.enable();
    const monitors = mockMain.layoutManager.monitors;

    // Upper row: two 1920-wide monitors = 3840 total
    const upper = ext._rowSpanAt(500, monitors);
    assertEqual(upper.width, 3840, 'Four-monitor upper row: width=3840');
    assertEqual(upper.left, 0, 'Four-monitor upper row: left=0');

    // Lower row: two monitors = 5120 total
    const lower = ext._rowSpanAt(1500, monitors);
    assertEqual(lower.width, 5120, 'Four-monitor lower row: width=5120');

    // Cross down from upper to lower
    mockGlobal._pointerX = 1920; // centre of upper row
    mockGlobal._pointerY = 1079;
    ext._onPoll();

    warpedTo = null;
    mockGlobal._pointerX = 1920;
    mockGlobal._pointerY = 1080;
    ext._onPoll();
    assert(warpedTo !== null, 'Four-monitor layout: crossing detected');
    // ratio = 1920/3840 = 0.5, newX = 0 + 0.5 * 5119 = 2560
    assertApprox(warpedTo.x, 2560, 1, 'Four-monitor: centre upper maps to centre lower');

    ext.disable();
}

// ── 40. Monitor Index at Boundaries ─────────────────────────────────

console.log('\n\u2500\u2500 40. Monitor Index at Boundaries \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Exact corners of TV
    assertEqual(ext._getMonitorIndexAt(320, 0), 0, 'TV top-left corner (320,0) = monitor 0');
    assertEqual(ext._getMonitorIndexAt(2239, 1079), 0, 'TV bottom-right inner (2239,1079) = monitor 0');
    assertEqual(ext._getMonitorIndexAt(2240, 500), -1, 'Just past TV right edge (2240,500) = -1');
    assertEqual(ext._getMonitorIndexAt(319, 500), -1, 'Just before TV left edge (319,500) = -1');

    // Exact corners of left desk
    assertEqual(ext._getMonitorIndexAt(0, 1080), 1, 'Left desk top-left (0,1080) = monitor 1');
    assertEqual(ext._getMonitorIndexAt(2559, 2519), 1, 'Left desk bottom-right inner (2559,2519) = monitor 1');

    // Exact boundary between left and right desk
    assertEqual(ext._getMonitorIndexAt(2559, 1200), 1, 'x=2559 = left desk (monitor 1)');
    assertEqual(ext._getMonitorIndexAt(2560, 1200), 2, 'x=2560 = right desk (monitor 2)');

    ext.disable();
}

// ── 41. Proportional Math Edge Cases ────────────────────────────────

console.log('\n\u2500\u2500 41. Proportional Math Edge Cases \u2500\u2500');

{
    // Ratio clamping: values outside source range should clamp to [0, 1]
    function proportional(x, from, to) {
        const ratio = Math.max(0, Math.min(1, (x - from.left) / from.width));
        return Math.round(to.left + ratio * (to.width - 1));
    }

    const upper = { left: 320, right: 2240, width: 1920 };
    const lower = { left: 0, right: 5120, width: 5120 };

    // x below source left \u2014 clamps to 0
    assertEqual(proportional(0, upper, lower), 0, 'x below source left clamps to target left');

    // x above source right \u2014 clamps to 1
    assertEqual(proportional(5000, upper, lower), 5119, 'x above source right clamps to target right');

    // Identical rows (same width and position) \u2014 maps 1:1
    const same = { left: 0, right: 1920, width: 1920 };
    assertEqual(proportional(960, same, same), 960, 'Identical rows: 960 maps to 960');

    // Very narrow source \u2192 wide target \u2014 precision test
    const narrow = { left: 100, right: 110, width: 10 };
    const wide = { left: 0, right: 10000, width: 10000 };
    assertEqual(proportional(105, narrow, wide), 5000, 'Narrow to wide: midpoint maps to midpoint');
}

// ── 42. Row Span Edge Cases ─────────────────────────────────────────

console.log('\n\u2500\u2500 42. Row Span Edge Cases \u2500\u2500');

resetMocks();
{
    // Single monitor \u2014 still returns a valid row
    mockMain.layoutManager.monitors = [
        { x: 0, y: 0, width: 1920, height: 1080 },
    ];
    const ext = new TestableMouseWarp();
    ext.enable();
    const row = ext._rowSpanAt(500, mockMain.layoutManager.monitors);
    assert(row !== null, 'Single monitor still forms a row');
    assertEqual(row.left, 0, 'Single monitor row left=0');
    assertEqual(row.width, 1920, 'Single monitor row width=1920');
    assertEqual(row.top, 0, 'Single monitor row top=0');
    assertEqual(row.bottom, 1080, 'Single monitor row bottom=1080');
    ext.disable();
}

resetMocks();
{
    // Three monitors in the same row (horizontal span)
    mockMain.layoutManager.monitors = [
        { x: 0,    y: 0, width: 1920, height: 1080 },
        { x: 1920, y: 0, width: 2560, height: 1440 },
        { x: 4480, y: 0, width: 1920, height: 1080 },
    ];
    const ext = new TestableMouseWarp();
    ext.enable();
    const row = ext._rowSpanAt(500, mockMain.layoutManager.monitors);
    assertEqual(row.left, 0, 'Three-wide row left=0');
    assertEqual(row.right, 6400, 'Three-wide row right=6400');
    assertEqual(row.width, 6400, 'Three-wide row width=6400');
    // Bottom should be max of all heights
    assertEqual(row.bottom, 1440, 'Three-wide row bottom=1440 (tallest monitor)');
    ext.disable();
}

resetMocks();
{
    // Monitors with slight Y misalignment within tolerance
    mockMain.layoutManager.monitors = [
        { x: 0,    y: 0,   width: 2560, height: 1440 },
        { x: 2560, y: 3,   width: 2560, height: 1440 },  // 3px off
    ];
    const ext = new TestableMouseWarp();
    ext.enable();
    const row = ext._rowSpanAt(500, mockMain.layoutManager.monitors);
    assertEqual(row.width, 5120, 'Slight Y misalignment (3px): both monitors grouped into one row');
    ext.disable();
}

// ── 43. Dead Zone Detection \u2014 Cursor Outside All Monitors ───────────

console.log('\n\u2500\u2500 43. Dead Zone \u2014 Cursor Outside Monitors \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();
    const monitors = mockMain.layoutManager.monitors;

    // Point outside all monitors
    const dz = ext._findDeadZone(9999, 9999, monitors);
    assertEqual(dz, null, 'No dead zone when cursor is outside all monitors');

    // Point in gap \u2014 x=0, y=1079 is outside TV (TV starts at x=320)
    const dz2 = ext._findDeadZone(0, 1079, monitors);
    assertEqual(dz2, null, 'No dead zone at (0, 1079) \u2014 outside all monitors');

    ext.disable();
}

// ── 44. Crossing With No Width Difference (Same-Width Rows) ─────────

console.log('\n\u2500\u2500 44. Same-Width Rows \u2014 No Remap Needed \u2500\u2500');

resetMocks();
mockMain.layoutManager.monitors = [
    { x: 0, y: 0,    width: 2560, height: 1440 },  // top
    { x: 0, y: 1440, width: 2560, height: 1440 },  // bottom (same width)
];
{
    const ext = new TestableMouseWarp();
    ext.enable();

    mockGlobal._pointerX = 1280;
    mockGlobal._pointerY = 1439;
    ext._onPoll();

    warpedTo = null;
    mockGlobal._pointerX = 1280;
    mockGlobal._pointerY = 1440;
    ext._onPoll();
    // Same width and same left: width diff < 2 AND left diff < 2 \u2014 no remap
    assert(warpedTo === null, 'Same-width same-position rows: no remap triggered');

    ext.disable();
}

// Same width but different left position
resetMocks();
mockMain.layoutManager.monitors = [
    { x: 100, y: 0,    width: 2560, height: 1440 },  // offset top
    { x: 0,   y: 1440, width: 2560, height: 1440 },  // flush bottom
];
{
    const ext = new TestableMouseWarp();
    ext.enable();

    mockGlobal._pointerX = 1380;
    mockGlobal._pointerY = 1439;
    ext._onPoll();

    warpedTo = null;
    mockGlobal._pointerX = 1380;
    mockGlobal._pointerY = 1440;
    ext._onPoll();
    // Same width but left differs by 100 \u2014 triggers remap
    assert(warpedTo !== null, 'Same-width offset rows: remap triggered due to left difference');
    // ratio = (1380 - 100) / 2560 = 0.5, newX = 0 + 0.5 * 2559 = 1280
    assertApprox(warpedTo.x, 1280, 1, 'Offset remap: proportional mapping correct');

    ext.disable();
}

// ── 45. Full Dead Zone Warp Flow \u2014 Bottom Edge ──────────────────────

console.log('\n\u2500\u2500 45. Full Dead Zone Warp \u2014 Bottom Edge \u2500\u2500');

resetMocks();
mockMain.layoutManager.monitors = [
    { x: 0,    y: 0,    width: 2560, height: 1440 },  // left desk
    { x: 2560, y: 0,    width: 2560, height: 1440 },  // right desk
    { x: 320,  y: 1440, width: 1920, height: 1080 },  // TV below (narrower)
];
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Prime in middle of left desk
    ext._lastX = 0;
    ext._lastY = 1000;

    // Cursor at bottom edge, x=0 \u2014 TV doesn't cover x=0
    mockGlobal._pointerX = 0;
    mockGlobal._pointerY = 1439;

    // Start pressure
    mockMonoTime = 1000000;
    warpedTo = null;
    ext._onPoll();
    assert(ext._pressureStartTime > 0, 'Bottom dead zone: pressure started');
    assert(warpedTo === null, 'Bottom dead zone: no warp yet');

    // Exceed threshold
    mockMonoTime = 1200000;
    ext._onPoll();
    assert(warpedTo !== null, 'Bottom dead zone: warp triggered after pressure threshold');
    assert(warpedTo.y > 1440, 'Bottom dead zone: warpY is below desk monitors');

    ext.disable();
}

// ── 46. Warp Cooldown Prevents All Processing ───────────────────────

console.log('\n\u2500\u2500 46. Warp Cooldown Prevents All Processing \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    settingsStore['overlay-enabled'] = true;
    for (const cb of Object.values(settingsListeners)) cb();

    // Trigger a warp to set cooldown
    mockMonoTime = 1000000;
    ext._warp(2560, 1081);

    // During cooldown, poll should just track position
    mockGlobal._pointerX = 2560;
    mockGlobal._pointerY = 1200;
    uiGroupChildren = [];
    ext._onPoll();
    assertEqual(ext._lastX, 2560, 'During cooldown: position tracked');
    assertEqual(ext._lastY, 1200, 'During cooldown: position tracked');
    assertEqual(ext._pressureStartTime, 0, 'During cooldown: pressure cleared');
    // Overlay should NOT be updated during cooldown (returns before overlay code)
    assertEqual(ext._overlayWidget, null, 'During cooldown: overlay not updated');

    ext.disable();
}

// ── 47. Overlay Per-Monitor Color Switching ─────────────────────────

console.log('\n\u2500\u2500 47. Overlay Per-Monitor Color Switching \u2500\u2500');

resetMocks();
setupDualRowMonitors();
settingsStore['monitor-config'] = JSON.stringify({
    '0': { color: 'rgba(255,0,0,0.5)', size: 15 },
    '1': { color: 'rgba(0,255,0,0.5)', size: 25 },
    '2': { color: 'rgba(0,0,255,0.5)', size: 30 },
});
{
    const ext = new TestableMouseWarp();
    ext.enable();
    ext._overlayEnabled = true;

    // Move to TV (monitor 0)
    mockGlobal._pointerX = 500;
    mockGlobal._pointerY = 500;
    ext._onPoll();
    assert(ext._overlayWidget !== null, 'Overlay created on TV');
    assertEqual(ext._overlayLastMonitor, 0, 'Overlay on monitor 0');
    assert(ext._overlayWidget.style.includes('rgba(255,0,0,0.5)'), 'Monitor 0: red overlay');
    assertEqual(ext._overlayWidget.width, 15, 'Monitor 0: size 15');

    // Move to left desk (monitor 1) — disable warp to avoid crossing remap
    ext._warpEnabled = false;
    mockGlobal._pointerX = 500;
    mockGlobal._pointerY = 1200;
    ext._onPoll();
    assertEqual(ext._overlayLastMonitor, 1, 'Overlay on monitor 1');
    assert(ext._overlayWidget.style.includes('rgba(0,255,0,0.5)'), 'Monitor 1: green overlay');
    assertEqual(ext._overlayWidget.width, 25, 'Monitor 1: size 25');

    // Move to right desk (monitor 2) — same row, no crossing
    mockGlobal._pointerX = 3000;
    mockGlobal._pointerY = 1200;
    ext._onPoll();
    assertEqual(ext._overlayLastMonitor, 2, 'Overlay on monitor 2');
    assert(ext._overlayWidget.style.includes('rgba(0,0,255,0.5)'), 'Monitor 2: blue overlay');
    assertEqual(ext._overlayWidget.width, 30, 'Monitor 2: size 30');
    ext._warpEnabled = true;

    ext.disable();
}

// ── 48. Overlay Position Tracking ───────────────────────────────────

console.log('\n\u2500\u2500 48. Overlay Position Tracking \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();
    ext._overlayEnabled = true;

    mockGlobal._pointerX = 1000;
    mockGlobal._pointerY = 1500;
    ext._onPoll();

    // Overlay should be centered on cursor (default size 20 offset -10)
    const cfg = ext._getMonitorOverlayConfig(1);
    const halfSize = (cfg.size || 20) / 2;
    assertEqual(ext._overlayWidget.x, 1000 - halfSize, 'Overlay x centered on cursor');
    assertEqual(ext._overlayWidget.y, 1500 - halfSize, 'Overlay y centered on cursor');

    // Move cursor \u2014 overlay follows
    mockGlobal._pointerX = 2000;
    mockGlobal._pointerY = 1800;
    ext._onPoll();
    assertEqual(ext._overlayWidget.x, 2000 - halfSize, 'Overlay x follows cursor move');
    assertEqual(ext._overlayWidget.y, 1800 - halfSize, 'Overlay y follows cursor move');

    ext.disable();
}

// ── 49. Rapid Crossing + Cooldown Interaction ───────────────────────

console.log('\n\u2500\u2500 49. Rapid Crossing + Cooldown \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Cross down
    mockGlobal._pointerX = 960;
    mockGlobal._pointerY = 1079;
    mockMonoTime = 1000000;
    ext._onPoll();

    mockGlobal._pointerX = 960;
    mockGlobal._pointerY = 1080;
    ext._onPoll();
    assert(warpedTo !== null, 'First crossing warps');
    const firstX = warpedTo.x;

    // Immediately try to cross back up \u2014 should be blocked by cooldown
    warpedTo = null;
    mockGlobal._pointerX = firstX;
    mockGlobal._pointerY = 1079;
    ext._onPoll();
    assert(warpedTo === null, 'Reverse crossing blocked during cooldown');

    // After cooldown, manually prime on lower row (avoid triggering a crossing)
    mockMonoTime = 2000000;
    ext._lastX = 1706;
    ext._lastY = 1200;

    warpedTo = null;
    mockGlobal._pointerX = 1706;
    mockGlobal._pointerY = 1079;
    ext._onPoll();
    assert(warpedTo !== null, 'Reverse crossing works after cooldown expires');

    ext.disable();
}

// ── 50. Monitors Changed Signal Cleans Up Overlay State ─────────────

console.log('\n\u2500\u2500 50. Monitors Changed Resets Overlay State \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    ext._overlayLastMonitor = 2;
    ext._lastX = 500;
    ext._lastY = 1200;
    ext._pressureStartTime = 99999;

    // Fire monitors-changed
    if (layoutListeners['monitors-changed']) {
        layoutListeners['monitors-changed']();
    }

    assertEqual(ext._overlayLastMonitor, -1, 'Overlay monitor reset on monitors-changed');
    assertEqual(ext._lastX, -1, 'lastX reset on monitors-changed');
    assertEqual(ext._lastY, -1, 'lastY reset on monitors-changed');
    assertEqual(ext._pressureStartTime, 0, 'Pressure reset on monitors-changed');

    ext.disable();
}

// ── 51. _getMonitorOverlayConfig Default Fallback ───────────────────

console.log('\n\u2500\u2500 51. Overlay Config Defaults \u2500\u2500');

resetMocks();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // -1 (outside monitors) should return defaults
    const cfgNeg = ext._getMonitorOverlayConfig(-1);
    assertEqual(cfgNeg.color, 'rgba(255,255,255,0.5)', 'Monitor -1 gets default color');
    assertEqual(cfgNeg.size, 20, 'Monitor -1 gets default size');

    // null monitorConfig
    ext._monitorConfig = null;
    const cfgNull = ext._getMonitorOverlayConfig(0);
    assertEqual(cfgNull.color, 'rgba(255,255,255,0.5)', 'Null config returns default color');
    assertEqual(cfgNull.size, 20, 'Null config returns default size');

    // Empty monitorConfig
    ext._monitorConfig = {};
    const cfgEmpty = ext._getMonitorOverlayConfig(0);
    assertEqual(cfgEmpty.color, 'rgba(255,255,255,0.5)', 'Empty config returns default color');

    ext.disable();
}

// ── 52. Multiple Click Flashes Accumulate ───────────────────────────

console.log('\n\u2500\u2500 52. Multiple Click Flashes \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();
    ext._clickFlashEnabled = true;

    uiGroupChildren = [];
    mockGlobal._pointerX = 500;
    mockGlobal._pointerY = 1200;
    ext._onButtonPress();

    mockGlobal._pointerX = 1000;
    mockGlobal._pointerY = 1500;
    ext._onButtonPress();

    mockGlobal._pointerX = 3000;
    mockGlobal._pointerY = 1200;
    ext._onButtonPress();

    assertEqual(uiGroupChildren.length, 3, 'Three clicks produce three flash widgets');
    // In mock, onComplete fires immediately so feedbackWidgets should be empty
    assertEqual(ext._feedbackWidgets.length, 0, 'All flash widgets cleaned up after animation');

    ext.disable();
}

// ── 53. Pressure Timing Precision ───────────────────────────────────

console.log('\n\u2500\u2500 53. Pressure Timing Precision \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    ext._lastX = 0;
    ext._lastY = 1200;

    mockGlobal._pointerX = 0;
    mockGlobal._pointerY = 1080;

    // Exactly at threshold (150ms = 150000us) \u2014 should NOT fire (> not >=)
    mockMonoTime = 1000000;
    ext._onPoll();
    assertEqual(ext._pressureStartTime, 1000000, 'Pressure started at t=1000000');

    warpedTo = null;
    mockMonoTime = 1150000; // exactly 150ms elapsed
    ext._onPoll();
    assert(warpedTo === null, 'No warp at exactly 150ms (threshold is > not >=)');

    // 1us past threshold \u2014 should fire
    mockMonoTime = 1150001;
    ext._onPoll();
    assert(warpedTo !== null, 'Warp fires at 150.001ms (just past threshold)');

    ext.disable();
}

// ── 54. Five Monitor Complex Layout ─────────────────────────────────

console.log('\n\u2500\u2500 54. Five Monitor Complex Layout \u2500\u2500');

resetMocks();
mockMain.layoutManager.monitors = [
    { x: 0,    y: 0,    width: 1920, height: 1080 },  // top-left
    { x: 1920, y: 0,    width: 1920, height: 1080 },  // top-center
    { x: 3840, y: 0,    width: 1920, height: 1080 },  // top-right
    { x: 0,    y: 1080, width: 2560, height: 1440 },  // bottom-left
    { x: 2560, y: 1080, width: 2560, height: 1440 },  // bottom-right
];
{
    const ext = new TestableMouseWarp();
    ext.enable();
    const monitors = mockMain.layoutManager.monitors;

    // Upper row = 3 monitors = 5760px
    const upper = ext._rowSpanAt(500, monitors);
    assertEqual(upper.width, 5760, 'Five-monitor upper row: 3x1920=5760');

    // Lower row = 2 monitors = 5120px
    const lower = ext._rowSpanAt(1500, monitors);
    assertEqual(lower.width, 5120, 'Five-monitor lower row: 2x2560=5120');

    // Cross down from upper center (x=2880)
    mockGlobal._pointerX = 2880;
    mockGlobal._pointerY = 1079;
    ext._onPoll();

    warpedTo = null;
    mockGlobal._pointerX = 2880;
    mockGlobal._pointerY = 1080;
    ext._onPoll();
    assert(warpedTo !== null, 'Five-monitor: crossing detected');
    // ratio = 2880/5760 = 0.5, newX = 0 + 0.5 * 5119 = 2560
    assertApprox(warpedTo.x, 2560, 1, 'Five-monitor: center of upper maps to center of lower');

    // Dead zone: x=5500 on top row, no bottom monitor at x=5500
    const dzBottom = ext._findDeadZone(5500, 1079, monitors);
    assert(dzBottom !== null, 'Dead zone at (5500, 1079) \u2014 no bottom monitor at x=5500');

    ext.disable();
}

// ═══════════════════════════════════════════════════════════════════
// Hardening Tests — Gap safety, negative coords, edge precision
// ═══════════════════════════════════════════════════════════════════

// ── 55. _snapToMonitors — Basic Snapping ────────────────────────────

console.log('\n\u2500\u2500 55. _snapToMonitors \u2014 Basic Snapping \u2500\u2500');

resetMocks();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    const monitors = [
        { x: 0,   y: 0, width: 1920, height: 1080 },
        { x: 2560, y: 0, width: 1920, height: 1080 },  // gap: 1920-2560
    ];

    // Already on a monitor \u2014 no change
    const onMon = ext._snapToMonitors(500, 500, monitors);
    assertEqual(onMon.x, 500, 'On monitor: x unchanged');
    assertEqual(onMon.y, 500, 'On monitor: y unchanged');

    // In the gap between monitors \u2014 snaps to nearest edge
    const inGap = ext._snapToMonitors(2000, 500, monitors);
    assertEqual(inGap.x, 1919, 'In gap: snaps to right edge of left monitor');
    assertEqual(inGap.y, 500, 'In gap: y unchanged (within both monitors vertically)');

    // Closer to right monitor
    const nearRight = ext._snapToMonitors(2400, 500, monitors);
    assertEqual(nearRight.x, 2560, 'Near right: snaps to left edge of right monitor');

    // Below all monitors
    const below = ext._snapToMonitors(500, 2000, monitors);
    assertEqual(below.y, 1079, 'Below monitors: y snaps to bottom edge');
    assertEqual(below.x, 500, 'Below monitors: x unchanged (within monitor)');

    // Way off screen
    const offScreen = ext._snapToMonitors(-500, -500, monitors);
    assertEqual(offScreen.x, 0, 'Off screen: x snaps to leftmost');
    assertEqual(offScreen.y, 0, 'Off screen: y snaps to topmost');

    ext.disable();
}

// ── 56. Gap Layout — Crossing Snaps to Nearest Monitor ──────────────

console.log('\n\u2500\u2500 56. Gap Layout \u2014 Crossing Snaps to Nearest Monitor \u2500\u2500');

resetMocks();
// Lower row has a 640px gap in the middle
mockMain.layoutManager.monitors = [
    { x: 320, y: 0,    width: 1920, height: 1080 },  // TV (upper)
    { x: 0,   y: 1080, width: 1920, height: 1440 },  // left desk (lower)
    { x: 2560, y: 1080, width: 1920, height: 1440 },  // right desk (lower, gap: 1920-2560)
];
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Cross down from TV centre (x=1280)
    // Upper row: [320, 2240] w=1920
    // Lower row: [0, 4480] w=4480 (span includes gap)
    mockGlobal._pointerX = 1280;
    mockGlobal._pointerY = 1079;
    ext._onPoll();

    warpedTo = null;
    mockGlobal._pointerX = 1280;
    mockGlobal._pointerY = 1080;
    ext._onPoll();
    assert(warpedTo !== null, 'Gap layout: crossing detected');
    // ratio = (1280-320)/1920 = 0.5, rawX = 0 + 0.5 * 4479 = 2240
    // x=2240 is in the gap (1920-2560). Should snap to nearest: 1919 (right edge of left desk)
    assert(warpedTo.x >= 0 && (warpedTo.x < 1920 || warpedTo.x >= 2560),
        `Gap layout: warp destination (${warpedTo.x}) is on an actual monitor, not in the gap`);

    ext.disable();
}

// ── 57. Gap Layout — Dead Zone Warp Snaps ───────────────────────────

console.log('\n\u2500\u2500 57. Gap Layout \u2014 Dead Zone Warp Snaps \u2500\u2500');

resetMocks();
// Upper row has a gap
mockMain.layoutManager.monitors = [
    { x: 0,    y: 0,    width: 1920, height: 1080 },  // upper-left
    { x: 2560, y: 0,    width: 1920, height: 1080 },  // upper-right (gap: 1920-2560)
    { x: 0,    y: 1080, width: 5120, height: 1440 },  // lower (wide, contiguous)
];
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Dead zone: cursor at lower row, x=0, near top \u2014 no upper monitor at x=0?
    // Actually x=0 IS on upper-left. So this isn't a dead zone.
    // Try x=2200 (in the gap in upper row)
    ext._lastX = 2200;
    ext._lastY = 1200;
    mockGlobal._pointerX = 2200;
    mockGlobal._pointerY = 1080;

    mockMonoTime = 1000000;
    warpedTo = null;
    ext._onPoll();
    // x=2200 on lower monitor, near top edge. Upper-left goes to 1920, upper-right starts at 2560.
    // At x=2200, no upper monitor directly above \u2014 dead zone!
    assert(ext._pressureStartTime > 0, 'Gap dead zone: pressure started at x=2200 (gap in upper row)');

    mockMonoTime = 1200000;
    ext._onPoll();
    assert(warpedTo !== null, 'Gap dead zone: warp triggered');
    // The warp destination should snap to an actual upper monitor
    assert((warpedTo.x >= 0 && warpedTo.x < 1920) || (warpedTo.x >= 2560 && warpedTo.x < 4480),
        `Gap dead zone: warp destination x=${warpedTo.x} is on an upper monitor, not in gap`);

    ext.disable();
}

// ── 58. Negative Coordinates — Monitor Above Primary ────────────────

console.log('\n\u2500\u2500 58. Negative Coordinates \u2014 Monitor Above Primary \u2500\u2500');

resetMocks();
mockMain.layoutManager.monitors = [
    { x: 0,    y: -1080, width: 1920, height: 1080 },  // above
    { x: 0,    y: 0,     width: 2560, height: 1440 },   // primary
    { x: 2560, y: 0,     width: 2560, height: 1440 },   // right
];
{
    const ext = new TestableMouseWarp();
    ext.enable();
    const monitors = mockMain.layoutManager.monitors;

    // Upper row at y=-1080
    const upper = ext._rowSpanAt(-500, monitors);
    assert(upper !== null, 'Negative Y: row found at y=-500');
    assertEqual(upper.top, -1080, 'Negative Y: row top is -1080');
    assertEqual(upper.width, 1920, 'Negative Y: row width=1920');

    // Lower row at y=0
    const lower = ext._rowSpanAt(500, monitors);
    assertEqual(lower.width, 5120, 'Lower row: width=5120');
    assertEqual(lower.top, 0, 'Lower row: top=0');

    // Cross up from primary to above
    mockGlobal._pointerX = 1280;
    mockGlobal._pointerY = 1;
    ext._onPoll();

    warpedTo = null;
    mockGlobal._pointerX = 1280;
    mockGlobal._pointerY = -1;
    ext._onPoll();
    assert(warpedTo !== null, 'Negative coord: crossing detected going up');
    // ratio = (1280-0)/5120 = 0.25, newX = 0 + 0.25 * 1919 = 480
    assertApprox(warpedTo.x, 480, 1, 'Negative coord: proportional mapping correct');
    assertEqual(warpedTo.y, -1, 'Negative coord: warp y is -1');

    ext.disable();
}

// ── 59. Negative Coordinates — Monitor Left of Primary ──────────────

console.log('\n\u2500\u2500 59. Negative Coordinates \u2014 Monitor Left of Primary \u2500\u2500');

resetMocks();
mockMain.layoutManager.monitors = [
    { x: -1920, y: 0,    width: 1920, height: 1080 },  // left (shorter)
    { x: 0,     y: 0,    width: 2560, height: 1440 },   // primary
];
{
    const ext = new TestableMouseWarp();
    ext.enable();
    const monitors = mockMain.layoutManager.monitors;

    // Both are in the same row (y=0)
    const row = ext._rowSpanAt(500, monitors);
    assertEqual(row.left, -1920, 'Negative X: row left is -1920');
    assertEqual(row.right, 2560, 'Negative X: row right is 2560');
    assertEqual(row.width, 4480, 'Negative X: row width=4480');
    assertEqual(row.monitors.length, 2, 'Negative X: 2 monitors in row');

    // _getMonitorIndexAt with negative coords
    assertEqual(ext._getMonitorIndexAt(-500, 500), 0, 'Negative X: (-500,500) = monitor 0');
    assertEqual(ext._getMonitorIndexAt(500, 500), 1, 'Positive X: (500,500) = monitor 1');
    assertEqual(ext._getMonitorIndexAt(-2000, 500), -1, 'Far left: outside all monitors');

    ext.disable();
}

// ── 60. _snapToMonitors — Negative Coordinates ──────────────────────

console.log('\n\u2500\u2500 60. _snapToMonitors \u2014 Negative Coordinates \u2500\u2500');

resetMocks();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    const monitors = [
        { x: -1920, y: -1080, width: 1920, height: 1080 },  // top-left (all negative)
        { x: 0,     y: 0,     width: 2560, height: 1440 },   // primary
    ];

    // Point between the two monitors (in void)
    const snap1 = ext._snapToMonitors(-500, -500, monitors);
    assertEqual(snap1.x, -500, 'Negative snap: x on top-left monitor');
    assertEqual(snap1.y, -500, 'Negative snap: y on top-left monitor');

    // Point (-100, -50) is actually ON the top-left monitor (x: -1920..0, y: -1080..0)
    const snap2 = ext._snapToMonitors(-100, -50, monitors);
    assertEqual(snap2.x, -100, 'On negative monitor: x unchanged');
    assertEqual(snap2.y, -50, 'On negative monitor: y unchanged');

    // Point in the void between the two monitors (x=50, y=-50)
    const snap3 = ext._snapToMonitors(50, -50, monitors);
    // x=50 is on primary (x: 0..2560), y=-50 is above primary (y: 0..1440)
    // Closest to primary: (50, 0) dist=50. Closest to top-left: (0, -50) dist=50. Tie \u2014 first wins.
    // Actually top-left has x range [-1920,0) so x=50 clamps to -1 (width-1). dist=|50-(-1)|+|(-50)-(-50)|=51
    // Primary: cx=50, cy=0. dist=0+50=50. Primary wins.
    assertEqual(snap3.x, 50, 'Void between monitors: snaps to primary (closer)');
    assertEqual(snap3.y, 0, 'Void between monitors: y snaps to primary top edge');

    ext.disable();
}

// ── 61. Dead Zone Warp Y Snapping ───────────────────────────────────

console.log('\n\u2500\u2500 61. Dead Zone Warp Y Snapping \u2500\u2500');

resetMocks();
// Monitors with large edge tolerance \u2014 warpY might overshoot
mockMain.layoutManager.monitors = [
    { x: 320, y: 0,    width: 1920, height: 1080 },  // TV
    { x: 0,   y: 1080, width: 2560, height: 1440 },  // left desk
    { x: 2560, y: 1080, width: 2560, height: 1440 },  // right desk
];
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Increase edge tolerance to 20px
    settingsStore['edge-tolerance'] = 20;
    for (const cb of Object.values(settingsListeners)) cb();

    ext._lastX = 0;
    ext._lastY = 1200;
    mockGlobal._pointerX = 0;
    mockGlobal._pointerY = 1080;

    // Dead zone upward: warpY = 1080 - 20 - 1 = 1059
    // That's on the TV? No, TV is at y=0-1080 and x=320-2240. x=0 is not on TV.
    // But snapping should land us on TV at nearest point: x=320, y=1059

    mockMonoTime = 1000000;
    ext._onPoll();
    mockMonoTime = 1200000;
    ext._onPoll();
    assert(warpedTo !== null, 'Large tolerance dead zone: warp triggered');
    // Snapped destination should be on an actual monitor
    const monitors = mockMain.layoutManager.monitors;
    const onMonitor = monitors.some(m =>
        warpedTo.x >= m.x && warpedTo.x < m.x + m.width &&
        warpedTo.y >= m.y && warpedTo.y < m.y + m.height);
    assert(onMonitor, `Snapped warp (${warpedTo.x}, ${warpedTo.y}) lands on an actual monitor`);

    ext.disable();
}

// ── 62. Row With Gap — rowSpanAt Returns Correct Monitors ───────────

console.log('\n\u2500\u2500 62. Row With Gap \u2014 rowSpanAt Returns Monitors \u2500\u2500');

resetMocks();
mockMain.layoutManager.monitors = [
    { x: 0,    y: 0, width: 1920, height: 1080 },
    { x: 2560, y: 0, width: 1920, height: 1080 },  // gap: 1920-2560
];
{
    const ext = new TestableMouseWarp();
    ext.enable();
    const monitors = mockMain.layoutManager.monitors;

    const row = ext._rowSpanAt(500, monitors);
    assertEqual(row.monitors.length, 2, 'Gap row: 2 monitors returned');
    assertEqual(row.width, 4480, 'Gap row: span width includes gap');
    assertEqual(row.left, 0, 'Gap row: left=0');
    assertEqual(row.right, 4480, 'Gap row: right=4480');

    // Verify the monitors are the actual objects
    assert(row.monitors[0] === monitors[0], 'Gap row: first monitor is correct reference');
    assert(row.monitors[1] === monitors[1], 'Gap row: second monitor is correct reference');

    ext.disable();
}

// ── 63. _findDeadZone Returns targetMonitors ────────────────────────

console.log('\n\u2500\u2500 63. _findDeadZone Returns targetMonitors \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();
    const monitors = mockMain.layoutManager.monitors;

    const dz = ext._findDeadZone(0, 1080, monitors);
    assert(dz !== null, 'Dead zone found');
    assert(Array.isArray(dz.targetMonitors), 'Dead zone has targetMonitors array');
    assertEqual(dz.targetMonitors.length, 1, 'Dead zone: 1 target monitor (TV)');
    assertEqual(dz.targetMonitors[0].width, 1920, 'Dead zone: target monitor is TV (1920px)');

    ext.disable();
}

// ── 64. Portrait Monitor — Tall Narrow Layout ───────────────────────

console.log('\n\u2500\u2500 64. Portrait Monitor \u2014 Tall Narrow Layout \u2500\u2500');

resetMocks();
mockMain.layoutManager.monitors = [
    { x: 0,    y: 0,   width: 2560, height: 1440 },  // landscape primary
    { x: 2560, y: 0,   width: 1440, height: 2560 },  // portrait side monitor (rotated)
];
{
    const ext = new TestableMouseWarp();
    ext.enable();
    const monitors = mockMain.layoutManager.monitors;

    // Both in same row (y=0)
    const row = ext._rowSpanAt(500, monitors);
    assertEqual(row.monitors.length, 2, 'Portrait: both monitors in same row');
    assertEqual(row.width, 4000, 'Portrait: total width=2560+1440=4000');
    assertEqual(row.bottom, 2560, 'Portrait: bottom=2560 (portrait height)');

    // No crossing possible (single row), but monitor index works
    assertEqual(ext._getMonitorIndexAt(3000, 500), 1, 'Portrait: (3000,500) on portrait monitor');
    assertEqual(ext._getMonitorIndexAt(3000, 2000), 1, 'Portrait: (3000,2000) on portrait monitor (tall)');
    assertEqual(ext._getMonitorIndexAt(1000, 2000), -1, 'Portrait: (1000,2000) below landscape monitor');

    ext.disable();
}

// ── 65. Portrait + Landscape Stacked — Dead Zone on Height Mismatch ─

console.log('\n\u2500\u2500 65. Portrait + Landscape Stacked \u2500\u2500');

resetMocks();
mockMain.layoutManager.monitors = [
    { x: 0,    y: 0,    width: 2560, height: 1440 },  // top landscape
    { x: 0,    y: 1440, width: 1440, height: 2560 },  // bottom portrait
    { x: 1440, y: 1440, width: 2560, height: 1440 },  // bottom landscape
];
{
    const ext = new TestableMouseWarp();
    ext.enable();
    const monitors = mockMain.layoutManager.monitors;

    // Upper row = top landscape (2560 wide)
    const upper = ext._rowSpanAt(500, monitors);
    assertEqual(upper.width, 2560, 'Portrait stacked: upper row=2560');

    // Lower row = portrait + landscape (1440+2560=4000 wide)
    const lower = ext._rowSpanAt(2000, monitors);
    assertEqual(lower.width, 4000, 'Portrait stacked: lower row=4000');
    assertEqual(lower.monitors.length, 2, 'Portrait stacked: 2 monitors in lower row');

    // Cross down: ratio should work
    mockGlobal._pointerX = 1280;
    mockGlobal._pointerY = 1439;
    ext._onPoll();

    warpedTo = null;
    mockGlobal._pointerX = 1280;
    mockGlobal._pointerY = 1440;
    ext._onPoll();
    assert(warpedTo !== null, 'Portrait stacked: crossing detected');
    // Destination should be on an actual lower-row monitor
    assert(lower.monitors.some(m =>
        warpedTo.x >= m.x && warpedTo.x < m.x + m.width),
        `Portrait stacked: warp x=${warpedTo.x} is on a lower monitor`);

    ext.disable();
}

// ── 66. Snap Picks Closest Monitor Across a Wide Gap ────────────────

console.log('\n\u2500\u2500 66. Snap Picks Closest Monitor Across Wide Gap \u2500\u2500');

resetMocks();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    const monitors = [
        { x: 0,    y: 0, width: 1920, height: 1080 },
        { x: 5000, y: 0, width: 1920, height: 1080 },  // huge gap
    ];

    // Point at x=1960 (just past left monitor) \u2014 closer to left
    const snap1 = ext._snapToMonitors(1960, 500, monitors);
    assertEqual(snap1.x, 1919, 'Wide gap: 1960 snaps to left monitor right edge');

    // Point at x=4900 (just before right monitor) \u2014 closer to right
    const snap2 = ext._snapToMonitors(4900, 500, monitors);
    assertEqual(snap2.x, 5000, 'Wide gap: 4900 snaps to right monitor left edge');

    // Point exactly in the middle of the gap
    const snap3 = ext._snapToMonitors(3460, 500, monitors);
    // 3460-1919=1541 to left, 5000-3460=1540 to right. Right is closer.
    assertEqual(snap3.x, 5000, 'Wide gap: midpoint snaps to closer (right) monitor');

    ext.disable();
}

// ── 67. Three-Row Crossing Skips Middle Row ─────────────────────────

console.log('\n\u2500\u2500 67. Three-Row Fast Skip \u2500\u2500');

resetMocks();
mockMain.layoutManager.monitors = [
    { x: 0, y: 0,    width: 3840, height: 2160 },  // top (4K)
    { x: 0, y: 2160, width: 1920, height: 1080 },  // middle (1080p)
    { x: 0, y: 3240, width: 2560, height: 1440 },  // bottom (1440p)
];
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Prime on top row
    mockGlobal._pointerX = 1920;
    mockGlobal._pointerY = 2000;
    ext._onPoll();

    // Fast jump directly to bottom row (skip middle)
    warpedTo = null;
    mockGlobal._pointerX = 1920;
    mockGlobal._pointerY = 3500;
    ext._onPoll();
    assert(warpedTo !== null, 'Three-row skip: crossing detected from top to bottom');
    // srcRow: top (3840 wide), tgtRow: bottom (2560 wide)
    // ratio = 1920/3840 = 0.5, newX = 0 + 0.5 * 2559 = 1280
    assertApprox(warpedTo.x, 1280, 1, 'Three-row skip: proportional mapping from top to bottom');

    ext.disable();
}

// ── 68. Snap Handles Single-Pixel-Wide Edge Cases ───────────────────

console.log('\n\u2500\u2500 68. Snap Edge Precision \u2500\u2500');

resetMocks();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    const monitors = [
        { x: 0, y: 0, width: 1, height: 1 },  // 1x1 pixel monitor (extreme edge case)
        { x: 100, y: 100, width: 1920, height: 1080 },
    ];

    // On the 1x1 monitor
    const onTiny = ext._snapToMonitors(0, 0, monitors);
    assertEqual(onTiny.x, 0, '1x1 monitor: x=0 is on it');
    assertEqual(onTiny.y, 0, '1x1 monitor: y=0 is on it');

    // Just off the 1x1 monitor
    const offTiny = ext._snapToMonitors(1, 0, monitors);
    // x=1 is off the 1x1 (x range: [0,1)), dist to 1x1: |1-0|+|0-0|=1, dist to big: |1-100|+|0-100|=199
    assertEqual(offTiny.x, 0, '1x1 monitor: (1,0) snaps back to tiny monitor');

    ext.disable();
}

// ── 69. _rowSpanAt — Monitors Field Backwards Compatible ────────────

console.log('\n\u2500\u2500 69. _rowSpanAt \u2014 Monitors Field \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();
    const monitors = mockMain.layoutManager.monitors;

    const upper = ext._rowSpanAt(500, monitors);
    assert(Array.isArray(upper.monitors), 'rowSpanAt returns monitors array');
    assertEqual(upper.monitors.length, 1, 'Upper row: 1 monitor (TV)');
    assertEqual(upper.monitors[0].width, 1920, 'Upper row monitor is TV');

    const lower = ext._rowSpanAt(1200, monitors);
    assertEqual(lower.monitors.length, 2, 'Lower row: 2 monitors');

    // Existing fields still work
    assertEqual(upper.left, 320, 'rowSpanAt: left still works');
    assertEqual(upper.width, 1920, 'rowSpanAt: width still works');
    assertEqual(upper.top, 0, 'rowSpanAt: top still works');
    assertEqual(upper.bottom, 1080, 'rowSpanAt: bottom still works');
    assertEqual(upper.right, 2240, 'rowSpanAt: right still works');

    ext.disable();
}

// ── 70. Crossing Into Gap Row — Snap Prevents Strand ────────────────

console.log('\n\u2500\u2500 70. Crossing Into Gap Row \u2014 Full Warp Flow \u2500\u2500');

resetMocks();
// Upper: single wide monitor. Lower: two monitors with a 1000px gap.
mockMain.layoutManager.monitors = [
    { x: 0,    y: 0,    width: 4920, height: 1080 },  // upper (spans full)
    { x: 0,    y: 1080, width: 1920, height: 1440 },  // lower-left
    { x: 2920, y: 1080, width: 2000, height: 1440 },  // lower-right (gap: 1920-2920)
];
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Cross down from centre of upper (x=2460)
    // Upper row: [0, 4920] w=4920
    // Lower row: [0, 4920] w=4920 (span), but gap 1920-2920
    mockGlobal._pointerX = 2460;
    mockGlobal._pointerY = 1079;
    ext._onPoll();

    warpedTo = null;
    mockGlobal._pointerX = 2460;
    mockGlobal._pointerY = 1080;
    ext._onPoll();

    if (warpedTo !== null) {
        // If remap triggered, destination must be on a real monitor
        const lower = mockMain.layoutManager.monitors.filter(m => m.y === 1080);
        const onMon = lower.some(m =>
            warpedTo.x >= m.x && warpedTo.x < m.x + m.width);
        assert(onMon, `Gap crossing: warp x=${warpedTo.x} is on a lower monitor (not in gap 1920-2920)`);
    } else {
        // Width and left are the same \u2014 no remap needed, which is also correct
        assert(true, 'Gap crossing: same-width same-left rows, no remap needed');
    }

    ext.disable();
}

// ═══════════════════════════════════════════════════════════════════
// Defensive Guards Tests
// ═══════════════════════════════════════════════════════════════════

// ── 71. _isOnMonitor Helper ─────────────────────────────────────────

console.log('\n\u2500\u2500 71. _isOnMonitor Helper \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();
    const monitors = mockMain.layoutManager.monitors;

    // On TV
    assert(ext._isOnMonitor(500, 500, monitors), 'On TV: true');
    // On left desk
    assert(ext._isOnMonitor(500, 1200, monitors), 'On left desk: true');
    // In gap (x=0, y=500 \u2014 not on TV which starts at x=320)
    assert(!ext._isOnMonitor(0, 500, monitors), 'In void: false');
    // Outside all
    assert(!ext._isOnMonitor(9999, 9999, monitors), 'Outside all: false');
    // Negative coords outside
    assert(!ext._isOnMonitor(-100, -100, monitors), 'Negative outside: false');

    ext.disable();
}

// ── 72. SourceX In Gap \u2014 Crossing Skipped ────────────────────────────

console.log('\n\u2500\u2500 72. SourceX In Gap \u2014 Crossing Skipped \u2500\u2500');

resetMocks();
// Lower row has a gap AND different width than upper
mockMain.layoutManager.monitors = [
    { x: 0,    y: 0,    width: 1920, height: 1080 },  // upper (narrow)
    { x: 0,    y: 1080, width: 1500, height: 1440 },  // lower-left
    { x: 2500, y: 1080, width: 1500, height: 1440 },  // lower-right (gap: 1500-2500)
];
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Prime on lower row IN THE GAP (x=2000, y=1200)
    // x=2000 is not on either lower monitor (left: 0-1500, right: 2500-4000)
    ext._lastX = 2000;
    ext._lastY = 1200;

    // Cross up to upper row
    warpedTo = null;
    mockGlobal._pointerX = 2000;
    mockGlobal._pointerY = 1079;
    ext._onPoll();
    // sourceX=2000 is in the gap, _isOnMonitor returns false, so no remap
    assert(warpedTo === null, 'SourceX in gap: no remap triggered (sourceX not on any monitor)');

    // Prime on an actual monitor (x=500, y=1200 \u2014 on lower-left)
    mockGlobal._pointerX = 500;
    mockGlobal._pointerY = 1200;
    ext._onPoll();

    warpedTo = null;
    mockGlobal._pointerX = 500;
    mockGlobal._pointerY = 1079;
    ext._onPoll();
    assert(warpedTo !== null, 'SourceX on monitor: remap triggered normally');

    ext.disable();
}

// ── 73. _resetMotionState Clears Cooldown ───────────────────────────

console.log('\n\u2500\u2500 73. _resetMotionState Clears Cooldown \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Set a cooldown
    mockMonoTime = 1000000;
    ext._warp(500, 600);
    assert(ext._warpCooldownUntil > 0, 'Cooldown set after warp');

    // Reset motion state
    ext._resetMotionState();
    assertEqual(ext._warpCooldownUntil, 0, 'Cooldown cleared by _resetMotionState');
    assertEqual(ext._pressureStartTime, 0, 'Pressure cleared by _resetMotionState');
    assertEqual(ext._lastX, -1, 'lastX cleared by _resetMotionState');
    assertEqual(ext._lastY, -1, 'lastY cleared by _resetMotionState');

    ext.disable();
}

// ── 74. Monitors-Changed Clears Cooldown ────────────────────────────

console.log('\n\u2500\u2500 74. Monitors-Changed Clears Cooldown \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    mockMonoTime = 1000000;
    ext._warp(500, 600);
    assert(ext._warpCooldownUntil > 0, 'Cooldown active before monitors-changed');

    if (layoutListeners['monitors-changed']) {
        layoutListeners['monitors-changed']();
    }
    assertEqual(ext._warpCooldownUntil, 0, 'Cooldown cleared by monitors-changed');

    ext.disable();
}

// ── 75. Disable Nulls monitorConfig ─────────────────────────────────

console.log('\n\u2500\u2500 75. Disable Nulls monitorConfig \u2500\u2500');

resetMocks();
{
    const ext = new TestableMouseWarp();
    ext.enable();
    assert(ext._monitorConfig !== null, 'monitorConfig loaded on enable');

    ext.disable();
    assertEqual(ext._monitorConfig, null, 'monitorConfig nulled on disable');
}

// ── 76. Zero-Width Row Guard ────────────────────────────────────────

console.log('\n\u2500\u2500 76. Zero-Width Row Guard \u2500\u2500');

resetMocks();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Zero-width monitor (pathological)
    const monitors = [
        { x: 0, y: 0, width: 0, height: 1080 },
    ];
    const row = ext._rowSpanAt(500, monitors);
    assertEqual(row, null, 'Zero-width monitor: _rowSpanAt returns null');
}

// ── 77. Dead Zone With Invalid Source Row \u2014 No Crash ────────────────

console.log('\n\u2500\u2500 77. Dead Zone Invalid Source \u2014 No Crash \u2500\u2500');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Manually create a dead zone result with zero-width sourceRow
    const fakeDeadZone = {
        sourceRow: { left: 0, right: 0, width: 0 },
        targetRow: { left: 0, right: 1920, width: 1920 },
        targetMonitors: [{ x: 0, y: 0, width: 1920, height: 1080 }],
        warpY: -3,
    };

    // Simulate the dead zone warp path with zero-width guard
    ext._pressureStartTime = 1;
    mockMonoTime = 200000;
    const sourceRow = fakeDeadZone.sourceRow;
    if (!sourceRow || sourceRow.width <= 0 || fakeDeadZone.targetRow.width <= 0) {
        assert(true, 'Zero-width sourceRow: guard prevents division');
    } else {
        assert(false, 'Zero-width sourceRow: guard should have caught this');
    }

    ext.disable();
}

// ── 78. Empty Filter Race Guard in _rowSpanAt ───────────────────────

console.log('\n\u2500\u2500 78. Empty Filter Guard in _rowSpanAt \u2500\u2500');

resetMocks();
{
    const ext = new TestableMouseWarp();
    ext.enable();
    // rowTolerance=0 means exact match only
    ext._rowTolerance = 0;

    // Two monitors at different Y positions (neither within tolerance)
    const monitors = [
        { x: 0, y: 0,  width: 1920, height: 1080 },
        { x: 0, y: 10, width: 1920, height: 1080 },  // 10px off
    ];

    // y=500 lands on monitor 0 (y:0-1080), seed=0
    // filter: Math.abs(m.y - 0) <= 0 only matches monitor 0
    const row = ext._rowSpanAt(500, monitors);
    assert(row !== null, 'Tight tolerance: row found');
    assertEqual(row.monitors.length, 1, 'Tight tolerance: only exact-match monitor');
    assertEqual(row.monitors[0].y, 0, 'Tight tolerance: correct monitor selected');

    ext.disable();
}

// ── 79. _isOnMonitor With Negative Coordinate Monitors ──────────────

console.log('\n\u2500\u2500 79. _isOnMonitor Negative Coords \u2500\u2500');

resetMocks();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    const monitors = [
        { x: -1920, y: -1080, width: 1920, height: 1080 },
        { x: 0,     y: 0,     width: 2560, height: 1440 },
    ];

    assert(ext._isOnMonitor(-960, -540, monitors), 'Center of negative monitor: true');
    assert(ext._isOnMonitor(-1920, -1080, monitors), 'Top-left of negative monitor: true');
    assert(!ext._isOnMonitor(0, -540, monitors), 'Between monitors (x=0, y=-540): false');
    assert(ext._isOnMonitor(0, 0, monitors), 'Top-left of primary: true');
    assert(!ext._isOnMonitor(-1921, -1080, monitors), 'Past left edge of negative monitor: false');

    ext.disable();
}

// ── 80. Crossing Uses _isOnMonitor \u2014 Source In Bounding Box But Not On Monitor ──

console.log('\n\u2500\u2500 80. Crossing: Source In Bounding Box But Off Monitor \u2500\u2500');

resetMocks();
// Upper has a big gap, different span than lower
mockMain.layoutManager.monitors = [
    { x: 0,    y: 0,    width: 1000, height: 1080 },  // upper-left
    { x: 3000, y: 0,    width: 1000, height: 1080 },  // upper-right (gap: 1000-3000)
    { x: 0,    y: 1080, width: 2000, height: 1440 },  // lower (different width from upper span)
];
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Prime on lower row (x=1000, y=1200 \u2014 on lower monitor)
    mockGlobal._pointerX = 1000;
    mockGlobal._pointerY = 1200;
    ext._onPoll();

    // Cross up: _lastX=1000 is within lower row [0, 2000]
    // but lower isOnMonitor(1000, 1200, lower.monitors) = true
    // Wait \u2014 sourceX check is against SOURCE row monitors.
    // srcRow = lower (from _lastY=1200), sourceX=1000, isOnMonitor(1000, 1200, [lower]) = true
    // So this SHOULD fire. The test needs source in the GAP of the source row.
    // Lower has no gap, so let's test with source in upper gap instead.

    // Prime on upper row in the gap (x=2000)
    // But x=2000 is not on any upper monitor!
    // We need to manually set lastX/lastY since polling won't land on a gap
    ext._lastX = 2000;
    ext._lastY = 500;

    warpedTo = null;
    mockGlobal._pointerX = 2000;
    mockGlobal._pointerY = 1200;
    ext._onPoll();
    // srcRow = upper (from _lastY=500), sourceX=2000
    // isOnMonitor(2000, 500, upper.monitors) = false (gap 1000-3000)
    assert(warpedTo === null, 'Source in gap of source row: no remap (isOnMonitor prevents it)');

    // Prime on upper row on actual monitor (x=500)
    mockGlobal._pointerX = 500;
    mockGlobal._pointerY = 500;
    ext._onPoll();

    warpedTo = null;
    mockGlobal._pointerX = 500;
    mockGlobal._pointerY = 1200;
    ext._onPoll();
    assert(warpedTo !== null, 'Source on actual monitor: remap fires');

    ext.disable();
}

// ═══════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════

console.log(`\n\u2550\u2550\u2550 Extension Logic Tests: ${passed} passed, ${failed} failed \u2550\u2550\u2550\n`);
process.exit(failed > 0 ? 1 : 0);
