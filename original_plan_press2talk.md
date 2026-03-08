# Linux Wayland Push-to-Talk via XDG Desktop Portal GlobalShortcuts

## Context

On GNOME Wayland, OpenWhispr currently uses a gsettings/dbus-send hack (`gnomeShortcut.js`) for global hotkeys. This only fires a single `Toggle()` event — no key-down/key-up distinction — so push-to-talk is disabled and tap mode is forced.

The XDG Desktop Portal GlobalShortcuts API (available since `xdg-desktop-portal-gnome 48`, shipped in Ubuntu 25.10 with GNOME 49) provides `Activated` and `Deactivated` signals that map directly to key-down/key-up. This enables true push-to-talk on Wayland without a native binary.

**Scope:** Ubuntu 25.10+ (GNOME 48+). Comment placeholders for evdev fallback on older systems — not implemented now.

**Branch:** `feat/linux-wayland-push-to-talk`

---

## Files to Create

### 1. `src/helpers/portalShortcut.js` — New file

XDG Desktop Portal GlobalShortcuts client using `dbus-next`. Follows the `EventEmitter` pattern of `windowsKeyManager.js`.

**Events:** `key-down`, `key-up`, `ready`, `error`, `unavailable`

**Core flow:**
1. Connect to session bus, get proxy for `org.freedesktop.portal.Desktop`
2. Get `org.freedesktop.portal.GlobalShortcuts` interface
3. `CreateSession()` → handle portal Request/Response pattern → get session handle
4. `BindShortcuts(session, [{id, preferred_trigger}])` → register the hotkey
5. Listen for `Activated` signal → emit `key-down`
6. Listen for `Deactivated` signal → emit `key-up`

**Key details:**
- Reuse `GnomeShortcutManager.convertToGnomeFormat()` for the `preferred_trigger` format (same X keysym syntax)
- Portal Request/Response pattern: sender `:1.42` → path token `_1_42`, listen for `Response` signal on request path
- `updateShortcut(hotkey)` — re-bind without recreating session
- `stop()` — close session, disconnect bus
- Static `checkAvailability()` — introspect portal interface, return false if GlobalShortcuts not present
- Include TODO comment block for evdev fallback on pre-GNOME 48 systems

---

## Files to Modify

### 2. `src/helpers/hotkeyManager.js`

**In `initializeHotkey()` (line 352):** Try portal BEFORE the existing GNOME gsettings path.

```
if (linux && wayland) {
  portalOk = await initializePortalShortcuts()   ← NEW: try portal first
  if (portalOk) { register portal hotkey; return }
  gnomeOk = await initializeGnomeShortcuts()     ← existing fallback
  if (gnomeOk) { register gsettings hotkey; return }
}
```

**New method:** `initializePortalShortcuts()` — create `PortalShortcutManager`, check availability, set `this.usePortal = true`

**New accessors:** `isUsingPortal()`, expose `portalManager` for main.js wiring

**In `updateHotkey()`:** Add portal branch before the GNOME branch — call `portalManager.updateShortcut()`

**In `unregisterAll()`:** Clean up portal manager

### 3. `main.js` — Wire up portal events (after Windows PTT block, ~line 913)

New block mirroring the Windows PTT pattern (lines 817-913):

```javascript
if (linux && wayland && hotkeyManager.isUsingPortal()) {
  portalManager.on("key-down", () => {
    if (push) windowManager.startLinuxPushToTalk()
    else windowManager.sendToggleDictation()
  })
  portalManager.on("key-up", () => {
    if (push) windowManager.handleLinuxPushKeyUp()
  })
  portalManager.on("error", ...)
  portalManager.on("ready", ...)

  // Start with delay after app ready
  setTimeout(() => portalManager.start(currentHotkey), 2000)

  // Listen for hotkey/mode changes
  ipcMain.on("hotkey-changed", ...) → portalManager.updateShortcut()
  ipcMain.on("activation-mode-changed", ...) → resetLinuxPushState()
}
```

**In `will-quit`:** Stop portal manager

### 4. `src/helpers/windowManager.js`

Add push-to-talk state machine for Linux (identical pattern to Windows):

- `this.linuxPushState = null`
- `startLinuxPushToTalk()` — same 150ms hold threshold as `startWindowsPushToTalk()` (line 359)
- `handleLinuxPushKeyUp()` — same pattern as `handleWindowsPushKeyUp()` (line 387)
- `resetLinuxPushState()`
- `isUsingPortalShortcuts()` — delegates to `hotkeyManager.isUsingPortal()`

### 5. `src/helpers/ipcHandlers.js`

**Update `get-hotkey-mode-info` (line 1239):**
```javascript
return {
  isUsingGnome: isUsingGnome && !isUsingPortal,  // legacy = no PTT
  isUsingPortal,                                   // portal = has PTT
  supportsPushToTalk: !isUsingGnome || isUsingPortal,
}
```

### 6. `src/components/OnboardingFlow.tsx` (line 153) and `src/components/SettingsPage.tsx` (line 959)

Update both `checkHotkeyMode` effects:
```typescript
if (info?.isUsingGnome && !info?.supportsPushToTalk) {
  setIsUsingGnomeHotkeys(true);
  setActivationMode("tap");
}
// Portal active → don't hide activation mode selector → PTT available
```

### 7. `src/types/electron.ts` (line ~637)

Update `getHotkeyModeInfo` return type to include `isUsingPortal` and `supportsPushToTalk`.

---

## Implementation Order

1. Create `src/helpers/portalShortcut.js`
2. Modify `src/helpers/hotkeyManager.js` — portal-first init
3. Modify `src/helpers/windowManager.js` — Linux push state machine
4. Modify `main.js` — wire up portal events
5. Modify `src/helpers/ipcHandlers.js` — richer mode info
6. Modify `src/types/electron.ts` — type update
7. Modify `OnboardingFlow.tsx` + `SettingsPage.tsx` — un-hide activation mode selector

---

## Verification

1. **Build:** `npm run build:renderer` — no compile errors
2. **Runtime on Ubuntu 25.10 (GNOME 49):**
   - Launch app → portal shortcut session created (check debug logs)
   - Set activation mode to "push" (selector should be visible now)
   - Hold hotkey → recording starts after 150ms
   - Release hotkey → recording stops, transcription begins
   - Tap mode still works (single press toggles)
3. **Fallback on Ubuntu 24.04 (GNOME 46):**
   - Portal `checkAvailability()` returns false
   - Falls back to existing gsettings/dbus-send toggle
   - Activation mode selector hidden, tap mode forced (same as today)
4. **Hotkey changes:** Change hotkey in settings → portal shortcut updates without restarting session
