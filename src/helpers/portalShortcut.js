/**
 * XDG Desktop Portal GlobalShortcuts integration for Linux Wayland.
 *
 * Uses the org.freedesktop.portal.GlobalShortcuts portal API to register
 * global hotkeys with key-down (Activated) and key-up (Deactivated) signals,
 * enabling true push-to-talk on Wayland compositors that support the portal
 * (GNOME 48+, KDE Plasma 5.27+, Hyprland, Sway via xdg-desktop-portal-wlr).
 *
 * Follows the EventEmitter pattern of windowsKeyManager.js so that main.js
 * can wire up events identically.
 */

const { EventEmitter } = require("events");
const debugLogger = require("./debugLogger");
const GnomeShortcutManager = require("./gnomeShortcut");

const PORTAL_BUS_NAME = "org.freedesktop.portal.Desktop";
const PORTAL_OBJECT_PATH = "/org/freedesktop/portal/desktop";
const PORTAL_INTERFACE = "org.freedesktop.portal.GlobalShortcuts";

const SHORTCUT_ID = "dictation-toggle";

let dbus = null;

function getDBus() {
  if (dbus) return dbus;
  try {
    dbus = require("dbus-next");
    return dbus;
  } catch (err) {
    debugLogger.log("[PortalShortcut] Failed to load dbus-next:", err.message);
    return null;
  }
}

class PortalShortcutManager extends EventEmitter {
  constructor() {
    super();
    this.bus = null;
    this.sessionHandle = null;
    this.portalInterface = null;
    this.isReady = false;
    this._requestCounter = 0;
    this._keyIsDown = false;
    this._deactivateTimer = null;
  }

  /**
   * Check whether the GlobalShortcuts portal interface is available on this system.
   * Returns false on pre-GNOME 48, non-portal compositors, or missing xdg-desktop-portal.
   */
  static async checkAvailability() {
    const dbusModule = getDBus();
    if (!dbusModule) return false;

    let bus = null;
    try {
      bus = dbusModule.sessionBus();
      const obj = await bus.getProxyObject(PORTAL_BUS_NAME, PORTAL_OBJECT_PATH);
      const iface = obj.getInterface(PORTAL_INTERFACE);
      // If we got the interface without error, the portal is available
      return !!iface;
    } catch (err) {
      debugLogger.log("[PortalShortcut] Portal not available:", err.message);
      return false;
    } finally {
      if (bus) {
        try {
          bus.disconnect();
        } catch (_) {
          // ignore
        }
      }
    }
  }

  /**
   * Start the portal session and bind a shortcut for the given hotkey.
   * Emits 'ready' on success, 'unavailable' or 'error' on failure.
   */
  async start(hotkey) {
    const dbusModule = getDBus();
    if (!dbusModule) {
      this.emit("unavailable", new Error("dbus-next not available"));
      return;
    }

    try {
      this.bus = dbusModule.sessionBus();

      const obj = await this.bus.getProxyObject(PORTAL_BUS_NAME, PORTAL_OBJECT_PATH);

      try {
        this.portalInterface = obj.getInterface(PORTAL_INTERFACE);
      } catch (err) {
        debugLogger.log("[PortalShortcut] GlobalShortcuts interface not found:", err.message);
        this.emit("unavailable", err);
        this._cleanup();
        return;
      }

      // Create a session.
      // The portal uses an async Request/Response pattern, but dbus-next can't
      // introspect the Request object before it's created. Instead, we predict the
      // session handle from the token (the portal guarantees this naming convention)
      // and call the methods directly.
      const sessionToken = "openwhispr_session";
      const createSessionToken = this._nextToken("create");
      const sender = this.bus.name.slice(1).replace(/\./g, "_"); // ":1.42" → "1_42"

      await this.portalInterface.CreateSession({
        handle_token: new dbusModule.Variant("s", createSessionToken),
        session_handle_token: new dbusModule.Variant("s", sessionToken),
      });

      // Session handle follows the portal naming convention:
      // /org/freedesktop/portal/desktop/session/{sender}/{token}
      this.sessionHandle = `${PORTAL_OBJECT_PATH}/session/${sender}/${sessionToken}`;
      debugLogger.log("[PortalShortcut] Session created:", this.sessionHandle);

      // Small delay to let the portal finish creating the session
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Bind the shortcut
      await this._bindShortcut(hotkey);

      // Listen for Activated / Deactivated signals
      this.portalInterface.on("Activated", this._onActivated.bind(this));
      this.portalInterface.on("Deactivated", this._onDeactivated.bind(this));

      this.isReady = true;
      this.emit("ready");
      debugLogger.log("[PortalShortcut] Ready and listening for shortcuts");
    } catch (err) {
      debugLogger.log("[PortalShortcut] Failed to start:", err.message);
      this.emit("error", err);
      this._cleanup();
    }
  }

  /**
   * Re-bind the shortcut with a new hotkey without recreating the session.
   */
  async updateShortcut(hotkey) {
    if (!this.isReady || !this.sessionHandle) {
      debugLogger.log("[PortalShortcut] Cannot update shortcut — not ready");
      return;
    }

    try {
      await this._bindShortcut(hotkey);
      debugLogger.log(`[PortalShortcut] Shortcut updated to "${hotkey}"`);
    } catch (err) {
      debugLogger.log("[PortalShortcut] Failed to update shortcut:", err.message);
      this.emit("error", err);
    }
  }

  /**
   * Close the portal session and disconnect from D-Bus.
   */
  stop() {
    this._cleanup();
    debugLogger.log("[PortalShortcut] Stopped");
  }

  // --- Private ---

  async _bindShortcut(hotkey) {
    const dbusModule = getDBus();
    const gnomeFormat = GnomeShortcutManager.convertToGnomeFormat(hotkey);
    const bindToken = this._nextToken("bind");

    const shortcuts = [
      [
        SHORTCUT_ID,
        {
          description: new dbusModule.Variant("s", "OpenWhispr Dictation"),
          preferred_trigger: new dbusModule.Variant("s", gnomeFormat),
        },
      ],
    ];

    await this.portalInterface.BindShortcuts(this.sessionHandle, shortcuts, "", {
      handle_token: new dbusModule.Variant("s", bindToken),
    });

    debugLogger.log(`[PortalShortcut] Shortcut bound: "${hotkey}" → "${gnomeFormat}"`);
  }

  _onActivated(_sessionHandle, shortcutId, _timestamp, _options) {
    debugLogger.log(`[PortalShortcut] Activated signal: id="${shortcutId}" keyIsDown=${this._keyIsDown}`);

    if (shortcutId !== SHORTCUT_ID) return;

    // Cancel any pending deactivate — this is a key-repeat, not a new press
    if (this._deactivateTimer) {
      clearTimeout(this._deactivateTimer);
      this._deactivateTimer = null;
    }

    // Only emit on the initial press, not on key-repeat cycles
    if (!this._keyIsDown) {
      this._keyIsDown = true;
      debugLogger.log("[PortalShortcut] Emitting key-down");
      this.emit("key-down", shortcutId);
    }
  }

  _onDeactivated(_sessionHandle, shortcutId, _timestamp, _options) {
    debugLogger.log(`[PortalShortcut] Deactivated signal: id="${shortcutId}" keyIsDown=${this._keyIsDown}`);

    if (shortcutId !== SHORTCUT_ID) return;

    // Debounce: key-repeat generates rapid Deactivated→Activated pairs.
    // Wait a short interval — if Activated fires again, it was just repeat.
    const REPEAT_DEBOUNCE_MS = 150;
    this._deactivateTimer = setTimeout(() => {
      this._deactivateTimer = null;
      if (this._keyIsDown) {
        this._keyIsDown = false;
        debugLogger.log("[PortalShortcut] Emitting key-up (debounced)");
        this.emit("key-up", shortcutId);
      }
    }, REPEAT_DEBOUNCE_MS);
  }

  _nextToken(prefix) {
    this._requestCounter += 1;
    return `openwhispr_${prefix}_${this._requestCounter}`;
  }

  _cleanup() {
    this.isReady = false;
    this._keyIsDown = false;
    if (this._deactivateTimer) {
      clearTimeout(this._deactivateTimer);
      this._deactivateTimer = null;
    }

    if (this.portalInterface) {
      try {
        this.portalInterface.removeAllListeners("Activated");
        this.portalInterface.removeAllListeners("Deactivated");
      } catch (_) {
        // ignore
      }
      this.portalInterface = null;
    }

    if (this.bus) {
      try {
        this.bus.disconnect();
      } catch (_) {
        // ignore
      }
      this.bus = null;
    }

    this.sessionHandle = null;
  }
}

// TODO: For pre-GNOME 48 systems (e.g. Ubuntu 24.04 LTS with GNOME 46) that lack
// the GlobalShortcuts portal, consider implementing an evdev-based fallback:
//
//   1. Create a small native binary (like windows-key-listener.c) that reads from
//      /dev/input/event* devices using the evdev API
//   2. Parse EV_KEY events for the configured hotkey's key-down and key-up
//   3. Emit KEY_DOWN / KEY_UP to stdout (same protocol as windows-key-listener)
//   4. Spawn from Node.js identically to WindowsKeyManager
//
// Prerequisites already in place:
//   - after-install.sh adds users to the `input` group
//   - udev rule for /dev/uinput with MODE="0660" and TAG+="uaccess"
//
// This would provide push-to-talk on any Linux system regardless of compositor,
// at the cost of a native binary to compile and distribute per architecture.

module.exports = PortalShortcutManager;
