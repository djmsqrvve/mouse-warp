/**
 * test_extension_logic.js — Unit tests for Mouse Warp core logic.
 *
 * Runs on Node.js with mocked GNOME Shell APIs.
 * Tests: boundary building, proportional math, time-based pressure,
 *        enable/disable lifecycle, tray toggle, visual feedback, and
 *        the is-enabled guard.
 */

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`  ✔ ${message}`);
        passed++;
    } else {
        console.error(`  ✘ FAIL: ${message}`);
        failed++;
    }
}

function assertEqual(actual, expected, message) {
    assert(
        actual === expected,
        `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
}

function assertApprox(actual, expected, tolerance, message) {
    assert(
        Math.abs(actual - expected) <= tolerance,
        `${message} — expected ~${expected}±${tolerance}, got ${actual}`
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
let panelStatusItems = {};
let uiGroupChildren = [];
let indicatorCreated = false;
let indicatorDestroyed = false;
let toggleSwitchState = null;

function resetMocks() {
    mockMonoTime = 0;
    warpedTo = null;
    visualFeedbackCalls = [];
    stageListeners = {};
    layoutListeners = {};
    settingsStore = {
        'edge-tolerance': 2,
        'pressure-threshold-ms': 150,
        'is-enabled': true,
    };
    settingsListeners = {};
    panelStatusItems = {};
    uiGroupChildren = [];
    indicatorCreated = false;
    indicatorDestroyed = false;
    toggleSwitchState = null;
}

// Mock global objects
const mockClutter = {
    EventType: { MOTION: 'motion' },
    EVENT_PROPAGATE: 0,
    AnimationMode: { EASE_OUT_QUAD: 'ease-out-quad' },
    get_default_backend: () => ({
        get_default_seat: () => ({
            warp_pointer: (x, y) => { warpedTo = { x, y }; }
        })
    })
};

const mockGLib = {
    get_monotonic_time: () => mockMonoTime,
};

let mockMonitors = [];
const mockMain = {
    layoutManager: {
        monitors: mockMonitors,
        connect: (signal, cb) => { layoutListeners[signal] = cb; return 1; },
        disconnect: () => {},
    },
    panel: {
        addToStatusArea: (name, indicator) => { panelStatusItems[name] = indicator; },
    },
    uiGroup: {
        add_child: (widget) => { uiGroupChildren.push(widget); },
    },
    notify: () => {},
};

function createMockSettings() {
    let listenerId = 0;
    return {
        get_int: (key) => settingsStore[key],
        get_boolean: (key) => settingsStore[key],
        set_boolean: (key, val) => { settingsStore[key] = val; },
        connect: (signal, cb) => { settingsListeners[++listenerId] = cb; return listenerId; },
        disconnect: (id) => { delete settingsListeners[id]; },
    };
}

const mockSt = {
    Icon: class { constructor(opts) { this.opts = opts; } },
    Widget: class {
        constructor(opts) {
            Object.assign(this, opts);
            this.destroyed = false;
        }
        ease(opts) { this._easeOpts = opts; if (opts.onComplete) opts.onComplete(); }
        destroy() { this.destroyed = true; }
    },
};

const mockPanelMenu = {
    Button: class {
        constructor() {
            this.children = [];
            this.menu = { menuItems: [], addMenuItem(item) { this.menuItems.push(item); } };
            indicatorCreated = true;
        }
        add_child(c) { this.children.push(c); }
        destroy() { indicatorDestroyed = true; }
    },
};

const mockPopupMenu = {
    PopupSwitchMenuItem: class {
        constructor(label, state) { this.label = label; this._state = state; this._listeners = {}; toggleSwitchState = state; }
        connect(signal, cb) { this._listeners[signal] = cb; }
        setToggleState(state) { this._state = state; toggleSwitchState = state; }
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
    constructor() {
        // Mimics Extension base class
    }

    getSettings() {
        return createMockSettings();
    }

    enable() {
        this._settings = this.getSettings();
        this._loadSettings();

        this._settingsChangedId = this._settings.connect('changed', () => {
            this._loadSettings();
        });

        this._resetMotionState();
        this._boundaries = [];
        this._feedbackWidgets = [];
        this._buildBoundaries();

        this._stageEventId = mockGlobal.stage.connect('captured-event', (_, event) => {
            if (event.type() === mockClutter.EventType.MOTION)
                this._onMotion();
            return mockClutter.EVENT_PROPAGATE;
        });

        this._monitorsChangedId = mockMain.layoutManager.connect(
            'monitors-changed', () => this._buildBoundaries()
        );
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
    }

    disable() {
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
        this._boundaries = [];
    }

    _buildBoundaries() {
        const monitors = mockMain.layoutManager.monitors;
        this._boundaries = [];

        if (!monitors || monitors.length < 2)
            return;

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

        const sorted = [...rows.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, indices]) => indices);

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
                return { left: l, right: r, width: r - l };
            };
            const us = span(upper);
            const ls = span(lower);

            if (Math.abs(us.width - ls.width) < 2 && Math.abs(us.left - ls.left) < 2)
                continue;

            this._boundaries.push({
                y: Math.round((upperBottom + lowerTop) / 2),
                upper: { ...us, indices: new Set(upperIdx) },
                lower: { ...ls, indices: new Set(lowerIdx) },
            });
        }
    }

    _monitorIndexAt(x, y) {
        const monitors = mockMain.layoutManager.monitors;
        for (let i = 0; i < monitors.length; i++) {
            const m = monitors[i];
            if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height)
                return i;
        }
        return -1;
    }

    _warp(x, y) {
        this._skipWarpEvent = true;
        mockClutter.get_default_backend().get_default_seat().warp_pointer(x, y);
        this._showVisualFeedback(x, y);
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

    _warpProportional(x, _y, from, to, targetY) {
        const ratio = Math.max(0, Math.min(1, (x - from.left) / from.width));
        const newX = Math.round(to.left + ratio * (to.width - 1));
        if (Math.abs(newX - x) > 1 || targetY !== _y)
            this._warp(newX, targetY);
    }

    _onMotion() {
        if (!this._isEnabled) {
            this._resetMotionState();
            return;
        }

        if (this._skipWarpEvent) {
            this._skipWarpEvent = false;
            const [x, y] = mockGlobal.get_pointer();
            this._lastMonitorIndex = this._monitorIndexAt(x, y);
            return;
        }

        const [x, y] = mockGlobal.get_pointer();
        const monIdx = this._monitorIndexAt(x, y);

        if (
            this._lastMonitorIndex >= 0 &&
            monIdx >= 0 &&
            monIdx !== this._lastMonitorIndex
        ) {
            for (const b of this._boundaries) {
                if (
                    b.lower.indices.has(this._lastMonitorIndex) &&
                    b.upper.indices.has(monIdx)
                ) {
                    this._warpProportional(x, y, b.lower, b.upper, y);
                    this._lastMonitorIndex = monIdx;
                    this._pressureStartTime = 0;
                    return;
                }
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

        for (const b of this._boundaries) {
            if (
                Math.abs(y - b.y) <= this._edgeTolerance &&
                x >= b.lower.left && x < b.lower.right &&
                (x < b.upper.left || x >= b.upper.right)
            ) {
                if (this._pressureStartTime === 0) {
                    this._pressureStartTime = mockGLib.get_monotonic_time();
                } else {
                    const elapsedMs = (mockGLib.get_monotonic_time() - this._pressureStartTime) / 1000;
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

            if (
                Math.abs(y - b.y) <= this._edgeTolerance &&
                x >= b.upper.left && x < b.upper.right &&
                (x < b.lower.left || x >= b.lower.right)
            ) {
                if (this._pressureStartTime === 0) {
                    this._pressureStartTime = mockGLib.get_monotonic_time();
                } else {
                    const elapsedMs = (mockGLib.get_monotonic_time() - this._pressureStartTime) / 1000;
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

// ═══════════════════════════════════════════════════════════════════
// Test Cases
// ═══════════════════════════════════════════════════════════════════

// ── 1. Boundary Building ────────────────────────────────────────────

console.log('\n── 1. Boundary Building ──');

function setupDualRowMonitors() {
    // Upper: 1920×1080 TV centred at x=320
    // Lower: two 2560×1440 monitors side by side (total 5120px)
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
    assertEqual(ext._boundaries.length, 1, 'Single boundary detected between upper/lower rows');

    const b = ext._boundaries[0];
    assertEqual(b.y, 1080, 'Boundary Y is at 1080 (junction of upper and lower rows)');
    assertEqual(b.upper.left, 320, 'Upper span left is 320');
    assertEqual(b.upper.width, 1920, 'Upper span width is 1920');
    assertEqual(b.lower.left, 0, 'Lower span left is 0');
    assertEqual(b.lower.width, 5120, 'Lower span width is 5120');
    assert(b.upper.indices.has(0), 'Upper row contains monitor index 0');
    assert(b.lower.indices.has(1), 'Lower row contains monitor index 1');
    assert(b.lower.indices.has(2), 'Lower row contains monitor index 2');
    ext.disable();
}

// Single monitor — no boundaries
resetMocks();
mockMain.layoutManager.monitors = [
    { x: 0, y: 0, width: 1920, height: 1080 },
];
{
    const ext = new TestableMouseWarp();
    ext.enable();
    assertEqual(ext._boundaries.length, 0, 'No boundaries with a single monitor');
    ext.disable();
}

// Two monitors same width side-by-side in one row — no boundaries
resetMocks();
mockMain.layoutManager.monitors = [
    { x: 0, y: 0, width: 2560, height: 1440 },
    { x: 2560, y: 0, width: 2560, height: 1440 },
];
{
    const ext = new TestableMouseWarp();
    ext.enable();
    assertEqual(ext._boundaries.length, 0, 'No boundaries with equal-width same-row monitors');
    ext.disable();
}

// ── 2. Monitor Index Detection ──────────────────────────────────────

console.log('\n── 2. Monitor Index Detection ──');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();
    assertEqual(ext._monitorIndexAt(500, 500), 0, 'Point (500,500) is in monitor 0 (TV)');
    assertEqual(ext._monitorIndexAt(100, 1200), 1, 'Point (100,1200) is in monitor 1 (left desk)');
    assertEqual(ext._monitorIndexAt(3000, 1200), 2, 'Point (3000,1200) is in monitor 2 (right desk)');
    assertEqual(ext._monitorIndexAt(-10, -10), -1, 'Point (-10,-10) is outside all monitors');
    ext.disable();
}

// ── 3. Proportional Warp Math ───────────────────────────────────────

console.log('\n── 3. Proportional Warp Math ──');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    const b = ext._boundaries[0];

    // Far left of lower row → should map to left of upper row
    warpedTo = null;
    ext._warpProportional(0, 1080, b.lower, b.upper, 1079);
    assert(warpedTo !== null, 'Warp triggered for far-left lower→upper');
    assertEqual(warpedTo.x, b.upper.left, 'Far-left maps to upper left (320)');
    assertEqual(warpedTo.y, 1079, 'Y matches target');

    // Far right of lower row → should map to right of upper row
    warpedTo = null;
    ext._warpProportional(5119, 1080, b.lower, b.upper, 1079);
    assert(warpedTo !== null, 'Warp triggered for far-right lower→upper');
    assertEqual(warpedTo.x, b.upper.left + b.upper.width - 1, 'Far-right maps to upper right (2239)');

    // Middle of lower row → should map to middle of upper row
    warpedTo = null;
    ext._warpProportional(2560, 1080, b.lower, b.upper, 1079);
    assert(warpedTo !== null, 'Warp triggered for centre lower→upper');
    assertApprox(warpedTo.x, 1280, 1, 'Centre of 5120 maps to ~centre of 1920 (1280)');

    ext.disable();
}

// ── 4. Time-Based Pressure (Dead Zone Warp) ─────────────────────────

console.log('\n── 4. Time-Based Pressure ──');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();
    ext._lastMonitorIndex = 1; // pretend we're in lower-left desk

    // Cursor at dead zone (x=0, y=1080) trying to go UP
    // x=0 is inside lower span (0..5120) but outside upper span (320..2240)
    mockGlobal._pointerX = 0;
    mockGlobal._pointerY = 1080;

    // First motion: starts timer
    mockMonoTime = 1000000; // 1 second in microseconds
    warpedTo = null;
    ext._onMotion();
    assert(ext._pressureStartTime > 0, 'Pressure timer started on first edge contact');
    assert(warpedTo === null, 'No warp yet on first contact');

    // Second motion: not enough time elapsed (only 50ms)
    mockMonoTime = 1050000; // +50ms
    ext._onMotion();
    assert(warpedTo === null, 'No warp at 50ms (threshold is 150ms)');

    // Third motion: enough time elapsed (200ms total)
    mockMonoTime = 1200000; // +200ms from start, over 150ms threshold
    ext._onMotion();
    assert(warpedTo !== null, 'Warp triggered after 200ms exceeds 150ms threshold');
    assert(ext._pressureStartTime === 0, 'Pressure timer reset after warp');

    ext.disable();
}

// ── 5. Pressure Resets When Cursor Moves Away ───────────────────────

console.log('\n── 5. Pressure Reset ──');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();
    ext._lastMonitorIndex = 1;

    // Start pressure
    mockGlobal._pointerX = 0;
    mockGlobal._pointerY = 1080;
    mockMonoTime = 1000000;
    ext._onMotion();
    assert(ext._pressureStartTime > 0, 'Pressure started');

    // Move cursor away from the edge into the body of the monitor
    mockGlobal._pointerX = 500;
    mockGlobal._pointerY = 1500;
    ext._onMotion();
    assertEqual(ext._pressureStartTime, 0, 'Pressure timer reset when cursor moved away from edge');

    ext.disable();
}

// ── 6. is-enabled Guard ─────────────────────────────────────────────

console.log('\n── 6. is-enabled Guard ──');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Disable
    ext._isEnabled = false;

    ext._lastMonitorIndex = 1;
    mockGlobal._pointerX = 0;
    mockGlobal._pointerY = 1080;
    mockMonoTime = 1000000;
    warpedTo = null;

    ext._onMotion();
    assertEqual(ext._pressureStartTime, 0, 'No pressure timer recorded when disabled');
    assert(warpedTo === null, 'No warp when extension is disabled');

    ext.disable();
}

// ── 7. Enable / Disable Lifecycle ───────────────────────────────────

console.log('\n── 7. Enable/Disable Lifecycle ──');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    assert(ext._settings !== null, 'Settings loaded on enable');
    assert(ext._boundaries.length > 0, 'Boundaries built on enable');
    assert(Array.isArray(ext._feedbackWidgets), 'Feedback widgets array initialized');
    assertEqual(ext._edgeTolerance, 2, 'edgeTolerance loaded from settings default (2)');
    assertEqual(ext._pressureThresholdMs, 150, 'pressureThresholdMs loaded from settings default (150)');
    assertEqual(ext._isEnabled, true, 'isEnabled loaded from settings default (true)');

    ext._skipWarpEvent = true;
    ext._pressureStartTime = 12345;
    ext._lastMonitorIndex = 1;
    ext.disable();
    assert(ext._settings === null, 'Settings nulled on disable');
    assertEqual(ext._feedbackWidgets.length, 0, 'Feedback widgets cleaned up on disable');
    assertEqual(ext._boundaries.length, 0, 'Boundaries cleared on disable');
    assertEqual(ext._skipWarpEvent, false, 'skipWarpEvent cleared on disable');
    assertEqual(ext._pressureStartTime, 0, 'Pressure timer cleared on disable');
    assertEqual(ext._lastMonitorIndex, -1, 'lastMonitorIndex reset on disable');
}

// ── 8. Settings Toggle ──────────────────────────────────────────────

console.log('\n── 8. Settings Toggle ──');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    assertEqual(ext._isEnabled, true, 'Extension starts enabled');

    // Simulate settings change to disabled
    settingsStore['is-enabled'] = false;
    for (const cb of Object.values(settingsListeners)) {
        cb();
    }
    assertEqual(ext._isEnabled, false, 'isEnabled updated after settings change');

    // Re-enable
    settingsStore['is-enabled'] = true;
    for (const cb of Object.values(settingsListeners)) {
        cb();
    }
    assertEqual(ext._isEnabled, true, 'isEnabled restored after re-enable');

    ext.disable();
}

// ── 9. Visual Feedback ──────────────────────────────────────────────

console.log('\n── 9. Visual Feedback ──');

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

console.log('\n── 9.5 Disable Setting Clears Motion State ──');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();
    ext._lastMonitorIndex = 1;

    mockGlobal._pointerX = 0;
    mockGlobal._pointerY = 1080;
    mockMonoTime = 1000000;
    ext._onMotion();
    assert(ext._pressureStartTime > 0, 'Pressure started before disabling via settings');

    ext._skipWarpEvent = true;
    settingsStore['is-enabled'] = false;
    for (const cb of Object.values(settingsListeners)) {
        cb();
    }

    assertEqual(ext._pressureStartTime, 0, 'Pressure timer cleared when setting is disabled');
    assertEqual(ext._skipWarpEvent, false, 'skipWarpEvent cleared when setting is disabled');
    assertEqual(ext._lastMonitorIndex, -1, 'lastMonitorIndex reset when setting is disabled');

    settingsStore['is-enabled'] = true;
    for (const cb of Object.values(settingsListeners)) {
        cb();
    }

    warpedTo = null;
    mockMonoTime = 2000000;
    ext._onMotion();

    assert(warpedTo === null, 'No immediate warp after re-enabling');
    assertEqual(ext._pressureStartTime, 2000000, 'Pressure restarts from a fresh timestamp after re-enabling');

    ext.disable();
}

// ── 10. Skip Warp Event ─────────────────────────────────────────────

console.log('\n── 10. Skip Warp Event ──');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // Simulate a warp setting _skipWarpEvent
    ext._skipWarpEvent = true;
    mockGlobal._pointerX = 500;
    mockGlobal._pointerY = 500;

    const prevPressure = ext._pressureStartTime;
    ext._onMotion();

    assertEqual(ext._skipWarpEvent, false, 'skipWarpEvent reset after consuming');
    assertEqual(ext._lastMonitorIndex, 0, 'lastMonitorIndex updated during skip');
    assertEqual(ext._pressureStartTime, prevPressure, 'Pressure timer unchanged during skip event');

    ext.disable();
}

// ── 11. Settings Dynamic Update ─────────────────────────────────────

console.log('\n── 11. Settings Dynamic Update ──');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    assertEqual(ext._edgeTolerance, 2, 'Initial edge tolerance is 2');
    assertEqual(ext._pressureThresholdMs, 150, 'Initial pressure threshold is 150');

    // Simulate user changing settings
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

console.log('\n── 12. Three-Row Monitor Layout ──');

resetMocks();
mockMain.layoutManager.monitors = [
    { x: 0, y: 0,    width: 1920, height: 1080 },  // 0 — top
    { x: 0, y: 1080, width: 3840, height: 2160 },  // 1 — middle (wider)
    { x: 0, y: 3240, width: 1920, height: 1080 },  // 2 — bottom
];
{
    const ext = new TestableMouseWarp();
    ext.enable();
    assertEqual(ext._boundaries.length, 2, 'Two boundaries detected in a three-row layout');
    assertEqual(ext._boundaries[0].y, 1080, 'First boundary at y=1080');
    assertEqual(ext._boundaries[1].y, 3240, 'Second boundary at y=3240');
    ext.disable();
}

// ── 13. Downward Dead Zone Pressure ─────────────────────────────────

console.log('\n── 13. Downward Dead Zone Pressure ──');

resetMocks();
setupDualRowMonitors();
{
    const ext = new TestableMouseWarp();
    ext.enable();

    // The upper row is monitor 0 (TV): x=320..2240, y=0..1080
    // The lower row is monitors 1+2: x=0..5120, y=1080..2520
    // A dead zone going DOWN: cursor at the boundary on the upper row,
    // at an x that's inside upper span but outside lower span.
    // Actually for this layout lower is wider, so there's no dead zone going down.
    // Let's flip: cursor on upper row trying to go down where lower doesn't exist.
    // But lower covers 0..5120 which includes all of upper (320..2240).
    // So the dead zone is only going UP. Let's verify no false positive going down.

    ext._lastMonitorIndex = 0;
    mockGlobal._pointerX = 500;
    mockGlobal._pointerY = 1079; // near boundary, inside upper
    mockMonoTime = 1000000;
    warpedTo = null;
    ext._pressureStartTime = 0;

    ext._onMotion();
    // This point IS inside lower span (0..5120), so it's not a dead zone
    // The extension should NOT start pressure here
    assertEqual(ext._pressureStartTime, 0, 'No pressure in overlap zone (not a dead zone)');

    ext.disable();
}

// ═══════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════

console.log(`\n═══ Extension Logic Tests: ${passed} passed, ${failed} failed ═══\n`);
process.exit(failed > 0 ? 1 : 0);
