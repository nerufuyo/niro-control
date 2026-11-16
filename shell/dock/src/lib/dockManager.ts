import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import Mtk from "gi://Mtk";
import Shell from "gi://Shell";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { DockVisibility } from "./dockVisibility.js";
import { genie } from "./genie.js";
import { IconManager, type MediaAction } from "./iconManager.js";
import { Intellihide } from "./intellihide.js";
import { Magnification } from "./magnification.js";
import { MediaManager } from "./mediaManager.js";
import { SignalManager } from "./signalManager.js";
import { WindowPreviewPopup } from "./windowPreview.js";
import { box, inhibitScanout, isWayland, setVertical } from "./compat.js";

/** The applications button's pictures (setting `app-button-icon`). */
const APP_BUTTON_ICONS: Record<string, string> = {
  grid: "view-app-grid-symbolic",
  list: "view-list-symbolic",
  search: "system-search-symbolic",
  menu: "open-menu-symbolic",
  star: "starred-symbolic",
  home: "user-home-symbolic",
};

/** Docks other extensions put on the screen: Ubuntu's own, and Dash to Dock (its base). Turned off while this dock is on (setting `hide-system-dock`). */
const SYSTEM_DOCKS = ["ubuntu-dock@ubuntu.com", "dash-to-dock@micxgx.gmail.com"];

const POSITIONS = { BOTTOM: 0, LEFT: 1, RIGHT: 2, TOP: 3 } as const;

export class DockManager {
  private _signals: SignalManager;
  private _container: InstanceType<typeof St.BoxLayout> | null = null;
  private _intellihide: Intellihide | null = null;
  private _visibility: DockVisibility | null = null;
  private _overviewHidden = false;
  /** A full-screen app has the dock's display: it auto-hides there, and its edge brings it back (see `_syncFullscreen`). */
  private _fsForced = false;
  /** Whether this dock holds back X11's unredirection of a full-screen window, so its edge can show over it. */
  private _scanoutInhibited = false;
  /** The dock is on screen or sliding (told by DockVisibility). */
  private _dockActive = false;
  /** The system docks this one turned off, to turn on again when it goes (see `_syncSystemDocks`). */
  private _disabledDocks: string[] = [];
  private _systemDocksSourceId: number | null = null;
  private _iconManager: IconManager | null = null;
  private _magnification: Magnification | null = null;
  private _settings: Gio.Settings | null = null;
  private _lastFocusedApp: Shell.App | null = null;
  private _recentlyLaunched: Set<string> = new Set();
  private _debounceSourceId: number | null = null;
  private _repositionSourceId: number | null = null;
  private _originalDashVisible?: boolean;
  private _dockPosition: number = POSITIONS.BOTTOM;
  private _blurEffect: Shell.BlurEffect | null = null;
  private _bg: InstanceType<typeof St.Widget> | null = null;
  private _bgExtra: [number, number] = [0, 0];
  private _launching: { app: Shell.App; time: number } | null = null;
  private _launchBounceId: number | null = null;
  private _previewPopup: WindowPreviewPopup | null = null;
  private _mediaManager: MediaManager | null = null;
  private _theme: St.Theme | null = null;
  private _customCssFile: Gio.File | null = null;
  private _customCssDirectory: Gio.File | null = null;
  private _customCss = "";

  private static readonly MARGIN_BOTTOM = 12;
  private static readonly MIN_DOCK_WIDTH = 300;
  private static readonly LAUNCH_DEBOUNCE_MS = 400;

  constructor() {
    this._signals = new SignalManager();
  }

  private get _dockHeight(): number {
    const iconSize = this._settings?.get_int("icon-size") ?? 38;
    const iconActorHeight = iconSize + 8;
    return iconActorHeight + 2 * this._verticalPadding();
  }

  /** The dock's side padding (Settings), and from it the room above and below the icons: 4px at the default 10. */
  private _sidePadding(): number {
    return this._settings?.get_int("dock-padding") ?? 10;
  }

  private _verticalPadding(): number {
    return Math.max(2, Math.round(this._sidePadding() * 0.4));
  }

  private _iconSpacing(): number {
    return this._settings?.get_int("icon-spacing") ?? 6;
  }

  enable(settings: Gio.Settings): void {
    this._settings = settings;
    this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    this._applyCustomCss(settings.get_string("custom-css"));

    // Hide the default GNOME dash to avoid conflict.
    this._hideDefaultDash();

    this._container = new St.BoxLayout({
      style_class: "dock-container",
      ...box(false),
      reactive: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.END,
    });

    Main.layoutManager.addTopChrome(this._container);

    // Separate background actor so the dock "shelf" can grow with the magnified icons.
    this._bg = new St.Widget({ style_class: "dock-bg", reactive: false });
    Main.layoutManager.addTopChrome(this._bg);
    this._container.get_parent()?.set_child_below_sibling(this._bg, this._container);
    for (const prop of ["x", "y", "width", "height", "opacity", "visible", "translation-x", "translation-y"])
      this._signals.connect(this._container, `notify::${prop}`, () => this._syncBg());

    // Icon manager: populates the container with app buttons.
    const iconManager = new IconManager(
      this._container,
      settings.get_int("icon-size"),
      settings.get_boolean("running-indicators"),
      settings.get_int("icon-quality"),
      settings.get_double("magnification-scale"),
      settings.get_int("running-indicator-style"),
    );
    this._iconManager = iconManager;
    iconManager.setOnClicked((app) => this._onAppClicked(app));
    iconManager.setOnIconsChanged(() => {
      this._updatePosition();
      this._syncAllIconGeometry();
    });
    // Windows minimize into (and restore from) their dock icon, and new ones fly out of it.
    this._signals.connect(global.window_manager, "map", (_wm: unknown, actor: unknown) => this._flyOut(actor as Clutter.Actor));
    // Genie: a funnel-shaped clone of the window flies into (or out of) its dock icon.
    this._signals.connect(global.window_manager, "minimize", (_wm: unknown, actor: unknown) =>
      this._genie(actor as Clutter.Actor, false),
    );
    this._signals.connect(global.window_manager, "unminimize", (_wm: unknown, actor: unknown) =>
      this._genie(actor as Clutter.Actor, true),
    );
    // Thumbnails follow the windows that are minimized: a closed one, or one restored some other way, goes.
    this._signals.connect(global.window_manager, "destroy", () => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._iconManager?.syncMinimized();
      return GLib.SOURCE_REMOVE;
    }));
    this._signals.connect(global.window_manager, "switch-workspace", () => this._iconManager?.syncMinimized());
    this._signals.connect(global.display, "window-created", () =>
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this._syncAllIconGeometry();
        return GLib.SOURCE_REMOVE;
      }),
    );
    iconManager.setOnMediaAction((action) => this._onMediaAction(action));
    iconManager.setOnContextMenuActorChanged((actor) => {
      if (this._visibility) {
        this._visibility.setContextMenuActor(actor);
      }
    });
    // Read at start-up too: the setting was only applied when it changed, so the button came back on every login.
    iconManager.setShowAppButton(settings.get_boolean("show-applications-button"));
    iconManager.setShowRunningApps(settings.get_boolean("show-running-apps"));
    iconManager.setAppButtonPosition(settings.get_int("show-applications-button-position"));
    iconManager.setWorkspaceMode(settings.get_int("dock-workspace-mode"));
    iconManager.setIconSpacing(this._iconSpacing());
    iconManager.setAppButtonIcon(APP_BUTTON_ICONS[settings.get_string("app-button-icon")] ?? APP_BUTTON_ICONS.grid);
    iconManager.setIconStyle(settings.get_string("icon-style"));
    iconManager.setIconColor(settings.get_string("icon-color"));
    iconManager.setIconTheme(settings.get_string("icon-theme"));
    iconManager.setMinimizedInDock(settings.get_boolean("minimized-in-dock"));
    iconManager.setMediaIndicatorEnabled(settings.get_boolean("media-indicator"));
    iconManager.setMediaControlsEnabled(settings.get_boolean("media-controls"));
    iconManager.setDragReorderEnabled(settings.get_boolean("drag-reorder"));
    // Window preview popup
    this._previewPopup = new WindowPreviewPopup();
    const previewPopup = this._previewPopup;
    previewPopup.setPreviewWidth(settings.get_int("preview-scale"));
    iconManager.setPreviewPopup(previewPopup);
    iconManager.setWindowPreviewsEnabled(settings.get_boolean("window-previews"));

    iconManager.start();

    // Magnification: scale icons on hover.
    const magnification = new Magnification(
      this._container,
      settings.get_boolean("magnification-enabled"),
      settings.get_double("magnification-scale"),
      settings.get_int("magnification-falloff"),
      settings.get_int("magnification-framerate"),
    );
    this._magnification = magnification;
    magnification.setOnExtent((w) => {
      const bottom = this._dockPosition === POSITIONS.BOTTOM;
      this._bgExtra = bottom ? [w, 0] : [0, 0];
      this._syncBg();
    });
    magnification.start();
    iconManager.setOnDragStateChanged((dragging) => {
      previewPopup.cancelScheduledHide();
      previewPopup.hide();
      if (dragging) {
        magnification.pause();
      } else {
        magnification.resume();
      }
      this._visibility?.setDragActive(dragging);
    });

    // Media manager: MPRIS integration for music controls.
    this._mediaManager = new MediaManager();
    this._mediaManager.setOnStateChanged((app) => {
      iconManager.setPlayingApp(app?.get_id() ?? null);
    });
    this._mediaManager.start();

    this._applyDockStyle();
    this._applyDockPosition();
    this._registerKeybindings();
    this._updatePosition();
    this._signals.connect(global.display, "workareas-changed", () => this._updatePosition());
    this._signals.connect(global.backend.get_monitor_manager(), "monitors-changed", () => {
      iconManager.refreshResourceScale();
      this._updatePosition();
    });

    // Watch for newly launched apps so we can bounce their dock icon.
    const tracker = Shell.WindowTracker.get_default();
    this._signals.connect(tracker, "notify::focus-app", () => this._onFocusAppChanged());

    // Live settings.
    this._signals.connect(settings, "changed::icon-size", () => {
      iconManager.setIconSize(settings.get_int("icon-size"));
      this._updatePosition();
    });
    // Size of the dock: the space between icons and around them.
    for (const key of ["icon-spacing", "dock-padding"]) {
      this._signals.connect(settings, `changed::${key}`, () => {
        iconManager.setIconSpacing(this._iconSpacing());
        this._applyDockStyle();
        if (this._visibility) this._startAutoHide();
        this._updatePosition();
      });
    }
    // Look of the icons: theme, tile, colours, and the applications button's picture.
    this._signals.connect(settings, "changed::icon-theme", () => {
      iconManager.setIconTheme(settings.get_string("icon-theme"));
      this._updatePosition();
    });
    this._signals.connect(settings, "changed::icon-style", () => {
      iconManager.setIconStyle(settings.get_string("icon-style"));
      this._updatePosition();
    });
    this._signals.connect(settings, "changed::icon-color", () => iconManager.setIconColor(settings.get_string("icon-color")));
    this._signals.connect(settings, "changed::app-button-icon", () =>
      iconManager.setAppButtonIcon(APP_BUTTON_ICONS[settings.get_string("app-button-icon")] ?? APP_BUTTON_ICONS.grid),
    );
    this._signals.connect(settings, "changed::auto-hide", () => {
      if (settings.get_boolean("auto-hide")) {
        this._startAutoHide();
      } else if (!this._fsForced) {
        this._stopAutoHide();
      }
    });
    this._signals.connect(settings, "changed::fullscreen-reveal", () => this._syncFullscreen());
    this._signals.connect(global.display, "in-fullscreen-changed", () => this._syncFullscreen());
    // The windows are hidden while the Overview is up, which is no full screen: looked at again as it goes.
    this._signals.connect(Main.overview, "hidden", () => this._syncFullscreen());
    this._signals.connect(settings, "changed::magnification-enabled", () => {
      magnification.setEnabled(settings.get_boolean("magnification-enabled"));
    });
    this._signals.connect(settings, "changed::magnification-scale", () => {
      magnification.setMaxScale(settings.get_double("magnification-scale"));
      iconManager.setMagnificationScale(settings.get_double("magnification-scale"));
    });
    this._signals.connect(settings, "changed::magnification-falloff", () => {
      magnification.setFalloffDistance(settings.get_int("magnification-falloff"));
    });
    this._signals.connect(settings, "changed::running-indicators", () => {
      iconManager.setRunningIndicatorsEnabled(settings.get_boolean("running-indicators"));
    });
    this._signals.connect(settings, "changed::animation-duration", () => {
      if (this._visibility) {
        this._visibility.updateAnimationDuration(settings.get_int("animation-duration"));
      }
    });
    this._signals.connect(settings, "changed::magnification-framerate", () => {
      magnification.setFramerate(settings.get_int("magnification-framerate"));
    });
    this._signals.connect(settings, "changed::icon-quality", () => {
      iconManager.setQuality(settings.get_int("icon-quality"));
    });
    this._signals.connect(settings, "changed::running-indicator-style", () => {
      iconManager.setIndicatorStyle(settings.get_int("running-indicator-style"));
    });
    this._signals.connect(settings, "changed::show-threshold", () => {
      if (this._visibility && settings.get_boolean("auto-hide")) {
        this._startAutoHide();
      }
    });
    this._signals.connect(settings, "changed::dock-opacity", () => this._applyDockStyle());
    this._signals.connect(settings, "changed::dock-background-color", () => this._applyDockStyle());
    this._signals.connect(settings, "changed::dock-border-radius", () => this._applyDockStyle());
    this._signals.connect(settings, "changed::dock-blur-enabled", () => this._applyDockStyle());
    this._signals.connect(settings, "changed::dock-position", () => this._applyDockPosition());
    this._signals.connect(settings, "changed::show-applications-button", () => {
      iconManager.setShowAppButton(settings.get_boolean("show-applications-button"));
      this._updatePosition();
    });
    this._signals.connect(settings, "changed::show-applications-button-position", () => {
      iconManager.setAppButtonPosition(settings.get_int("show-applications-button-position"));
      this._updatePosition();
    });
    this._signals.connect(settings, "changed::custom-css", () => {
      this._applyCustomCss(settings.get_string("custom-css"));
    });
    this._signals.connect(settings, "changed::enable-keyboard-nav", () => {
      this._removeKeybindings();
      this._registerKeybindings();
    });
    this._signals.connect(settings, "changed::window-previews", () => {
      const enabled = settings.get_boolean("window-previews");
      iconManager.setWindowPreviewsEnabled(enabled);
      if (!enabled) previewPopup.hide();
    });
    this._signals.connect(settings, "changed::preview-scale", () => {
      previewPopup.setPreviewWidth(settings.get_int("preview-scale"));
    });
    this._signals.connect(settings, "changed::show-running-apps", () => {
      iconManager.setShowRunningApps(settings.get_boolean("show-running-apps"));
    });
    this._signals.connect(settings, "changed::minimized-in-dock", () => {
      iconManager.setMinimizedInDock(settings.get_boolean("minimized-in-dock"));
      this._updatePosition();
    });
    this._signals.connect(settings, "changed::dock-workspace-mode", () => {
      iconManager.setWorkspaceMode(settings.get_int("dock-workspace-mode"));
    });
    this._signals.connect(global.workspace_manager, "workspace-switched", () => {
      if (settings.get_int("dock-workspace-mode") === 1) {
        iconManager.reload();
      }
    });
    this._signals.connect(settings, "changed::media-indicator", () => {
      iconManager.setMediaIndicatorEnabled(settings.get_boolean("media-indicator"));
    });
    this._signals.connect(settings, "changed::drag-reorder", () => {
      iconManager.setDragReorderEnabled(settings.get_boolean("drag-reorder"));
    });
    this._signals.connect(settings, "changed::media-controls", () => {
      iconManager.setMediaControlsEnabled(settings.get_boolean("media-controls"));
    });

    if (settings.get_boolean("auto-hide")) {
      this._startAutoHide();
    }

    // Super: the Overview has the screen, so the dock slides away with it and comes back as it closes.
    this._signals.connect(Main.overview, "showing", () => this._setOverviewHidden(true));
    this._signals.connect(Main.overview, "hiding", () => this._setOverviewHidden(false));
    if (Main.overview.visibleTarget ?? Main.overview.visible) this._setOverviewHidden(true);
    this._syncFullscreen();

    // The docks of the system (Ubuntu's, Dash to Dock) would stand beside this one: they go while it is on.
    // Not from inside this call (nor the manager's): it rewrites the list of extensions, which must not happen while one is being turned on.
    this._signals.connect(settings, "changed::hide-system-dock", () => this._scheduleSystemDocks());
    this._signals.connect(Main.extensionManager, "extension-state-changed", (_manager: unknown, extension: unknown) => {
      if (SYSTEM_DOCKS.includes((extension as { uuid: string }).uuid)) this._scheduleSystemDocks();
    });
    this._scheduleSystemDocks();
  }

  private _scheduleSystemDocks(): void {
    if (this._systemDocksSourceId !== null) return;
    this._systemDocksSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
      this._systemDocksSourceId = null;
      this._syncSystemDocks();
      return GLib.SOURCE_REMOVE;
    });
  }

  /** Turns the system docks off (and back on, once this dock's setting is off or it is gone), as `hide-system-dock` says. */
  private _syncSystemDocks(): void {
    const settings = this._settings;
    if (!settings) return;
    const manager = Main.extensionManager;
    const ACTIVE = 1; // ExtensionState.ACTIVE
    if (settings.get_boolean("hide-system-dock")) {
      for (const uuid of SYSTEM_DOCKS) {
        const extension = manager.lookup(uuid);
        if (!extension || extension.state !== ACTIVE) continue;
        manager.disableExtension(uuid);
        if (!this._disabledDocks.includes(uuid)) this._disabledDocks.push(uuid);
      }
    } else {
      this._restoreSystemDocks();
    }
  }

  private _restoreSystemDocks(): void {
    for (const uuid of this._disabledDocks.splice(0)) Main.extensionManager.enableExtension(uuid);
  }

  /**
   * A full-screen window goes straight to the screen (X11's unredirection, Wayland's direct scanout), past what is drawn over it:
   * while the dock is up over one it is held back, so the dock shows. On X11 also for the whole time the edge is wanted: the
   * stage must be on top of the window to feel the pointer at the edge. Not otherwise: it costs a full-screen video or game
   * its direct path.
   */
  private _syncScanout(): void {
    const want = this._fsForced && (this._dockActive || !isWayland());
    if (want === this._scanoutInhibited) return;
    this._scanoutInhibited = want;
    inhibitScanout(want);
  }

  /**
   * Over a full-screen app the dock goes away whatever the auto-hide setting, and the screen edge it sits on brings it back while the
   * pointer is there. GNOME hides chrome under a full-screen window and gives it no way back, so the dock leaves that rule while
   * it lasts (its edge strip has always been outside it) and takes the auto-hide animation.
   */
  private _syncFullscreen(): void {
    const settings = this._settings;
    if (!settings || !this._container) return;
    const monitor = Main.layoutManager.primaryMonitor;
    const wanted = settings.get_boolean("fullscreen-reveal") && Boolean(monitor?.inFullscreen) && global.window_group.visible;
    if (wanted === this._fsForced) return;
    this._fsForced = wanted;
    this._syncScanout();
    for (const actor of [this._container, this._bg]) {
      if (!actor) continue;
      Main.layoutManager.untrackChrome(actor);
      Main.layoutManager.trackChrome(actor, { affectsStruts: false, trackFullscreen: !wanted });
    }
    if (wanted) {
      if (!this._visibility) this._startAutoHide();
      this._visibility?.setFullEdge(true);
    } else {
      this._visibility?.setFullEdge(false);
      if (!settings.get_boolean("auto-hide")) this._stopAutoHide();
    }
  }

  /** The dock's own slide for the Overview when it is not auto-hiding (DockVisibility does it when it is). */
  private _setOverviewHidden(hidden: boolean): void {
    if (hidden === this._overviewHidden) return;
    this._overviewHidden = hidden;
    if (this._visibility) {
      this._visibility.setOverviewHidden(hidden);
      return;
    }
    const container = this._container;
    if (!container) return;
    const duration = this._settings?.get_int("animation-duration") ?? 200;
    if (hidden) {
      const vertical = this._dockPosition === POSITIONS.LEFT || this._dockPosition === POSITIONS.RIGHT;
      const away = Math.ceil((vertical ? container.width : container.height) * 1.2) + 24;
      const sign = this._dockPosition === POSITIONS.TOP || this._dockPosition === POSITIONS.LEFT ? -1 : 1;
      const params: Record<string, unknown> = {
        translation_x: vertical ? sign * away : 0,
        translation_y: vertical ? 0 : sign * away,
        opacity: 0,
        duration,
        mode: Clutter.AnimationMode.EASE_IN_QUAD,
        onStopped: (finished: boolean) => {
          if (finished && this._overviewHidden) container.visible = false;
        },
      };
      (container as unknown as { ease(p: Record<string, unknown>): void }).ease(params);
    } else {
      container.visible = true;
      (container as unknown as { ease(p: Record<string, unknown>): void }).ease({
        translation_x: 0,
        translation_y: 0,
        opacity: 255,
        duration,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
      });
    }
  }

  disable(): void {
    // The system docks come back, unless the screen only locked (this dock is then off for a moment, not removed).
    if (this._systemDocksSourceId !== null) {
      GLib.Source.remove(this._systemDocksSourceId);
      this._systemDocksSourceId = null;
    }
    if (!Main.sessionMode.isLocked) this._restoreSystemDocks();
    this._fsForced = false;
    this._syncScanout();

    if (this._visibility) {
      this._visibility.stop();
      this._visibility = null;
    }

    if (this._intellihide) {
      this._intellihide.stop();
      this._intellihide = null;
    }

    if (this._iconManager) {
      this._iconManager.stop();
      this._iconManager = null;
    }

    if (this._magnification) {
      this._magnification.stop();
      this._magnification = null;
    }

    if (this._previewPopup) {
      this._previewPopup.stop();
      this._previewPopup = null;
    }

    if (this._mediaManager) {
      this._mediaManager.stop();
      this._mediaManager = null;
    }

    this._removeKeybindings();
    this._signals.disconnectAll();

    if (this._debounceSourceId !== null) {
      GLib.source_remove(this._debounceSourceId);
      this._debounceSourceId = null;
    }
    if (this._repositionSourceId !== null) {
      GLib.source_remove(this._repositionSourceId);
      this._repositionSourceId = null;
    }

    if (this._launchBounceId) {
      GLib.source_remove(this._launchBounceId);
      this._launchBounceId = null;
    }

    if (this._bg) {
      Main.layoutManager.removeChrome(this._bg);
      this._bg.destroy();
      this._bg = null;
    }

    if (this._container) {
      Main.layoutManager.removeChrome(this._container);
      this._container.destroy();
      this._container = null;
    }

    this._removeCustomCss();

    // Restore the default GNOME dash.
    this._showDefaultDash();

    this._settings = null;
  }

  private _startAutoHide(): void {
    if (!this._container || !this._settings) return;

    // Clean up any existing auto-hide before creating new.
    this._stopAutoHide();

    this._intellihide = new Intellihide();
    this._visibility = new DockVisibility(
      this._container,
      this._intellihide,
      this._dockHeight,
      this._settings.get_int("animation-duration"),
      this._settings.get_int("show-threshold"),
      this._dockPosition,
      this._settings.get_double("magnification-scale"),
    );
    if (this._previewPopup) {
      this._visibility.setPreviewPopup(this._previewPopup);
    }
    // Must set dock rect AFTER creating intellihide so it can detect overlap.
    this._updatePosition();
    this._visibility.setOnActiveChanged((active) => {
      this._dockActive = active;
      this._syncScanout();
    });
    this._visibility.start();
    this._visibility.setFullEdge(this._fsForced);
    if (this._overviewHidden) this._visibility.setOverviewHidden(true);
  }

  private _stopAutoHide(): void {
    if (this._visibility) {
      this._visibility.stop();
      this._visibility = null;
    }
    if (this._intellihide) {
      this._intellihide.stop();
      this._intellihide = null;
    }
    if (this._container) {
      this._container.visible = true;
      this._container.opacity = 255;
      this._updatePosition();
      // Still in the Overview: the dock goes out again by its own slide.
      if (this._overviewHidden) {
        this._overviewHidden = false;
        this._setOverviewHidden(true);
      }
    }
  }

  // Where the app's icon sits on screen; GNOME animates minimize/restore to and from this rectangle.
  private _iconRect(app: Shell.App): { x: number; y: number; width: number; height: number } | null {
    const actor = this._iconManager?.getIconActor(app);
    if (!actor) return null;
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return { x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
  }

  private _syncIconGeometry(app: Shell.App): void {
    const rect = this._iconRect(app);
    if (!rect) return;
    for (const win of app.get_windows()) win.set_icon_geometry(new Mtk.Rectangle(rect));
  }

  private _syncAllIconGeometry(): void {
    for (const app of Shell.AppSystem.get_default().get_running()) this._syncIconGeometry(app);
  }

  private _genie(actor: Clutter.Actor, reverse: boolean): void {
    const win = (actor as unknown as { meta_window?: Meta.Window }).meta_window;
    const app = win ? Shell.WindowTracker.get_default().get_window_app(win) : null;
    const manager = this._iconManager;
    let rect: { x: number; y: number; width: number; height: number } | null = null;
    // A minimized window goes to its own thumbnail at the dock's end (macOS-style), and comes back from it.
    if (win && manager?.isMinimizedInDock() && manager.isMinimizable(win)) {
      if (reverse) {
        rect = manager.minimizedRect(win);
        manager.removeMinimized(win);
      } else {
        rect = manager.addMinimized(win);
      }
    }
    rect ??= app ? this._iconRect(app) : null;
    if (rect) genie(actor, rect, { reverse });
    // An app that is not pinned has no thumbnail at the end: its icon becomes the overview once the window has arrived (and goes back
    // as it leaves).
    if (win && manager?.isMinimizedInDock() && !manager.isMinimizable(win)) {
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, reverse ? 30 : 470, () => {
        this._iconManager?.syncMinimized();
        return GLib.SOURCE_REMOVE;
      });
    }
  }

  // A window opened by a dock click scales up out of the app's icon, macOS style.
  private _flyOut(actor: Clutter.Actor): void {
    const win = (actor as unknown as { meta_window?: Meta.Window }).meta_window;
    const pending = this._launching;
    if (!win || !pending || Date.now() - pending.time > 5000 || win.get_window_type() !== Meta.WindowType.NORMAL) return;
    if (Shell.WindowTracker.get_default().get_window_app(win) !== pending.app) return;
    const rect = this._iconRect(pending.app);
    if (!rect) return;
    this._launching = null;
    actor.remove_all_transitions(); // drops GNOME's own map animation (it finishes the map for us)
    const [ax, ay] = actor.get_position();
    const [aw, ah] = actor.get_size();
    actor.set_pivot_point(
      (rect.x + rect.width / 2 - ax) / Math.max(1, aw),
      (rect.y + rect.height / 2 - ay) / Math.max(1, ah),
    );
    actor.set({ scale_x: 0.04, scale_y: 0.04, opacity: 0 } as Record<string, number>);
    (actor as unknown as { ease(p: Record<string, unknown>): void }).ease({
      scale_x: 1,
      scale_y: 1,
      opacity: 255,
      duration: 320,
      mode: Clutter.AnimationMode.EASE_OUT_EXPO,
      onComplete: () => actor.set_pivot_point(0, 0),
    });
  }

  private _onAppClicked(app: Shell.App): void {
    this._syncIconGeometry(app);
    const firstWindow = this._findFirstWindow(app);

    if (firstWindow) {
      if (firstWindow.has_focus() && !firstWindow.minimized) {
        // Window is focused and visible — minimize it.
        firstWindow.minimize();
      } else if (firstWindow.minimized) {
        // Window is minimized — restore and activate.
        firstWindow.unminimize();
        firstWindow.activate(global.get_current_time());
      } else {
        // Window exists but not focused — activate it.
        firstWindow.activate(global.get_current_time());
      }
    } else {
      this._launching = { app, time: Date.now() };
      app.open_new_window(-1);
      this._launchBounce(app);
    }
  }

  // macOS keeps the icon jumping until the app's window is up (at most 10 s).
  private _launchBounce(app: Shell.App): void {
    const id = app.get_id();
    this._recentlyLaunched.add(id); // the focus-change bounce would be a second jump
    const started = Date.now();
    const step = (): boolean => {
      if (!this._iconManager || app.get_windows().length > 0 || Date.now() - started > 10000) {
        this._launchBounceId = null;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
          this._recentlyLaunched.delete(id);
          return GLib.SOURCE_REMOVE;
        });
        return GLib.SOURCE_REMOVE;
      }
      this._iconManager.bounceForApp(app);
      return GLib.SOURCE_CONTINUE;
    };
    this._iconManager?.bounceForApp(app);
    if (this._launchBounceId) GLib.source_remove(this._launchBounceId);
    this._launchBounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, step);
  }

  private _onMediaAction(action: MediaAction): void {
    if (!this._mediaManager) return;
    switch (action) {
      case "play-pause":
        this._mediaManager.togglePlayPause();
        break;
      case "next":
        this._mediaManager.next();
        break;
      case "previous":
        this._mediaManager.previous();
        break;
    }
  }

  private _findFirstWindow(app: Shell.App) {
    const tracker = Shell.WindowTracker.get_default();
    const windows = global.get_window_actors();
    for (const wa of windows) {
      const metaWin = wa.get_meta_window();
      if (!metaWin) continue;
      if (tracker.get_window_app(metaWin) === app) {
        return metaWin;
      }
    }
    return null;
  }

  private _onFocusAppChanged(): void {
    if (!this._settings) return;
    if (!this._settings.get_boolean("bounce-on-launch")) return;
    if (!this._iconManager) return;

    const tracker = Shell.WindowTracker.get_default();
    const app = tracker.focus_app;
    if (!app) {
      this._lastFocusedApp = null;
      return;
    }
    const appId = app.get_id();
    if (this._lastFocusedApp === app) return;
    this._lastFocusedApp = app;

    if (this._recentlyLaunched.has(appId)) return;
    this._recentlyLaunched.add(appId);

    if (this._debounceSourceId !== null) {
      GLib.source_remove(this._debounceSourceId);
    }

    this._debounceSourceId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      DockManager.LAUNCH_DEBOUNCE_MS,
      () => {
        this._recentlyLaunched.delete(appId);
        this._debounceSourceId = null;
        return GLib.SOURCE_REMOVE;
      },
    );

    this._iconManager.bounceForApp(app);
  }

  private _updatePosition(): void {
    if (!this._container) return;

    // The show/hide animation owns the container's translation, so a layout
    // update mid-animation would conflict with it: try again once it is done.
    // A dock that is simply shown must still be re-centred (icon size, icons
    // added or removed), so only the animation holds this back.
    if (this._visibility?.isAnimating()) {
      if (this._repositionSourceId === null) {
        this._repositionSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
          this._repositionSourceId = null;
          this._updatePosition();
          return GLib.SOURCE_REMOVE;
        });
      }
      return;
    }

    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;

    const iconManager = this._iconManager;
    if (!iconManager) return;

    const iconCount = iconManager.getIconCount();
    const hasSeparator = iconManager.hasSeparator();
    const hasAppButton = iconManager.hasAppButton();
    const iconPadded = (this._settings?.get_int("icon-size") ?? 38) + 12;
    const spacing = this._iconSpacing();
    const padding = 2 * this._sidePadding();
    const separatorWidth = 9; // 1px width + 4px margin each side
    const contentSize =
      iconCount > 0
        ? iconCount * iconPadded +
          (iconCount - 1) * spacing +
          (hasSeparator ? separatorWidth + spacing : 0) +
          (hasAppButton ? iconPadded + spacing : 0)
        : hasAppButton
          ? iconPadded
          : 0;
    const minimizedExtent = iconManager.getMinimizedExtent();
    const dockAxisSize = Math.max(contentSize + minimizedExtent + padding, DockManager.MIN_DOCK_WIDTH);

    let x = 0;
    let y = 0;
    let w = 0;
    let h = 0;

    switch (this._dockPosition) {
      case POSITIONS.BOTTOM:
        w = dockAxisSize;
        h = this._dockHeight;
        x = monitor.x + Math.floor((monitor.width - w) / 2);
        y = monitor.y + monitor.height - h - DockManager.MARGIN_BOTTOM;
        break;
      case POSITIONS.TOP:
        w = dockAxisSize;
        h = this._dockHeight;
        x = monitor.x + Math.floor((monitor.width - w) / 2);
        y = monitor.y + DockManager.MARGIN_BOTTOM;
        break;
      case POSITIONS.LEFT:
        w = this._dockHeight;
        h = dockAxisSize;
        x = monitor.x + DockManager.MARGIN_BOTTOM;
        y = monitor.y + Math.floor((monitor.height - h) / 2);
        break;
      case POSITIONS.RIGHT:
        w = this._dockHeight;
        h = dockAxisSize;
        x = monitor.x + monitor.width - w - DockManager.MARGIN_BOTTOM;
        y = monitor.y + Math.floor((monitor.height - h) / 2);
        break;
    }

    this._container.set_size(w, h);
    this._container.set_position(x, y);
    this._syncBg();

    if (this._visibility) {
      this._visibility.updateShownY(y);
      this._visibility.updateDockBounds(x, y, w, h);
    }

    if (this._intellihide) {
      this._intellihide.setDockRect(x, y, w, h);
    }
  }

  private _hideDefaultDash(): void {
    const dash = Main.overview.dash;
    this._originalDashVisible = dash.visible;
    dash.hide();
  }

  private _showDefaultDash(): void {
    const dash = Main.overview.dash;
    dash.visible = this._originalDashVisible ?? true;
  }

  private _syncBg(): void {
    const c = this._container;
    const bg = this._bg;
    if (!c || !bg) return;
    const [w, h] = c.get_size();
    const [gx, gy] = c.get_transformed_position();
    const [ew, eh] = this._bgExtra;
    // A hidden dock has no position to follow (it reads as NaN, which Clutter refuses to allocate).
    if (c.visible && Number.isFinite(gx) && Number.isFinite(gy)) {
      bg.set_position(Math.round(gx - ew / 2), Math.round(gy - eh));
      bg.set_size(Math.round(w + ew), Math.round(h + eh));
    }
    bg.opacity = c.opacity;
    bg.visible = c.visible;
  }

  private _applyDockStyle(): void {
    if (!this._container || !this._bg || !this._settings) return;

    const opacity = this._settings.get_int("dock-opacity");
    const color = this._settings.get_string("dock-background-color");
    const radius = this._settings.get_int("dock-border-radius");
    const blurEnabled = this._settings.get_boolean("dock-blur-enabled");

    // Parse hex color
    const r = parseInt(color.slice(1, 3), 16) || 30;
    const g = parseInt(color.slice(3, 5), 16) || 30;
    const b = parseInt(color.slice(5, 7), 16) || 30;
    const alpha = opacity / 100;

    this._container.style = `
      padding: ${this._verticalPadding()}px ${this._sidePadding()}px;
      spacing: ${this._iconSpacing()}px;
    `;
    this._bg.style = `
      background-color: rgba(${r}, ${g}, ${b}, ${alpha});
      border-radius: ${radius}px;
    `;

    // Handle blur effect
    if (blurEnabled && !this._blurEffect) {
      this._blurEffect = new Shell.BlurEffect();
      this._blurEffect.set({ sigma: 30, mode: Shell.BlurMode.BACKGROUND });
      this._bg.add_effect(this._blurEffect);
    } else if (!blurEnabled && this._blurEffect) {
      this._bg.remove_effect(this._blurEffect);
      this._blurEffect = null;
    }
  }

  private _applyCustomCss(css: string): void {
    if (!this._theme || css === this._customCss) return;

    if (!css.trim()) {
      this._clearCustomCss();
      return;
    }

    const checksum = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, css, -1);
    if (!checksum) return;

    const directoryPath = GLib.build_filenamev([GLib.get_user_cache_dir(), "dock"]);
    const directory = Gio.File.new_for_path(directoryPath);
    const file = Gio.File.new_for_path(GLib.build_filenamev([directoryPath, `${checksum}.css`]));
    let stylesheetLoaded = false;

    try {
      if (GLib.mkdir_with_parents(directoryPath, 0o700) !== 0) {
        throw new Error(`Could not create custom CSS cache directory: ${directoryPath}`);
      }
      this._customCssDirectory = directory;
      file.replace_contents(css, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

      if (!this._theme.load_stylesheet(file)) {
        this._deleteCustomCssFile(file);
        if (!this._customCssFile) this._removeCustomCssDirectory();
        console.error("Dock: GNOME Shell could not load the custom CSS stylesheet.");
        return;
      }
      stylesheetLoaded = true;

      const previousFile = this._customCssFile;
      this._customCssFile = file;
      this._customCss = css;
      if (previousFile) {
        this._theme.unload_stylesheet(previousFile);
        this._deleteCustomCssFile(previousFile);
      }
    } catch (error) {
      if (!stylesheetLoaded) this._deleteCustomCssFile(file);
      if (!this._customCssFile) this._removeCustomCssDirectory();
      console.error(`Dock: Failed to apply custom CSS: ${error}`);
    }
  }

  private _removeCustomCss(): void {
    this._clearCustomCss();
    this._theme = null;
  }

  private _clearCustomCss(): void {
    if (this._theme && this._customCssFile) {
      this._theme.unload_stylesheet(this._customCssFile);
      this._deleteCustomCssFile(this._customCssFile);
    }

    this._customCssFile = null;
    this._customCss = "";
    this._removeCustomCssDirectory();
  }

  private _deleteCustomCssFile(file: Gio.File): void {
    try {
      if (file.query_exists(null)) file.delete(null);
    } catch (error) {
      console.error(`Dock: Failed to remove cached custom CSS: ${error}`);
    }
  }

  private _removeCustomCssDirectory(): void {
    if (!this._customCssDirectory) return;

    try {
      if (this._customCssDirectory.query_exists(null)) this._customCssDirectory.delete(null);
      this._customCssDirectory = null;
    } catch (error) {
      console.error(`Dock: Failed to remove custom CSS cache directory: ${error}`);
    }
  }

  private _applyDockPosition(): void {
    if (!this._container) return;

    this._dockPosition = this._settings?.get_int("dock-position") ?? POSITIONS.BOTTOM;

    const isVertical =
      this._dockPosition === POSITIONS.LEFT || this._dockPosition === POSITIONS.RIGHT;
    setVertical(this._container, isVertical);

    // Update magnification pivot point based on position
    if (this._magnification) {
      switch (this._dockPosition) {
        case POSITIONS.TOP:
          this._magnification.setPivotPoint(0.5, 0.0);
          break;
        case POSITIONS.LEFT:
          this._magnification.setPivotPoint(0.0, 0.5);
          break;
        case POSITIONS.RIGHT:
          this._magnification.setPivotPoint(1.0, 0.5);
          break;
        default: // BOTTOM
          this._magnification.setPivotPoint(0.5, 1.0);
      }
    }

    // Update visibility edge
    if (this._visibility) {
      this._visibility.setEdge(this._dockPosition);
    }

    this._updatePosition();
  }

  private _registerKeybindings(): void {
    if (!this._settings) return;
    if (!this._settings.get_boolean("enable-keyboard-nav")) return;

    const settings = this._settings;

    Main.wm.addKeybinding(
      "toggle-dock",
      settings,
      Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
      Shell.ActionMode.NORMAL,
      () => this._toggleDockVisibility(),
    );

    // Super+1 through Super+9, Super+0 for position 10
    for (let i = 1; i <= 9; i++) {
      Main.wm.addKeybinding(
        `focus-app-${i}`,
        settings,
        Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
        Shell.ActionMode.NORMAL,
        () => this._focusAppByIndex(i - 1),
      );
    }
    Main.wm.addKeybinding(
      "focus-app-10",
      settings,
      Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
      Shell.ActionMode.NORMAL,
      () => this._focusAppByIndex(9),
    );
  }

  private _removeKeybindings(): void {
    Main.wm.removeKeybinding("toggle-dock");
    for (let i = 1; i <= 9; i++) {
      Main.wm.removeKeybinding(`focus-app-${i}`);
    }
    Main.wm.removeKeybinding("focus-app-10");
  }

  private _toggleDockVisibility(): void {
    if (!this._container) return;
    this._container.visible = !this._container.visible;
    if (this._container.visible && this._visibility) {
      // Force show even if auto-hide would hide it
      this._container.opacity = 255;
    }
  }

  private _focusAppByIndex(index: number): void {
    if (!this._iconManager) return;
    const actors = this._iconManager.getIconActors();
    if (index >= actors.length) return;

    const data = (actors[index] as unknown as Record<string, unknown>)._appData as
      | {
          appId: string;
        }
      | undefined;
    if (!data) return;

    const appSystem = Shell.AppSystem.get_default();
    const app = appSystem.lookup_app(data.appId);
    if (app) {
      this._onAppClicked(app);
    }
  }
}
