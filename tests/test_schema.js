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

// ── warp-cooldown-ms key ────────────────────────────────────────────
console.log('\n── Key: warp-cooldown-ms ──');

assert(xml.includes('name="warp-cooldown-ms"'), 'warp-cooldown-ms key exists');
assert(xml.includes('<key name="warp-cooldown-ms" type="i">'), 'warp-cooldown-ms has integer type "i"');

const cooldownBlock = xml.split('name="warp-cooldown-ms"')[1].split('</key>')[0];
const cooldownDefault = cooldownBlock.match(/<default>(\d+)<\/default>/);
assert(cooldownDefault !== null, 'warp-cooldown-ms has a <default> element');
if (cooldownDefault) {
    assertEqual(cooldownDefault[1], '100', 'warp-cooldown-ms default is 100');
}

assert(cooldownBlock.includes('<summary>'), 'warp-cooldown-ms has <summary>');
assert(cooldownBlock.includes('<description>'), 'warp-cooldown-ms has <description>');

// ── overlap-remap-enabled key ──────────────────────────────────────
console.log('\n── Key: overlap-remap-enabled ──');

assert(xml.includes('name="overlap-remap-enabled"'), 'overlap-remap-enabled key exists');
assert(xml.includes('<key name="overlap-remap-enabled" type="b">'), 'overlap-remap-enabled has boolean type "b"');

const overlapBlock = xml.split('name="overlap-remap-enabled"')[1].split('</key>')[0];
assert(overlapBlock.includes('<default>true</default>'), 'overlap-remap-enabled default is true');
assert(overlapBlock.includes('<summary>'), 'overlap-remap-enabled has <summary>');
assert(overlapBlock.includes('<description>'), 'overlap-remap-enabled has <description>');

// ── visual-feedback-enabled key ────────────────────────────────────
console.log('\n── Key: visual-feedback-enabled ──');

assert(xml.includes('name="visual-feedback-enabled"'), 'visual-feedback-enabled key exists');
assert(xml.includes('<key name="visual-feedback-enabled" type="b">'), 'visual-feedback-enabled has boolean type "b"');

const feedbackBlock = xml.split('name="visual-feedback-enabled"')[1].split('</key>')[0];
assert(feedbackBlock.includes('<default>true</default>'), 'visual-feedback-enabled default is true');
assert(feedbackBlock.includes('<summary>'), 'visual-feedback-enabled has <summary>');
assert(feedbackBlock.includes('<description>'), 'visual-feedback-enabled has <description>');

// ── debug-logging key ──────────────────────────────────────────────
console.log('\n── Key: debug-logging ──');

assert(xml.includes('name="debug-logging"'), 'debug-logging key exists');
assert(xml.includes('<key name="debug-logging" type="b">'), 'debug-logging has boolean type "b"');

const loggingBlock = xml.split('name="debug-logging"')[1].split('</key>')[0];
assert(loggingBlock.includes('<default>false</default>'), 'debug-logging default is false');
assert(loggingBlock.includes('<summary>'), 'debug-logging has <summary>');
assert(loggingBlock.includes('<description>'), 'debug-logging has <description>');

// ── hide-top-bar key ────────────────────────────────────────────────
console.log('\n── Key: hide-top-bar ──');

assert(xml.includes('name="hide-top-bar"'), 'hide-top-bar key exists');
assert(xml.includes('<key name="hide-top-bar" type="b">'), 'hide-top-bar has boolean type "b"');

const topBarBlock = xml.split('name="hide-top-bar"')[1].split('</key>')[0];
assert(topBarBlock.includes('<default>false</default>'), 'hide-top-bar default is false');
assert(topBarBlock.includes('<summary>'), 'hide-top-bar has <summary>');
assert(topBarBlock.includes('<description>'), 'hide-top-bar has <description>');

// ── poll-rate-ms key ────────────────────────────────────────────────
console.log('\n── Key: poll-rate-ms ──');

assert(xml.includes('name="poll-rate-ms"'), 'poll-rate-ms key exists');
assert(xml.includes('<key name="poll-rate-ms" type="i">'), 'poll-rate-ms has integer type "i"');

const pollRateBlock = xml.split('name="poll-rate-ms"')[1].split('</key>')[0];
const pollRateDefault = pollRateBlock.match(/<default>(\d+)<\/default>/);
assert(pollRateDefault !== null, 'poll-rate-ms has a <default> element');
if (pollRateDefault) {
    assertEqual(pollRateDefault[1], '8', 'poll-rate-ms default is 8');
}

assert(pollRateBlock.includes('<summary>'), 'poll-rate-ms has <summary>');
assert(pollRateBlock.includes('<description>'), 'poll-rate-ms has <description>');

// ── row-tolerance key ──────────────────────────────────────────────
console.log('\n── Key: row-tolerance ──');

assert(xml.includes('name="row-tolerance"'), 'row-tolerance key exists');
assert(xml.includes('<key name="row-tolerance" type="i">'), 'row-tolerance has integer type "i"');

const rowTolBlock = xml.split('name="row-tolerance"')[1].split('</key>')[0];
const rowTolDefault = rowTolBlock.match(/<default>(\d+)<\/default>/);
assert(rowTolDefault !== null, 'row-tolerance has a <default> element');
if (rowTolDefault) {
    assertEqual(rowTolDefault[1], '5', 'row-tolerance default is 5');
}

assert(rowTolBlock.includes('<summary>'), 'row-tolerance has <summary>');
assert(rowTolBlock.includes('<description>'), 'row-tolerance has <description>');

// ── Key count ───────────────────────────────────────────────────────
console.log('\n── Key Count ──');

const keyCount = (xml.match(/<key /g) || []).length;
assertEqual(keyCount, 14, 'Schema contains exactly 14 keys');

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\n═══ Schema Tests: ${passed} passed, ${failed} failed ═══\n`);
process.exit(failed > 0 ? 1 : 0);
