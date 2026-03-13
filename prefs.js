import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class MouseWarpPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // Create a preferences page and group
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'General Settings',
            description: 'Configure Mouse Warp behavior',
        });
        page.add(group);

        // Get the settings using the built-in helper method from ExtensionPreferences
        const settings = this.getSettings('org.gnome.shell.extensions.mouse-warp');

        // Edge Tolerance Row
        const edgeToleranceRow = new Adw.ActionRow({
            title: 'Edge Tolerance (px)',
            subtitle: 'Distance from the screen edge to trigger the warp',
        });
        const edgeToleranceScale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 1, 50, 1);
        edgeToleranceScale.set_hexpand(true);
        edgeToleranceRow.add_suffix(edgeToleranceScale);
        settings.bind('edge-tolerance', edgeToleranceScale.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(edgeToleranceRow);

        // Pressure Threshold Row
        const pressureThresholdRow = new Adw.ActionRow({
            title: 'Pressure Threshold (ms)',
            subtitle: 'Time cursor must push against the edge before warping',
        });
        const pressureThresholdScale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 1000, 10);
        pressureThresholdScale.set_hexpand(true);
        pressureThresholdRow.add_suffix(pressureThresholdScale);
        settings.bind('pressure-threshold-ms', pressureThresholdScale.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(pressureThresholdRow);

        // Enable Switch Row
        const enableRow = new Adw.ActionRow({
            title: 'Enable Mouse Warp',
            subtitle: 'Temporarily pause the warp functionality',
        });
        const enableSwitch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
        });
        settings.bind('is-enabled', enableSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        enableRow.add_suffix(enableSwitch);
        group.add(enableRow);

        // Add page to the preferences window
        window.add(page);
    }
}
