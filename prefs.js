import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class MouseWarpPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage();
        const settings = this.getSettings('org.gnome.shell.extensions.dj-mouse-warp');

        // ── Warp Settings ──
        const warpGroup = new Adw.PreferencesGroup({
            title: 'Warp Settings',
            description: 'Configure how cursor warping behaves between monitors',
        });
        page.add(warpGroup);

        // Master Enable
        const enableRow = new Adw.ActionRow({
            title: 'Enable Mouse Warp',
            subtitle: 'Master toggle for all functionality',
        });
        const enableSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('is-enabled', enableSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        enableRow.add_suffix(enableSwitch);
        warpGroup.add(enableRow);

        // Overlap Remap
        const overlapRow = new Adw.ActionRow({
            title: 'Overlap Remap',
            subtitle: 'Proportionally remap x-coordinate when crossing between monitor rows',
        });
        const overlapSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('overlap-remap-enabled', overlapSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        overlapRow.add_suffix(overlapSwitch);
        warpGroup.add(overlapRow);

        // Dead Zone Warp
        const warpRow = new Adw.ActionRow({
            title: 'Dead Zone Warp',
            subtitle: 'Warp cursor across dead zones after pressure threshold',
        });
        const warpSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('warp-enabled', warpSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        warpRow.add_suffix(warpSwitch);
        warpGroup.add(warpRow);

        // Edge Tolerance
        const edgeToleranceRow = new Adw.ActionRow({
            title: 'Edge Tolerance (px)',
            subtitle: 'Distance from screen edge that triggers dead-zone detection',
        });
        const edgeToleranceScale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 1, 50, 1);
        edgeToleranceScale.set_hexpand(true);
        edgeToleranceRow.add_suffix(edgeToleranceScale);
        settings.bind('edge-tolerance', edgeToleranceScale.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
        warpGroup.add(edgeToleranceRow);

        // Pressure Threshold
        const pressureThresholdRow = new Adw.ActionRow({
            title: 'Pressure Threshold (ms)',
            subtitle: 'Time cursor must push against edge before dead-zone warp',
        });
        const pressureThresholdScale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 1000, 10);
        pressureThresholdScale.set_hexpand(true);
        pressureThresholdRow.add_suffix(pressureThresholdScale);
        settings.bind('pressure-threshold-ms', pressureThresholdScale.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
        warpGroup.add(pressureThresholdRow);

        // Warp Cooldown
        const cooldownRow = new Adw.ActionRow({
            title: 'Warp Cooldown (ms)',
            subtitle: 'Delay after a warp before another can trigger',
        });
        const cooldownScale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 20, 500, 10);
        cooldownScale.set_hexpand(true);
        cooldownRow.add_suffix(cooldownScale);
        settings.bind('warp-cooldown-ms', cooldownScale.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
        warpGroup.add(cooldownRow);

        // Hide Top Bar
        const topBarRow = new Adw.ActionRow({
            title: 'Hide Top Bar',
            subtitle: 'Hide the GNOME panel — reclaims space and fixes top-edge hitbox issues',
        });
        const topBarSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('hide-top-bar', topBarSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        topBarRow.add_suffix(topBarSwitch);
        warpGroup.add(topBarRow);

        // ── Visual Feedback ──
        const visualGroup = new Adw.PreferencesGroup({
            title: 'Visual Feedback',
            description: 'Visual indicators for cursor warping and positioning',
        });
        page.add(visualGroup);

        // Warp Indicator
        const feedbackRow = new Adw.ActionRow({
            title: 'Warp Indicator',
            subtitle: 'Show a blue glow at the warp destination',
        });
        const feedbackSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('visual-feedback-enabled', feedbackSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        feedbackRow.add_suffix(feedbackSwitch);
        visualGroup.add(feedbackRow);

        // Cursor Overlay
        const overlayRow = new Adw.ActionRow({
            title: 'Cursor Overlay',
            subtitle: 'Show a colored circle at the cursor — color changes per monitor',
        });
        const overlaySwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('overlay-enabled', overlaySwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        overlayRow.add_suffix(overlaySwitch);
        visualGroup.add(overlayRow);

        // Click Flash
        const clickFlashRow = new Adw.ActionRow({
            title: 'Click Flash',
            subtitle: 'Flash a dot at the true click position',
        });
        const clickFlashSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('click-flash-enabled', clickFlashSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        clickFlashRow.add_suffix(clickFlashSwitch);
        visualGroup.add(clickFlashRow);

        // ── Debug ──
        const debugGroup = new Adw.PreferencesGroup({
            title: 'Debug',
            description: 'Diagnostic tools for troubleshooting',
        });
        page.add(debugGroup);

        // Debug Logging
        const loggingRow = new Adw.ActionRow({
            title: 'Debug Logging',
            subtitle: 'Log warp events to the GNOME Shell journal',
        });
        const loggingSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('debug-logging', loggingSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        loggingRow.add_suffix(loggingSwitch);
        debugGroup.add(loggingRow);

        // Poll Rate
        const pollRateRow = new Adw.ActionRow({
            title: 'Poll Rate (ms)',
            subtitle: 'Cursor position polling interval — lower is more responsive (default 8ms)',
        });
        const pollRateScale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 4, 50, 1);
        pollRateScale.set_hexpand(true);
        pollRateRow.add_suffix(pollRateScale);
        settings.bind('poll-rate-ms', pollRateScale.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
        debugGroup.add(pollRateRow);

        // Row Tolerance
        const rowToleranceRow = new Adw.ActionRow({
            title: 'Row Tolerance (px)',
            subtitle: 'Y-offset threshold for grouping monitors into the same row (default 5px)',
        });
        const rowToleranceScale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 1, 50, 1);
        rowToleranceScale.set_hexpand(true);
        rowToleranceRow.add_suffix(rowToleranceScale);
        settings.bind('row-tolerance', rowToleranceScale.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
        debugGroup.add(rowToleranceRow);

        window.add(page);
    }
}
