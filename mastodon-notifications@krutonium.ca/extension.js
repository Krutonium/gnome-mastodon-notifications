// Mastodon Notifications — GNOME 50 extension
// UUID: mastodon-notifications@krutonium.ca

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Promisify Soup async methods so we can use async/await cleanly
Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

// ─── Panel indicator ────────────────────────────────────────────────────────

const MastodonIndicator = GObject.registerClass(
class MastodonIndicator extends PanelMenu.Button {

    _init(extension) {
        super._init(0.0, 'Mastodon Notifications', false);

        this._ext      = extension;
        this._settings = extension.getSettings('org.gnome.shell.extensions.mastodon-notifications');
        this._session  = new Soup.Session();
        this._timeoutId = null;
        this._cancellable = new Gio.Cancellable();

        // ── Panel widget ──────────────────────────────────────────────────
        const box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });

        this._icon = new St.Icon({
            icon_name: 'notification-symbolic',
            style_class: 'system-status-icon',
        });

        this._countLabel = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'mastodon-count-label',
        });

        box.add_child(this._icon);
        box.add_child(this._countLabel);
        this.add_child(box);

        // ── Dropdown menu ─────────────────────────────────────────────────
        this._statusItem = new PopupMenu.PopupMenuItem('Loading…', {reactive: false});
        this.menu.addMenuItem(this._statusItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const openItem = new PopupMenu.PopupMenuItem(_('Open Notifications'));
        openItem.connect('activate', () => this._openBrowser());
        this.menu.addMenuItem(openItem);

        const markReadItem = new PopupMenu.PopupMenuItem(_('Mark All as Read'));
        markReadItem.connect('activate', () => this._markAllRead());
        this.menu.addMenuItem(markReadItem);

        const refreshItem = new PopupMenu.PopupMenuItem(_('Refresh Now'));
        refreshItem.connect('activate', () => this._refresh());
        this.menu.addMenuItem(refreshItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const prefsItem = new PopupMenu.PopupMenuItem(_('Preferences…'));
        prefsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(prefsItem);

        // ── Watch settings changes ────────────────────────────────────────
        this._settingsChangedId = this._settings.connect('changed', () => {
            this._resetPolling();
        });

        this._resetPolling();
    }

    // ── Polling management ────────────────────────────────────────────────

    _resetPolling() {
        // Cancel any in-flight request
        this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();

        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        const instance = this._settings.get_string('instance-url');
        const token    = this._settings.get_string('access-token');

        if (!instance || !token) {
            this._setUnconfigured();
            return;
        }

        this._refresh();

        const interval = Math.max(30, this._settings.get_int('poll-interval'));
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, interval, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    // ── API helpers ───────────────────────────────────────────────────────

    async _get(path) {
        const base  = this._settings.get_string('instance-url').replace(/\/+$/, '');
        const token = this._settings.get_string('access-token');
        const msg   = Soup.Message.new('GET', `${base}${path}`);
        msg.request_headers.append('Authorization', `Bearer ${token}`);
        const bytes = await this._session.send_and_read_async(
            msg, GLib.PRIORITY_DEFAULT, this._cancellable
        );
        return {status: msg.get_status(), body: JSON.parse(new TextDecoder().decode(bytes.get_data()))};
    }

    async _post(path, formBody) {
        const base  = this._settings.get_string('instance-url').replace(/\/+$/, '');
        const token = this._settings.get_string('access-token');
        const msg   = Soup.Message.new('POST', `${base}${path}`);
        msg.request_headers.append('Authorization', `Bearer ${token}`);
        const bodyBytes = GLib.Bytes.new(new TextEncoder().encode(formBody));
        msg.set_request_body_from_bytes('application/x-www-form-urlencoded', bodyBytes);
        await this._session.send_and_read_async(
            msg, GLib.PRIORITY_DEFAULT, this._cancellable
        );
        return msg.get_status();
    }

    // ── Refresh (fetch unread count) ──────────────────────────────────────

    async _refresh() {
        const instance = this._settings.get_string('instance-url');
        const token    = this._settings.get_string('access-token');
        if (!instance || !token) { this._setUnconfigured(); return; }

        try {
            // Mastodon 4.3+ has a dedicated unread_count endpoint that uses
            // the same server-side read marker as the web UI — prefer it.
            const {status, body} = await this._get('/api/v1/notifications/unread_count');

            let count;
            if (status === 200) {
                count = body.count ?? 0;
            } else if (status === 404) {
                // Older instance — fall back to counting via markers
                count = await this._legacyUnreadCount();
                if (count === null) return;
            } else {
                this._setError(`HTTP ${status}`);
                return;
            }

            this._showCount(count);

        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                this._setError(e.message);
        }
    }

    // Fallback for Mastodon < 4.3: markers API + since_id
    async _legacyUnreadCount() {
        try {
            let sinceId = null;
            const {status: ms, body: mBody} =
                await this._get('/api/v1/markers?timeline[]=notifications');
            if (ms === 200 && mBody?.notifications?.last_read_id)
                sinceId = mBody.notifications.last_read_id;

            if (!sinceId) return 0; // no marker set = assume all read

            const {status, body} =
                await this._get(`/api/v1/notifications?since_id=${sinceId}&limit=50`);
            if (status !== 200) { this._setError(`HTTP ${status}`); return null; }
            return body.length;
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                this._setError(e.message);
            return null;
        }
    }

    _showCount(count) {
        if (count === 0) {
            this._countLabel.set_text('');
            this._icon.set_style('opacity: 0.55;');
            this._statusItem.label.set_text(_('No unread notifications'));
        } else {
            this._countLabel.set_text(` ${count}`);
            this._icon.set_style('');
            const noun = count === 1 ? 'notification' : 'notifications';
            this._statusItem.label.set_text(`${count} unread ${noun}`);
        }
    }

    // ── Mark all read via markers API ─────────────────────────────────────

    async _markAllRead() {
        try {
            // Get the most recent notification ID
            const {status, body} = await this._get('/api/v1/notifications?limit=1');
            if (status !== 200 || !body?.length) return;

            const latestId = body[0].id;
            await this._post(
                '/api/v1/markers',
                `notifications[last_read_id]=${encodeURIComponent(latestId)}`
            );

            await this._refresh();
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error('[mastodon-notifications] markAllRead error:', e);
        }
    }

    // ── Open browser ──────────────────────────────────────────────────────

    _openBrowser() {
        const base = this._settings.get_string('instance-url').replace(/\/+$/, '');
        if (base)
            Gio.AppInfo.launch_default_for_uri(`${base}/notifications`, null);
        this.menu.close();
    }

    // ── UI state helpers ──────────────────────────────────────────────────

    _setUnconfigured() {
        this._countLabel.set_text('?');
        this._icon.set_style('');
        this._statusItem.label.set_text(_('Set instance URL and access token in Preferences'));
    }

    _setError(msg) {
        this._countLabel.set_text('!');
        this._icon.set_style('');
        this._statusItem.label.set_text(`Error: ${msg}`);
        console.error('[mastodon-notifications]', msg);
    }

    // ── Cleanup ───────────────────────────────────────────────────────────

    destroy() {
        this._cancellable.cancel();
        this._session.abort();

        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        super.destroy();
    }
});

// ─── Extension entry point ───────────────────────────────────────────────────

export default class MastodonNotificationsExtension extends Extension {
    enable() {
        this._indicator = new MastodonIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
