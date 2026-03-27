import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class MouseWarpPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage();
        const settings = this.getSettings('org.gnome.shell.extensions.mouse-warp');

        // ── General Settings ──
        const group = new Adw.PreferencesGroup({
            title: 'General Settings',
            description: 'Configure Mouse Warp behavior',
        });
        page.add(group);

        // Edge Tolerance
        const edgeToleranceRow = new Adw.ActionRow({
            title: 'Edge Tolerance (px)',
            subtitle: 'Distance from the screen edge to trigger the warp',
        });
        const edgeToleranceScale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 1, 50, 1);
        edgeToleranceScale.set_hexpand(true);
        edgeToleranceRow.add_suffix(edgeToleranceScale);
        settings.bind('edge-tolerance', edgeToleranceScale.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(edgeToleranceRow);

        // Pressure Threshold
        const pressureThresholdRow = new Adw.ActionRow({
            title: 'Pressure Threshold (ms)',
            subtitle: 'Time cursor must push against the edge before warping',
        });
        const pressureThresholdScale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 1000, 10);
        pressureThresholdScale.set_hexpand(true);
        pressureThresholdRow.add_suffix(pressureThresholdScale);
        settings.bind('pressure-threshold-ms', pressureThresholdScale.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(pressureThresholdRow);

        // Master Enable
        const enableRow = new Adw.ActionRow({
            title: 'Enable Mouse Warp',
            subtitle: 'Master toggle for all functionality',
        });
        const enableSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('is-enabled', enableSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        enableRow.add_suffix(enableSwitch);
        group.add(enableRow);

        // ── Debug Tools ──
        const debugGroup = new Adw.PreferencesGroup({
            title: 'Debug Tools',
            description: 'Visual debugging aids for multi-monitor testing',
        });
        page.add(debugGroup);

        // Warp Enabled
        const warpRow = new Adw.ActionRow({
            title: 'Warp Enabled',
            subtitle: 'Enable proportional cursor warping (disable to isolate debug visuals)',
        });
        const warpSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('warp-enabled', warpSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        warpRow.add_suffix(warpSwitch);
        debugGroup.add(warpRow);

        // Cursor Overlay
        const overlayRow = new Adw.ActionRow({
            title: 'Cursor Overlay',
            subtitle: 'Show a colored circle at the cursor — color changes per monitor',
        });
        const overlaySwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('overlay-enabled', overlaySwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        overlayRow.add_suffix(overlaySwitch);
        debugGroup.add(overlayRow);

        // Click Flash
        const clickFlashRow = new Adw.ActionRow({
            title: 'Click Flash',
            subtitle: 'Flash a dot at the true click position',
        });
        const clickFlashSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('click-flash-enabled', clickFlashSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        clickFlashRow.add_suffix(clickFlashSwitch);
        debugGroup.add(clickFlashRow);

        window.add(page);
    }
}
