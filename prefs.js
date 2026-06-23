// Mastodon Notifications — preferences
// GNOME 50 / libadwaita 1.6+

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import {ExtensionPreferences, gettext as _}
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

export default class MastodonPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.mastodon-notifications');

        // ── Page ─────────────────────────────────────────────────────────
        const page = new Adw.PreferencesPage({
            title: _('Mastodon Notifications'),
            icon_name: 'notification-symbolic',
        });
        window.add(page);

        // ── Account group ─────────────────────────────────────────────────
        const accountGroup = new Adw.PreferencesGroup({
            title: _('Account'),
            description: _(
                'Create an access token on your instance at ' +
                'Settings → Development → New Application. ' +
                'Enable the read:notifications scope.'
            ),
        });
        page.add(accountGroup);

        // Instance URL — save on every keystroke via notify::text
        const instanceRow = new Adw.EntryRow({
            title: _('Instance URL'),
            text: settings.get_string('instance-url'),
            input_purpose: Gtk.InputPurpose.URL,
        });
        instanceRow.connect('notify::text', row => {
            let url = row.get_text().trim().replace(/\/+$/, '');
            if (url && !url.startsWith('http'))
                url = `https://${url}`;
            settings.set_string('instance-url', url);
        });
        accountGroup.add(instanceRow);

        // Access token — save on every keystroke via notify::text
        const tokenRow = new Adw.PasswordEntryRow({
            title: _('Access Token'),
            text: settings.get_string('access-token'),
        });
        tokenRow.connect('notify::text', row => {
            settings.set_string('access-token', row.get_text().trim());
        });
        accountGroup.add(tokenRow);

        // ── Test connection button ────────────────────────────────────────
        const testGroup = new Adw.PreferencesGroup();
        page.add(testGroup);

        const testRow = new Adw.ActionRow({
            title: _('Test Connection'),
            subtitle: _('Verify your instance URL and token are correct'),
            activatable: true,
        });
        const testSpinner = new Gtk.Spinner({valign: Gtk.Align.CENTER});
        const testIcon    = new Gtk.Image({
            icon_name: 'go-next-symbolic',
            valign: Gtk.Align.CENTER,
        });
        testRow.add_suffix(testSpinner);
        testRow.add_suffix(testIcon);
        testRow.connect('activated', () => {
            this._testConnection(settings, testRow, testSpinner, testIcon);
        });
        testGroup.add(testRow);

        // ── Polling group ─────────────────────────────────────────────────
        const pollGroup = new Adw.PreferencesGroup({
            title: _('Polling'),
        });
        page.add(pollGroup);

        const pollRow = new Adw.SpinRow({
            title: _('Poll Interval'),
            subtitle: _('How often to check for new notifications'),
            adjustment: new Gtk.Adjustment({
                lower: 30,
                upper: 3600,
                step_increment: 30,
                page_increment: 60,
                value: settings.get_int('poll-interval'),
            }),
        });
        pollRow.connect('notify::value', row => {
            settings.set_int('poll-interval', row.get_value());
        });
        pollGroup.add(pollRow);

        const pollSuffix = new Gtk.Label({
            label: _('seconds'),
            valign: Gtk.Align.CENTER,
            css_classes: ['dim-label'],
        });
        pollRow.add_suffix(pollSuffix);
    }

    // ── Test connection ───────────────────────────────────────────────────

    async _testConnection(settings, row, spinner, icon) {
        const base  = settings.get_string('instance-url').replace(/\/+$/, '');
        const token = settings.get_string('access-token');

        if (!base || !token) {
            row.set_subtitle(_('Enter instance URL and access token first'));
            return;
        }

        spinner.start();
        icon.set_visible(false);
        row.set_subtitle(_('Connecting…'));

        try {
            const session = new Soup.Session();
            const msg = Soup.Message.new('GET', `${base}/api/v1/accounts/verify_credentials`);
            msg.request_headers.append('Authorization', `Bearer ${token}`);
            const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);

            const status = msg.get_status();
            if (status === 200) {
                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                row.set_subtitle(`✓ Connected as @${data.acct}`);
            } else if (status === 401) {
                row.set_subtitle(_('✗ Invalid token (401 Unauthorized)'));
            } else {
                row.set_subtitle(`✗ HTTP ${status}`);
            }
        } catch (e) {
            row.set_subtitle(`✗ ${e.message}`);
        } finally {
            spinner.stop();
            icon.set_visible(true);
        }
    }
}
