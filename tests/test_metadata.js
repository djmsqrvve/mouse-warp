/**
 * test_metadata.js — Validates metadata.json, Makefile consistency, and prefs.js structure.
 *
 * Runs on Node.js (no GNOME dependencies).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

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

// ═════════════════════════════════════════════════════════════════
// metadata.json
// ═════════════════════════════════════════════════════════════════

console.log('\n── metadata.json ──');

const metaPath = path.join(ROOT, 'metadata.json');
assert(fs.existsSync(metaPath), 'metadata.json exists');

const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
assert(typeof meta.uuid === 'string' && meta.uuid.length > 0, 'uuid is a non-empty string');
assert(meta.uuid.includes('@'), 'uuid contains @ separator');
assert(typeof meta.name === 'string', 'name field exists');
assert(typeof meta.description === 'string', 'description field exists');
assert(Array.isArray(meta['shell-version']), 'shell-version is an array');
assert(meta['shell-version'].length > 0, 'shell-version has at least one entry');
assert(typeof meta.version === 'number', 'version is a number');

// ═════════════════════════════════════════════════════════════════
// Makefile
// ═════════════════════════════════════════════════════════════════

console.log('\n── Makefile ──');

const makefilePath = path.join(ROOT, 'Makefile');
assert(fs.existsSync(makefilePath), 'Makefile exists');

const makefile = fs.readFileSync(makefilePath, 'utf-8');

// UUID must match metadata.json
const uuidMatch = makefile.match(/^UUID\s*=\s*(.+)$/m);
assert(uuidMatch !== null, 'UUID variable defined in Makefile');
if (uuidMatch) {
    assertEqual(uuidMatch[1].trim(), meta.uuid, 'Makefile UUID matches metadata.json uuid');
}

// SOURCES must include key files
assert(makefile.includes('extension.js'), 'SOURCES includes extension.js');
assert(makefile.includes('metadata.json'), 'SOURCES includes metadata.json');
assert(makefile.includes('prefs.js'), 'SOURCES includes prefs.js');
assert(makefile.includes('schemas'), 'SOURCES includes schemas directory');

// Schema compilation
assert(makefile.includes('glib-compile-schemas'), 'Makefile calls glib-compile-schemas');
assert(makefile.includes('compile-schemas'), 'Makefile has compile-schemas target');

// cp -r for directories
assert(makefile.includes('cp -r'), 'Makefile uses cp -r to copy directories (schemas)');

// ═════════════════════════════════════════════════════════════════
// prefs.js structure
// ═════════════════════════════════════════════════════════════════

console.log('\n── prefs.js ──');

const prefsPath = path.join(ROOT, 'prefs.js');
assert(fs.existsSync(prefsPath), 'prefs.js exists');

const prefs = fs.readFileSync(prefsPath, 'utf-8');

// Imports
assert(prefs.includes("gi://Adw"), 'Imports Adw (libadwaita)');
assert(prefs.includes("gi://Gtk"), 'Imports Gtk');
assert(prefs.includes("gi://Gio"), 'Imports Gio');
assert(prefs.includes('ExtensionPreferences'), 'Imports ExtensionPreferences base class');

// Class structure
assert(prefs.includes('export default class'), 'Has default export class');
assert(prefs.includes('fillPreferencesWindow'), 'Implements fillPreferencesWindow method');

// Settings binding — checks that schema ID is correct
assert(
    prefs.includes("org.gnome.shell.extensions.mouse-warp"),
    'Uses correct GSettings schema ID'
);

// UI components
assert(prefs.includes('Adw.PreferencesPage'), 'Creates an Adw.PreferencesPage');
assert(prefs.includes('Adw.PreferencesGroup'), 'Creates an Adw.PreferencesGroup');
assert(prefs.includes('Adw.ActionRow'), 'Creates Adw.ActionRow elements');
assert(prefs.includes('Gtk.Scale'), 'Creates Gtk.Scale sliders');
assert(prefs.includes('Gtk.Switch'), 'Creates a Gtk.Switch toggle');

// Bindings to settings keys
assert(prefs.includes("'edge-tolerance'"), 'Binds edge-tolerance setting');
assert(prefs.includes("'pressure-threshold-ms'"), 'Binds pressure-threshold-ms setting');
assert(prefs.includes("'is-enabled'"), 'Binds is-enabled setting');

// ═════════════════════════════════════════════════════════════════
// extension.js structure checks
// ═════════════════════════════════════════════════════════════════

console.log('\n── extension.js Structure ──');

const extPath = path.join(ROOT, 'extension.js');
assert(fs.existsSync(extPath), 'extension.js exists');

const ext = fs.readFileSync(extPath, 'utf-8');

// No hardcoded constants
assert(!ext.includes('const EDGE_TOLERANCE'), 'No hardcoded EDGE_TOLERANCE constant');
assert(!ext.includes('const PRESSURE_THRESHOLD'), 'No hardcoded PRESSURE_THRESHOLD constant');

// GSettings integration
assert(ext.includes('getSettings'), 'Uses getSettings() for GSettings');
assert(ext.includes('get_int'), 'Reads integer settings with get_int()');
assert(ext.includes('get_boolean'), 'Reads boolean settings with get_boolean()');

// Time-based pressure
assert(ext.includes('get_monotonic_time'), 'Uses GLib.get_monotonic_time() for timing');
assert(ext.includes('_pressureStartTime'), 'Uses _pressureStartTime field');
assert(!ext.includes('_edgePressure++'), 'No frame-based _edgePressure++ counter');

// Error handling (tray icon removed for stability — crash-prone on some GNOME versions)
assert(ext.includes('try'), 'Has try/catch error handling');
assert(ext.includes('catch'), 'Has catch blocks for crash prevention');
assert(ext.includes('log('), 'Logs errors instead of crashing');

// Visual feedback
assert(ext.includes('_showVisualFeedback'), 'Has _showVisualFeedback method');
assert(ext.includes('St.Widget'), 'Creates St.Widget for visual effect');
assert(ext.includes('.ease('), 'Uses Clutter ease() animation');
assert(ext.includes('onComplete'), 'Has animation completion callback');

// Enable guard
assert(
    ext.includes('if (!this._isEnabled) {') &&
    ext.includes('this._resetMotionState();'),
    'Has disabled-path guard in _onMotion and resets motion state'
);

// Single monitor bypass
assert(
    ext.includes('monitors.length < 2'),
    'Has single-monitor bypass guard (monitors.length < 2)'
);

// Click flash
assert(ext.includes('_onButtonPress'), 'Has _onButtonPress method');

// Overlay and debug label
assert(ext.includes('_updateOverlay'), 'Has _updateOverlay method');
assert(ext.includes('_destroyOverlay'), 'Has _destroyOverlay method');
assert(ext.includes('_updateDebugLabel'), 'Has _updateDebugLabel method');
assert(ext.includes('_destroyDebugLabel'), 'Has _destroyDebugLabel method');

// Top bar control
assert(ext.includes('_applyTopBar'), 'Has _applyTopBar method');
assert(ext.includes('_restoreTopBar'), 'Has _restoreTopBar method');

// Monitors-changed signal
assert(ext.includes('monitors-changed'), 'Connects to monitors-changed signal');

// Polling architecture
assert(ext.includes('_startPolling'), 'Has _startPolling method');
assert(ext.includes('_restartPolling'), 'Has _restartPolling method');
assert(ext.includes('_onPoll'), 'Has _onPoll method');
assert(ext.includes('GLib.timeout_add'), 'Uses GLib.timeout_add for polling');

// Warp cooldown
assert(ext.includes('_warpCooldownUntil'), 'Tracks warp cooldown');
assert(ext.includes('warp_pointer'), 'Calls Clutter warp_pointer');

// Gap-safe snapping
assert(ext.includes('_snapToMonitors'), 'Has _snapToMonitors method for gap-safe warping');
assert(ext.includes('targetMonitors'), 'Dead zone returns targetMonitors for snap validation');

// Source validation
assert(ext.includes('_isOnMonitor'), 'Has _isOnMonitor method for gap-aware source validation');

// Zero-width guard
assert(ext.includes('width <= 0'), 'Guards against zero-width rows');

// ═════════════════════════════════════════════════════════════════
// Files that should exist
// ═════════════════════════════════════════════════════════════════

console.log('\n── File Presence ──');

const requiredFiles = [
    'extension.js',
    'metadata.json',
    'prefs.js',
    'Makefile',
    'README.md',
    'schemas/org.gnome.shell.extensions.mouse-warp.gschema.xml',
];

for (const f of requiredFiles) {
    assert(fs.existsSync(path.join(ROOT, f)), `Required file exists: ${f}`);
}

// ═════════════════════════════════════════════════════════════════
console.log(`\n═══ Metadata & Structure Tests: ${passed} passed, ${failed} failed ═══\n`);
process.exit(failed > 0 ? 1 : 0);
