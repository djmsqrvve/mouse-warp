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
            const wasHideTopBar = this._hideTopBar;
            this._loadSettings();
            if (this._hideTopBar !== wasHideTopBar)
                this._applyTopBar();
        });

        this._resetMotionState();
        this._feedbackWidgets = [];
        this._warpCooldownUntil = 0;

        this._monitorsChangedId = mockMain.layoutManager.connect(
            'monitors-changed', () => this._resetMotionState()
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
    }

    disable() {
        this._restoreTopBar();
        this._resetMotionState();

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

        const monitors = mockMain.layoutManager.monitors;

        if (!monitors || monitors.length < 2) {
            this._lastX = x;
            this._lastY = y;
            return;
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
                        if (sourceX >= srcRow.left && sourceX < srcRow.right) {
                            const ratio = Math.max(0, Math.min(1,
                                (sourceX - srcRow.left) / srcRow.width));
                            const newX = Math.round(
                                tgtRow.left + ratio * (tgtRow.width - 1));
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

// ═══════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════

console.log(`\n\u2550\u2550\u2550 Extension Logic Tests: ${passed} passed, ${failed} failed \u2550\u2550\u2550\n`);
process.exit(failed > 0 ? 1 : 0);
