/**
 * test_schema.js — Validates the GSettings XML schema structure and defaults.
 *
 * Runs on Node.js (no GNOME dependencies).
 * Uses built-in 'fs' to read the XML and simple string assertions.
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.resolve(__dirname, '..', 'schemas', 'org.gnome.shell.extensions.mouse-warp.gschema.xml');

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
    assert(actual === expected, `${message} — expected "${expected}", got "${actual}"`);
}

// ── Schema file existence ───────────────────────────────────────────
console.log('\n── Schema File Tests ──');

assert(fs.existsSync(SCHEMA_PATH), 'Schema file exists on disk');

const xml = fs.readFileSync(SCHEMA_PATH, 'utf-8');

// ── Well-formedness ─────────────────────────────────────────────────
console.log('\n── Schema Well-Formedness ──');

assert(xml.includes('<?xml'), 'Has XML declaration');
assert(xml.includes('<schemalist>'), 'Has <schemalist> root element');
assert(xml.includes('</schemalist>'), 'Has closing </schemalist>');
assert(xml.includes('<schema '), 'Has <schema> element');
assert(xml.includes('</schema>'), 'Has closing </schema>');

// ── Schema ID and path ──────────────────────────────────────────────
console.log('\n── Schema Identity ──');

assert(
    xml.includes('id="org.gnome.shell.extensions.mouse-warp"'),
    'Schema ID is "org.gnome.shell.extensions.mouse-warp"'
);
assert(
    xml.includes('path="/org/gnome/shell/extensions/mouse-warp/"'),
    'Schema path matches GNOME convention'
);

// ── edge-tolerance key ──────────────────────────────────────────────
console.log('\n── Key: edge-tolerance ──');

assert(xml.includes('name="edge-tolerance"'), 'edge-tolerance key exists');
assert(xml.includes('<key name="edge-tolerance" type="i">'), 'edge-tolerance has integer type "i"');

// Extract the default value for edge-tolerance
const edgeToleranceBlock = xml.split('name="edge-tolerance"')[1].split('</key>')[0];
const edgeDefault = edgeToleranceBlock.match(/<default>(\d+)<\/default>/);
assert(edgeDefault !== null, 'edge-tolerance has a <default> element');
if (edgeDefault) {
    assertEqual(edgeDefault[1], '2', 'edge-tolerance default is 2');
}

assert(edgeToleranceBlock.includes('<summary>'), 'edge-tolerance has <summary>');
assert(edgeToleranceBlock.includes('<description>'), 'edge-tolerance has <description>');

// ── pressure-threshold-ms key ───────────────────────────────────────
console.log('\n── Key: pressure-threshold-ms ──');

assert(xml.includes('name="pressure-threshold-ms"'), 'pressure-threshold-ms key exists');
assert(xml.includes('<key name="pressure-threshold-ms" type="i">'), 'pressure-threshold-ms has integer type "i"');

const pressureBlock = xml.split('name="pressure-threshold-ms"')[1].split('</key>')[0];
const pressureDefault = pressureBlock.match(/<default>(\d+)<\/default>/);
assert(pressureDefault !== null, 'pressure-threshold-ms has a <default> element');
if (pressureDefault) {
    assertEqual(pressureDefault[1], '150', 'pressure-threshold-ms default is 150');
}

assert(pressureBlock.includes('<summary>'), 'pressure-threshold-ms has <summary>');
assert(pressureBlock.includes('<description>'), 'pressure-threshold-ms has <description>');

// ── is-enabled key ──────────────────────────────────────────────────
console.log('\n── Key: is-enabled ──');

assert(xml.includes('name="is-enabled"'), 'is-enabled key exists');
assert(xml.includes('<key name="is-enabled" type="b">'), 'is-enabled has boolean type "b"');

const enabledBlock = xml.split('name="is-enabled"')[1].split('</key>')[0];
assert(enabledBlock.includes('<default>true</default>'), 'is-enabled default is true');
assert(enabledBlock.includes('<summary>'), 'is-enabled has <summary>');
assert(enabledBlock.includes('<description>'), 'is-enabled has <description>');

// ── Exactly 3 keys ──────────────────────────────────────────────────
console.log('\n── Key Count ──');

const keyCount = (xml.match(/<key /g) || []).length;
assertEqual(keyCount, 3, 'Schema contains exactly 3 keys');

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\n═══ Schema Tests: ${passed} passed, ${failed} failed ═══\n`);
process.exit(failed > 0 ? 1 : 0);
