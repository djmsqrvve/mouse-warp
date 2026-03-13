#!/bin/bash
# ─────────────────────────────────────────────────────────
# run_tests.sh — Runs the full Mouse Warp test suite.
#
# Usage:  ./tests/run_tests.sh          (from project root)
#     or: docker compose run tests      (from project root)
# ─────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
FAIL=0

echo "╔══════════════════════════════════════════════════════╗"
echo "║        Mouse Warp — Full Test Suite                  ║"
echo "╚══════════════════════════════════════════════════════╝"

run_test() {
    local label="$1"
    local file="$2"
    echo ""
    echo "┌── $label ──"
    if node "$SCRIPT_DIR/$file"; then
        echo "└── $label: PASSED ✔"
    else
        echo "└── $label: FAILED ✘"
        FAIL=1
    fi
}

run_test "Schema Validation"       test_schema.js
run_test "Extension Logic"         test_extension_logic.js
run_test "Metadata & Structure"    test_metadata.js

# ── GSettings schema compilation (Linux only) ──
echo ""
echo "┌── GSettings Schema Compilation ──"
if command -v glib-compile-schemas &> /dev/null; then
    if glib-compile-schemas --strict --dry-run "$PROJECT_DIR/schemas/" 2>&1; then
        echo "  ✔ glib-compile-schemas --strict --dry-run passed"
        echo "└── Schema Compilation: PASSED ✔"
    else
        echo "  ✘ glib-compile-schemas failed"
        echo "└── Schema Compilation: FAILED ✘"
        FAIL=1
    fi
else
    echo "  ⚠ glib-compile-schemas not found, skipping (install libglib2.0-dev)"
    echo "└── Schema Compilation: SKIPPED"
fi

echo ""
echo "══════════════════════════════════════════════════════"
if [ $FAIL -eq 0 ]; then
    echo "  ALL TESTS PASSED ✔"
else
    echo "  SOME TESTS FAILED ✘"
fi
echo "══════════════════════════════════════════════════════"

exit $FAIL
