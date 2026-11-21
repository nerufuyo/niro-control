import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import type Meta from "gi://Meta";
import Shell from "gi://Shell";
import St from "gi://St";
import * as BoxPointer from "resource:///org/gnome/shell/ui/boxpointer.js";
import * as DND from "resource:///org/gnome/shell/ui/dnd.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { box } from "./compat.js";
import { ThemeResolver } from "./iconTheme.js";
import { SignalManager } from "./signalManager.js";
import type { WindowPreviewPopup } from "./windowPreview.js";

export type DockIconClicked = (app: Shell.App) => void;
export type IconsChanged = () => void;
export type MediaAction = "play-pause" | "next" | "previous";
export type DragStateChanged = (dragging: boolean) => void;

type IconActor = InstanceType<typeof St.BoxLayout>;
type Draggable = ReturnType<typeof DND.makeDraggable>;

interface AppData {
  appId: string;
  icon: InstanceType<typeof St.Icon>;
  iconWrapper: InstanceType<typeof St.Widget>;
  indicatorBox: InstanceType<typeof St.BoxLayout>;
  dots: InstanceType<typeof St.Widget>[];
  mediaIndicator: InstanceType<typeof St.Widget> | null;
  /** Unread notifications, a red count on the icon's corner. */
  badge: InstanceType<typeof St.Label> | null;
  /** An unpinned app with only minimized windows shows one of them in its icon's place. */
  overview: { win: Meta.Window; widget: InstanceType<typeof St.Widget> } | null;
  draggable: Draggable | null;
  dragSignalIds: number[];
}

interface MinItem {
  win: Meta.Window;
  actor: IconActor;
  width: number;
}

export type Rect = { x: number; y: number; width: number; height: number };

type ContextMenu = InstanceType<typeof PopupMenu.PopupMenu>;

/** A folder shown as a stack: an XDG folder by its name. */
export type StackFolder = "downloads" | "documents";
const STACKS: Record<StackFolder, { dir: GLib.UserDirectory; icon: string; name: string }> = {
  downloads: {
    dir: GLib.UserDirectory.DIRECTORY_DOWNLOAD,
    icon: "folder-download",
    name: "Downloads",
  },
  documents: {
    dir: GLib.UserDirectory.DIRECTORY_DOCUMENTS,
    icon: "folder-documents",
    name: "Documents",
  },
};
/** How many of a stack's newest files its menu lists. */
const STACK_FILES = 12;
type MenuManager = InstanceType<typeof PopupMenu.PopupMenuManager>;

/** Delegate exposed on a dragged icon so the drop target knows the source. */
interface DragSource {
  appId: string;
  isFavorite: boolean;
}

/** Container-local rectangle of the slot an icon was lifted out of. */
interface DragSlot {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Drop-target methods invoked by the DND framework on the dock container. */
interface DropTarget {
  handleDragOver(
    source: DragSource | null,
    dragActor: Clutter.Actor,
    x: number,
    y: number,
    time: number,
  ): number;
  acceptDrop(
    source: DragSource | null,
    dragActor: Clutter.Actor,
    x: number,
    y: number,
    time: number,
  ): boolean;
}

/**
 * Manages app icons inside the dock container.
 *
 * Each icon is a small St.BoxLayout wrapping an St.Icon and a running
 * indicator dot. Icons are ordered: favorite apps first, then any
 * additional running-but-not-favorited apps (like macOS shows persistent
 * apps in the dock even when not in the favorites list).
 */
export class IconManager {
  private static readonly MEDIA_BADGE_SIZE = 12;
  private static readonly MEDIA_BADGE_INSET = 3;

  private _signals: SignalManager;
  private _container: InstanceType<typeof St.BoxLayout>;
  private _iconSize: number;
  private _runningIndicatorsEnabled: boolean;
  private _quality: number;
  private _magnificationScale: number;
  private _resourceScale: number = 1;
  private _indicatorStyle: number; // 0 = dots per window, 1 = horizontal bar
  private _onClicked: DockIconClicked | null = null;
  private _onIconsChanged: IconsChanged | null = null;
  private _onMediaAction: ((action: MediaAction) => void) | null = null;
  private _mediaControlsEnabled: boolean = false;
  private _onContextMenuActorChanged:
    | ((actor: InstanceType<typeof St.Widget> | null) => void)
    | null = null;

  private _icons: Map<string, IconActor> = new Map();
  private _apps: Map<string, Shell.App> = new Map();
  private _favorites: string[] = [];
  private _windowChangeSourceId: number | null = null;
  private _tooltipText: InstanceType<typeof St.Label> | null = null;
  private _contextMenu: ContextMenu | null = null;
  private _contextMenuOpenSourceId: number | null = null;
  private _menuSignals: SignalManager | null = null;
  private _menuManager: MenuManager | null = null;
  private _separator: InstanceType<typeof St.Widget> | null = null;
  private _appButton: InstanceType<typeof St.BoxLayout> | null = null;
  private _appButtonIcon: InstanceType<typeof St.Icon> | null = null;
  private _showAppButton: boolean = true;
  private _appButtonPosition: number = 0;
  private _showRunningApps: boolean = true;
  private _workspaceMode: number = 0; // 0=all, 1=current-only
  private _mediaIndicatorEnabled: boolean = true;
  private _playingAppId: string | null = null;
  private _badgeCounts: Map<string, number> = new Map();
  private _badgeSources: Map<object, number> = new Map();
  private _badgesEnabled: boolean = true;
  /** Folder stacks at the dock's very end (after the minimized windows): which, and their actors. */
  private _stackFolders: StackFolder[] = [];
  private _stackActors: IconActor[] = [];
  private _stackSeparator: InstanceType<typeof St.Widget> | null = null;
  private _stackMenu: ContextMenu | null = null;
  private _windowPreviewsEnabled: boolean = false;
  private _previewPopup: WindowPreviewPopup | null = null;
  private _onDragStateChanged: DragStateChanged | null = null;
  private _dragReorderEnabled: boolean = true;
  private _dragging: boolean = false;
  private _dragSlot: DragSlot | null = null;
  private _pressedAppId: string | null = null;
  private _dropIndicator: InstanceType<typeof St.Widget> | null = null;
  private _dropTarget: DropTarget | null = null;
  private _favoriteSettings: Gio.Settings | null = null;
  private _pendingReload: boolean = false;
  /** Minimized windows sit at the end of the dock as thumbnails (macOS-style), not in their app's icon. */
  private _minimizedEnabled: boolean = true;
  private _minSeparator: InstanceType<typeof St.Widget> | null = null;
  private _minItems: Map<number, MinItem> = new Map();
  private _pendingReloadSourceId: number | null = null;

  /** Gap between icons, mirrors the `spacing` declared in _applyDockStyle. */
  private _spacing = 6;
  private _iconStyle = "plain";
  private _iconColor = "original";
  private _themeResolver: ThemeResolver | null = null;
  private _appButtonIconName = "view-app-grid-symbolic";
  private static readonly DROP_INDICATOR_THICKNESS = 3;
  private static readonly DROP_INDICATOR_LENGTH = 32;
  private static readonly DROP_ZONE_PADDING = 8;

  constructor(
    container: InstanceType<typeof St.BoxLayout>,
    iconSize: number,
    runningIndicatorsEnabled: boolean,
    _quality: number = 2,
    magnificationScale: number = 1,
    indicatorStyle: number = 0,
  ) {
    this._signals = new SignalManager();
    this._container = container;
    this._iconSize = iconSize;
    this._runningIndicatorsEnabled = runningIndicatorsEnabled;
    this._quality = _quality;
    this._magnificationScale = magnificationScale;
    this._indicatorStyle = indicatorStyle;
  }

  setOnClicked(callback: DockIconClicked): void {
    this._onClicked = callback;
  }

  setOnIconsChanged(callback: IconsChanged): void {
    this._onIconsChanged = callback;
  }

  setOnMediaAction(callback: (action: MediaAction) => void): void {
    this._onMediaAction = callback;
  }

  setMediaControlsEnabled(enabled: boolean): void {
    this._mediaControlsEnabled = enabled;
  }

  setOnContextMenuActorChanged(
    callback: (actor: InstanceType<typeof St.Widget> | null) => void,
  ): void {
    this._onContextMenuActorChanged = callback;
  }

  setOnDragStateChanged(callback: DragStateChanged): void {
    this._onDragStateChanged = callback;
  }

  setDragReorderEnabled(enabled: boolean): void {
    if (this._dragReorderEnabled === enabled) return;
    this._dragReorderEnabled = enabled;
    // If a drag is in flight the drop target now refuses it (NO_DROP), so the
    // reload is simply deferred until the drag settles.
    this._reload();
  }

  setIconSize(size: number): void {
    for (const actor of this._icons.values()) {
      const data = this._getStored(actor);
      if (data?.overview) {
        data.overview.widget.destroy();
        data.overview = null;
        data.icon.show();
      }
    }
    this._iconSize = size;
    for (const actor of this._icons.values()) {
      this._applyIconSize(actor);
    }
    if (this._appButton && this._appButtonIcon) {
      this._appButtonIcon.set_icon_size(this._iconSize);
      const padded = this._iconSize + 12;
      this._appButton.set_size(padded, padded - 4);
    }
    for (const actor of this._stackActors) {
      actor.set_size(this._iconSize + 12, this._iconSize + 12 - 4);
      (actor.get_first_child() as InstanceType<typeof St.Icon> | null)?.set_icon_size(
        this._iconSize,
      );
    }
    this._syncOverviewIcons();
  }

  setQuality(quality: number): void {
    this._quality = quality;
    this._refreshIconResolution();
  }

  setMagnificationScale(scale: number): void {
    this._magnificationScale = scale;
    this._refreshIconResolution();
  }

  refreshResourceScale(): void {
    this._refreshIconResolution();
  }

  private _getTextureMultiplier(): number {
    const quality = Math.max(1, this._quality);
    const resourceScale = Math.max(1, this._resourceScale);
    const magnificationScale = Math.max(1, this._magnificationScale);
    // Quality is expressed in physical-resolution multiples. Keep it
    // distinct from the automatic magnification floor: on a 2x display,
    // quality 1x and magnification 2x require 4x logical source resolution,
    // while quality 4x must still request 8x to have an observable effect.
    return resourceScale * Math.max(quality, magnificationScale);
  }

  private _getTextureSize(): number {
    return Math.max(1, Math.ceil(this._iconSize * this._getTextureMultiplier()));
  }

  /**
   * Use Shell.App's icon pipeline instead of constructing St.Icon from the
   * desktop-file GIcon. The Shell pipeline selects the correct themed asset
   * and scale before returning the texture, just like the stock GNOME dash.
   */
  private _createIconTexture(app: Shell.App): InstanceType<typeof St.Icon> {
    const inner = this._innerSize();
    const themed = this._themedGicon(app);
    const icon = (
      themed
        ? new St.Icon({ gicon: themed, icon_size: Math.ceil(inner * this._getTextureMultiplier()) })
        : app.create_icon_texture(this._getTextureSize())
    ) as InstanceType<typeof St.Icon>;
    icon.set_size(inner, inner);
    icon.add_style_class_name("dock-icon-gicon");
    icon.x_align = Clutter.ActorAlign.CENTER;
    icon.y_align = Clutter.ActorAlign.CENTER;
    return icon;
  }

  private _refreshIconResolution(): void {
    this._resourceScale = this._container.get_resource_scale();
    for (const actor of this._icons.values()) {
      this._applyIconSize(actor);
    }
  }

  setIndicatorStyle(style: number): void {
    this._indicatorStyle = style;
    this._refreshAllIndicators();
  }

  setRunningIndicatorsEnabled(enabled: boolean): void {
    this._runningIndicatorsEnabled = enabled;
    for (const [appId, actor] of this._icons.entries()) {
      this._refreshRunningIndicator(actor, appId);
    }
  }

  setShowAppButton(show: boolean): void {
    this._showAppButton = show;
    this._updateAppButton();
  }

  setAppButtonPosition(position: number): void {
    this._appButtonPosition = position === 1 ? 1 : 0;
    this._positionAppButton();
  }

  setShowRunningApps(enabled: boolean): void {
    this._showRunningApps = enabled;
    this._reload();
  }

  /** Minimized windows as thumbnails at the dock's end (true), or only in their app's icon as GNOME has it. */
  setMinimizedInDock(enabled: boolean): void {
    if (enabled === this._minimizedEnabled) return;
    this._minimizedEnabled = enabled;
    this._reload();
  }

  isMinimizedInDock(): boolean {
    return this._minimizedEnabled;
  }

  setWorkspaceMode(mode: number): void {
    this._workspaceMode = mode;
    this._reload();
  }

  reload(): void {
    this._reload();
  }

  setMediaIndicatorEnabled(enabled: boolean): void {
    this._mediaIndicatorEnabled = enabled;
    this._refreshAllMediaIndicators();
  }

  setPlayingApp(appId: string | null): void {
    this._playingAppId = appId;
    this._refreshAllMediaIndicators();
  }

  setPreviewPopup(popup: WindowPreviewPopup): void {
    this._previewPopup = popup;
  }

  setWindowPreviewsEnabled(enabled: boolean): void {
    this._windowPreviewsEnabled = enabled;
  }

  start(): void {
    this._refreshIconResolution();
    const appSystem = Shell.AppSystem.get_default();

    this._signals.connect(appSystem, "installed-changed", () => this._reload());

    const tracker = Shell.WindowTracker.get_default();
    this._signals.connect(tracker, "notify::focus-app", () => this._refreshAllIndicators());

    this._signals.connect(global.display, "window-created", () => this._onWindowChange());

    this._signals.connect(global.display, "window-entered-monitor", () => this._onWindowChange());

    this._signals.connect(global.display, "window-left-monitor", () => this._onWindowChange());

    // Initialize tooltip - add to top chrome layer like the dock
    this._tooltipText = new St.Label({
      style_class: "dock-tooltip",
      text: "",
      visible: false,
    });
    Main.layoutManager.addTopChrome(this._tooltipText);

    this._menuManager = new PopupMenu.PopupMenuManager(this._container);

    // Favorites are the single source of truth for pinned-icon order.
    this._favoriteSettings = new Gio.Settings({ schema: "org.gnome.shell" });
    this._signals.connect(this._favoriteSettings, "changed::favorite-apps", () =>
      this._onFavoritesChangedExternally(),
    );

    // The dock container is the drop target; the picked actor's ancestors are
    // walked by the DND framework until one exposes these methods.
    this._dropTarget = {
      handleDragOver: (source, dragActor, x, y, time) =>
        this._handleDragOver(source, dragActor, x, y, time),
      acceptDrop: (source, dragActor, x, y, time) =>
        this._acceptDrop(source, dragActor, x, y, time),
    };
    (this._container as unknown as Record<string, unknown>)._delegate = this._dropTarget;

    this._watchNotifications();
    this._reload();
  }

  setBadgesEnabled(enabled: boolean): void {
    this._badgesEnabled = enabled;
    this._refreshAllBadges();
  }

  /** Follows the notification tray: a count per application, shown on its icon. */
  private _watchNotifications(): void {
    const tray = Main.messageTray;
    if (!tray) return;
    const watch = (source: object) => {
      if (this._badgeSources.has(source)) return;
      const id = this._signals.connect(
        source as InstanceType<typeof St.Widget>,
        "notify::count",
        () => this._recountBadges(),
      );
      this._badgeSources.set(source, id);
    };
    for (const source of tray.getSources()) watch(source);
    this._signals.connect(tray, "source-added", (_t, source) => {
      watch(source as object);
      this._recountBadges();
    });
    this._signals.connect(tray, "source-removed", (_t, source) => {
      this._badgeSources.delete(source as object);
      this._recountBadges();
    });
    this._recountBadges();
  }

  private _recountBadges(): void {
    this._badgeCounts.clear();
    for (const source of Main.messageTray.getSources()) {
      const app = (source as { app?: Shell.App | null }).app;
      const id = app?.get_id?.();
      const count = (source as { count?: number }).count ?? 0;
      if (id && count > 0) this._badgeCounts.set(id, (this._badgeCounts.get(id) ?? 0) + count);
    }
    this._refreshAllBadges();
  }

  private _refreshAllBadges(): void {
    for (const actor of this._icons.values()) {
      const data = this._getStored(actor);
      if (data) this._refreshBadge(data);
    }
  }

  private _refreshBadge(data: AppData): void {
    const count = this._badgesEnabled ? (this._badgeCounts.get(data.appId) ?? 0) : 0;
    if (count === 0) {
      if (data.badge) {
        data.iconWrapper.remove_child(data.badge);
        data.badge.destroy();
        data.badge = null;
      }
      return;
    }
    const text = count > 99 ? "99+" : String(count);
    if (!data.badge) {
      data.badge = new St.Label({
        style_class: "dock-notification-badge",
        y_align: Clutter.ActorAlign.CENTER,
      });
      data.iconWrapper.add_child(data.badge);
    }
    data.badge.text = text;
    // The top-left corner: the media note takes the top-right, so both can show.
    data.badge.set_position(-4, -4);
  }

  stop(): void {
    if (this._windowChangeSourceId !== null) {
      GLib.source_remove(this._windowChangeSourceId);
      this._windowChangeSourceId = null;
    }

    this._signals.disconnectAll();
    this._badgeSources.clear();
    this._badgeCounts.clear();

    this._hideTooltip();
    if (this._tooltipText) {
      Main.layoutManager.removeChrome(this._tooltipText);
      this._tooltipText.destroy();
      this._tooltipText = null;
    }

    this._closeContextMenu();
    this._closeStackMenu();
    this._menuManager = null;

    this._teardownDraggables();
    this._removeDropIndicator();
    this._dropTarget = null;
    (this._container as unknown as Record<string, unknown>)._delegate = null;
    this._favoriteSettings = null;
    this._dragging = false;
    this._dragSlot = null;
    this._pressedAppId = null;
    this._pendingReload = false;
    this._removePendingReloadSource();

    // Destroy instead of merely detaching. The icon being dragged lives in
    // the UI group, not in the container, so it has to be destroyed here too:
    // that is what makes the DND framework release its modal grab, which it
    // otherwise holds until the actor is garbage collected.
    for (const actor of this._icons.values()) {
      if (actor.get_parent()) actor.destroy();
    }
    for (const child of this._container.get_children()) child.destroy();
    this._icons.clear();
    this._apps.clear();
    this._favorites = [];
    this._separator = null;
    this._appButton = null;
    this._appButtonIcon = null;
    this._minSeparator = null;
    this._stackActors = [];
    this._stackSeparator = null;
    this._minItems.clear();
  }

  /**
   * Get the visible icon actors in the dock, in display order. Used by
   * the magnification animator to map pointer X to a focal index.
   */
  getIconActors(): IconActor[] {
    const result: IconActor[] = [];
    const children = this._container.get_children() as IconActor[];
    for (const child of children) {
      result.push(child);
    }
    return result;
  }

  getIconCount(): number {
    return this._icons.size;
  }

  hasSeparator(): boolean {
    return this._separator !== null;
  }

  hasAppButton(): boolean {
    return this._appButton !== null;
  }

  /**
   * Trigger a macOS-style "bounce" animation on the icon for a given app,
   * used to draw the user's attention when an app is launched.
   */
  getIconActor(app: Shell.App): IconActor | null {
    return this._icons.get(app.get_id()) ?? null;
  }

  bounceForApp(app: Shell.App): void {
    const appId = app.get_id();
    const actor = this._icons.get(appId);
    if (!actor) return;
    this._bounce(actor);
  }

  private _reload(): void {
    if (this._dragging) {
      // Rebuilding the container mid-drag would destroy the drag actor; the
      // dock is stable enough to survive until the drag settles.
      this._pendingReload = true;
      return;
    }
    this._pendingReload = false;
    this._removePendingReloadSource();
    this._teardownDraggables();
    this._removeDropIndicator();
    // The stacks go first: the icons are placed before what is counted at the end.
    this._clearStacks();
    this._container.remove_all_children();
    this._icons.clear();
    this._apps.clear();
    this._separator = null;
    this._appButton = null;
    this._minSeparator = null;
    this._minItems.clear();

    this._favorites = this._readFavorites();

    const appSystem = Shell.AppSystem.get_default();

    // Add favorites in their stored order first.
    for (const appId of this._favorites) {
      const app = appSystem.lookup_app(appId);
      if (!app) continue;
      this._addIcon(app);
    }

    // Get running apps that aren't favorites
    const runningApps = this._showRunningApps
      ? this._getRunningApps().filter((app) => !this._favorites.includes(app.get_id()))
      : [];

    // Add separator if there are both favorites and running apps
    if (this._favorites.length > 0 && runningApps.length > 0) {
      this._addSeparator();
    }

    // Then any running app that isn't already a favorite.
    for (const app of runningApps) {
      this._addIcon(app);
    }

    // Add applications button at the end
    this._updateAppButton();
    this._positionAppButton();
    this._syncStacks();
    this.syncMinimized(false);
  }

  private _onWindowChange(): void {
    // Remove any existing timeout before creating a new one.
    if (this._windowChangeSourceId !== null) {
      GLib.source_remove(this._windowChangeSourceId);
    }

    // Delay to ensure window is fully initialized before checking.
    this._windowChangeSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      this._doWindowChange();
      this._windowChangeSourceId = null;
      return GLib.SOURCE_REMOVE;
    });
  }

  private _doWindowChange(): void {
    // Track which apps are running right now. We add/remove icons as
    // needed so non-favorite running apps still appear (and disappear
    // when their last window closes).
    const runningIds = new Set<string>();
    for (const app of this._getRunningApps()) {
      runningIds.add(app.get_id());
    }

    let changed = false;
    const toRemove: string[] = [];

    // Remove icons for apps that are no longer running and aren't favorites,
    // or all non-favorite running apps if show-running-apps is disabled.
    for (const [id, actor] of this._icons.entries()) {
      const isFavorite = this._favorites.includes(id);
      if (isFavorite) continue;
      if (!this._showRunningApps || !runningIds.has(id)) {
        toRemove.push(id);
        const easeOut = (params: Record<string, unknown>) =>
          actor.ease(params as Parameters<typeof actor.ease>[0]);
        easeOut({
          opacity: 0,
          scale_x: 0.8,
          scale_y: 0.8,
          duration: 200,
          mode: Clutter.AnimationMode.EASE_IN_QUAD,
          onComplete: () => {
            this._container.remove_child(actor);
          },
        });
        changed = true;
      }
    }

    // Clean up references after animation
    for (const id of toRemove) {
      this._icons.delete(id);
      this._apps.delete(id);
    }

    // Add icons for newly running, non-favorited apps (only if enabled).
    if (this._showRunningApps) {
      for (const id of runningIds) {
        if (this._icons.has(id)) continue;
        if (this._favorites.includes(id)) continue;
        const appSystem = Shell.AppSystem.get_default();
        const app = appSystem.lookup_app(id);
        if (!app) continue;
        this._addIcon(app);
        // New running app: pops in like macOS (grows from small, slight overshoot).
        const fresh = this._icons.get(id);
        if (fresh) {
          fresh.set_pivot_point(0.5, 1.0);
          fresh.set({ opacity: 0, scale_x: 0.2, scale_y: 0.2 });
          const easeIn = (params: Record<string, unknown>) =>
            (fresh as unknown as { ease(p: Record<string, unknown>): void }).ease(params);
          easeIn({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: 320,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
          });
        }
        changed = true;
      }
    }

    // Update separator visibility
    this._updateSeparator();
    this._syncOverviewIcons();

    this._refreshAllIndicators();

    // Notify dock to resize when icons were added/removed.
    if (changed && this._onIconsChanged) this._onIconsChanged();
  }

  private _updateSeparator(): void {
    if (!this._showRunningApps) {
      if (this._separator) {
        this._separator.destroy();
        this._separator = null;
      }
      return;
    }

    // Count non-favorite running apps
    const runningNonFavorites = this._getRunningApps().filter(
      (app) => !this._favorites.includes(app.get_id()),
    );

    const hasFavorites = this._favorites.length > 0;
    const hasRunningNonFavorites = runningNonFavorites.length > 0;

    // Add separator if needed
    if (hasFavorites && hasRunningNonFavorites && !this._separator) {
      this._addSeparator();
    }
    // Remove separator if not needed
    else if ((!hasFavorites || !hasRunningNonFavorites) && this._separator) {
      this._separator.destroy();
      this._separator = null;
    }
  }

  private _addIcon(app: Shell.App): void {
    const appId = app.get_id();
    if (this._icons.has(appId)) return;

    const actor = new St.BoxLayout({
      style_class: "dock-icon",
      reactive: true,
      track_hover: true,
      ...box(true),
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.FILL,
    }) as IconActor;

    this._applyIconSize(actor);

    const icon = this._createIconTexture(app);

    const iconWrapper = new St.Widget({
      style_class: "dock-icon-wrapper",
      layout_manager: new Clutter.FixedLayout(),
      x_align: Clutter.ActorAlign.CENTER,
      width: this._iconSize,
      height: this._iconSize,
    });
    icon.set_position(0, 0);
    iconWrapper.add_child(icon);

    actor.add_child(iconWrapper);

    // Container for running indicator dots (or a single bar).
    const indicatorBox = new St.BoxLayout({
      style_class: "dock-indicator-box",
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    actor.add_child(indicatorBox);

    // Store references on the actor for retrieval later.
    const appData: AppData = {
      appId,
      icon,
      iconWrapper,
      indicatorBox,
      dots: [],
      mediaIndicator: null,
      badge: null,
      overview: null,
      draggable: null,
      dragSignalIds: [],
    };
    (actor as unknown as Record<string, unknown>)._appData = appData;
    this._decorateIcon(appData);
    this._refreshBadge(appData);

    this._signals.connect(actor, "button-press-event", (_actor, event) => {
      const button = (event as { get_button: () => number }).get_button();
      if (button === 3) {
        this._showContextMenu(actor, app);
        return Clutter.EVENT_STOP;
      }
      if (button !== 1) {
        return Clutter.EVENT_PROPAGATE;
      }
      // Arm the click only. Activation happens on release so a press that
      // turns into a drag-reorder never launches the app. Propagate so the
      // DND framework's own press handler still runs.
      this._pressedAppId = appId;
      return Clutter.EVENT_PROPAGATE;
    });

    this._signals.connect(actor, "button-release-event", (_actor, event) => {
      const button = (event as { get_button: () => number }).get_button();
      if (button !== 1) {
        return Clutter.EVENT_PROPAGATE;
      }
      const pressed = this._pressedAppId;
      this._pressedAppId = null;
      if (this._dragging) return Clutter.EVENT_PROPAGATE;
      if (!pressed || pressed !== appId) return Clutter.EVENT_PROPAGATE;
      if (!this._isPointerOver(actor)) return Clutter.EVENT_PROPAGATE;
      if (this._onClicked) {
        this._onClicked(app);
      }
      return Clutter.EVENT_PROPAGATE;
    });

    // Tooltip events - use notify::hover since track_hover is enabled
    this._signals.connect(actor, "notify::hover", () => {
      if (this._dragging) {
        // Keep tooltips and previews out of the way while reordering.
        this._hideTooltip();
        if (this._previewPopup?.isVisible()) this._previewPopup.hide();
        return Clutter.EVENT_PROPAGATE;
      }
      if (actor.hover) {
        this._showTooltip(actor, app.get_name());
        // Show window preview popup
        if (this._windowPreviewsEnabled && this._previewPopup) {
          this._previewPopup.cancelScheduledHide();
          this._previewPopup.show(app, actor);
        }
      } else {
        this._hideTooltip();
        // Schedule hide of preview popup (delay allows mouse to move to popup).
        // Not gated on isVisible(): that only turns true once the fade-in
        // finishes, so a quick pass over the icon would leave the popup stuck.
        this._previewPopup?.scheduleHide();
      }
      return Clutter.EVENT_PROPAGATE;
    });

    // Before the minimized windows, which stay at the end.
    this._container.insert_child_at_index(
      actor,
      this._container.get_n_children() - this._tailCount(),
    );
    this._icons.set(appId, actor);
    // GNOME takes every actor down as the shell shuts down, before this runs again: a destroyed icon is let go at once, so the timers
    // that walk the icons do not touch it.
    actor.connect("destroy", () => {
      if (this._icons.get(appId) === actor) {
        this._icons.delete(appId);
        this._apps.delete(appId);
      }
    });
    this._apps.set(appId, app);
    this._positionAppButton();

    if (this._dragReorderEnabled && this._favorites.includes(appId)) {
      this._makeDraggable(actor, appId);
    }

    // Animate icon appearing (fade in + scale)
    // Note: scale_x/scale_y are the correct GJS property names (snake_case),
    // even though TypeScript types expect camelCase (scaleX/scaleY).
    actor.opacity = 0;
    actor.scale_x = 0.8;
    actor.scale_y = 0.8;
    const easeIn = (params: Record<string, unknown>) =>
      actor.ease(params as Parameters<typeof actor.ease>[0]);
    easeIn({
      opacity: 255,
      scale_x: 1.0,
      scale_y: 1.0,
      duration: 200,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });

    this._refreshRunningIndicator(actor, appId);

    // Notify dock to resize.
    if (this._onIconsChanged) this._onIconsChanged();
  }

  private _applyIconSize(actor: IconActor): void {
    const data = this._getStored(actor);
    if (data) {
      const app = this._apps.get(data.appId);
      if (app) {
        // Recreate the texture so Shell.App reloads the icon at the new
        // resolution. Changing St.Icon:icon-size alone can leave the old
        // cached texture in place, which makes icon-quality appear inert.
        const oldIcon = data.icon;
        const icon = this._createIconTexture(app);
        data.iconWrapper.remove_child(oldIcon);
        oldIcon.destroy();
        data.iconWrapper.add_child(icon);
        data.icon = icon;
        this._decorateIcon(data);
      } else {
        data.icon.set_size(this._iconSize, this._iconSize);
      }
      data.iconWrapper.set_size(this._iconSize, this._iconSize);
      if (data.mediaIndicator) {
        this._positionMediaIndicator(data.mediaIndicator);
      }
    }
    const padded = this._iconSize + 12;
    actor.set_size(padded, padded - 4);
  }

  private _positionMediaIndicator(indicator: InstanceType<typeof St.Widget>): void {
    const badgeSize = IconManager.MEDIA_BADGE_SIZE;
    const inset = IconManager.MEDIA_BADGE_INSET;
    indicator.set_size(badgeSize, badgeSize);
    indicator.set_position(this._iconSize - badgeSize + inset, -inset);
  }

  private _refreshAllIndicators(): void {
    for (const [appId, actor] of this._icons.entries()) {
      this._refreshRunningIndicator(actor, appId);
    }
  }

  private _refreshAllMediaIndicators(): void {
    for (const [appId, actor] of this._icons.entries()) {
      this._refreshMediaIndicator(actor, appId);
    }
  }

  private _refreshMediaIndicator(actor: IconActor, appId: string): void {
    const data = this._getStored(actor);
    if (!data) return;

    const isPlaying = this._mediaIndicatorEnabled && this._playingAppId === appId;

    if (isPlaying && !data.mediaIndicator) {
      const badge = new St.Widget({
        style_class: "dock-media-indicator",
        layout_manager: new Clutter.BinLayout(),
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });
      const noteIcon = new St.Icon({
        icon_name: "folder-music-symbolic",
        icon_size: 8,
        style_class: "dock-media-indicator-icon",
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });
      badge.add_child(noteIcon);
      this._positionMediaIndicator(badge);
      data.iconWrapper.add_child(badge);
      data.mediaIndicator = badge;
    } else if (!isPlaying && data.mediaIndicator) {
      data.iconWrapper.remove_child(data.mediaIndicator);
      data.mediaIndicator.destroy();
      data.mediaIndicator = null;
    }
  }

  private _refreshRunningIndicator(actor: IconActor, appId: string): void {
    const data = this._getStored(actor);
    if (!data) return;
    const { indicatorBox } = data;
    if (!indicatorBox) return;

    if (!this._runningIndicatorsEnabled) {
      indicatorBox.visible = false;
      return;
    }

    const tracker = Shell.WindowTracker.get_default();
    const app = this._apps.get(appId);
    if (!app) {
      indicatorBox.visible = false;
      return;
    }

    // Count all windows for this app (including minimized).
    let windowCount = 0;
    const actors = global.get_window_actors();
    for (const wa of actors) {
      const mw = wa.get_meta_window();
      if (!mw) continue;
      if (tracker.get_window_app(mw) === app) {
        windowCount++;
      }
    }
    const focused = tracker.focus_app === app;
    const isRunning = windowCount > 0 || focused;

    if (!isRunning) {
      indicatorBox.visible = false;
      return;
    }

    indicatorBox.visible = true;

    // Clear all children before adding new style.
    indicatorBox.remove_all_children();

    if (this._indicatorStyle === 0) {
      // Dots per window (macOS style).
      const needed = focused ? Math.max(windowCount, 1) : windowCount;

      // Add or remove dots to match window count.
      while (indicatorBox.get_n_children() < needed) {
        const dot = new St.Widget({
          style_class: "dock-indicator-dot",
        });
        indicatorBox.add_child(dot);
      }
      while (indicatorBox.get_n_children() > needed) {
        const last = indicatorBox.get_n_children() - 1;
        (indicatorBox.get_child_at_index(last) as InstanceType<typeof St.Widget>).destroy();
      }
    } else {
      // Horizontal bar style.
      const bar = new St.Widget({
        style_class: "dock-indicator-bar",
      });
      indicatorBox.add_child(bar);
    }
  }

  private _getRunningApps(): Shell.App[] {
    const tracker = Shell.WindowTracker.get_default();
    const seen = new Set<string>();
    const result: Shell.App[] = [];
    const windows = global.get_window_actors();
    const activeWorkspace = global.workspace_manager.get_active_workspace();
    for (const wa of windows) {
      const metaWin = wa.get_meta_window();
      if (!metaWin) continue;
      if (!metaWin.showing_on_its_workspace() && !(this._minimizedEnabled && metaWin.minimized))
        continue;
      if (this._workspaceMode === 1 && metaWin.get_workspace() !== activeWorkspace) continue;
      const app = tracker.get_window_app(metaWin);
      if (!app) continue;
      const id = app.get_id();
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(app);
    }
    return result;
  }

  private _readFavorites(): string[] {
    const settings = this._favoriteSettings ?? new Gio.Settings({ schema: "org.gnome.shell" });
    return settings.get_strv("favorite-apps");
  }

  /**
   * Pinned icon actors currently in the container, in display order. The icon
   * being dragged is excluded automatically because the DND framework
   * reparents it to the UI group while a drag is in flight.
   */
  private _favoriteActors(): IconActor[] {
    const result: IconActor[] = [];
    for (const child of this._container.get_children()) {
      const data = this._getStored(child as IconActor);
      if (data && this._favorites.includes(data.appId)) {
        result.push(child as IconActor);
      }
    }
    return result;
  }

  private _makeDraggable(actor: IconActor, appId: string): void {
    const data = this._getStored(actor);
    if (!data) return;

    (actor as unknown as Record<string, unknown>)._delegate = {
      appId,
      isFavorite: true,
    } satisfies DragSource;

    const draggable = DND.makeDraggable(actor, { dragActorOpacity: 200 });
    const signalIds = [
      draggable.connect("drag-begin", () => this._onDragBegin(appId)),
      draggable.connect("drag-cancelled", () => this._removeDropIndicator()),
      draggable.connect("drag-end", (_self, _time: number, success: boolean) =>
        this._onDragEnd(appId, success),
      ),
    ];

    data.draggable = draggable;
    data.dragSignalIds = signalIds;
  }

  private _teardownDraggables(): void {
    for (const actor of this._icons.values()) {
      const data = this._getStored(actor);
      if (data?.draggable) {
        for (const id of data.dragSignalIds) data.draggable.disconnect(id);
        data.draggable = null;
        data.dragSignalIds = [];
      }
      const record = actor as unknown as Record<string, unknown>;
      if (record._delegate) record._delegate = null;
    }
  }

  private _onDragBegin(appId: string): void {
    this._dragging = true;
    this._dragSlot = this._captureSlot(appId);
    this._pressedAppId = null;
    this._hideTooltip();
    this._previewPopup?.cancelScheduledHide();
    this._previewPopup?.hide();
    this._onDragStateChanged?.(true);
  }

  /**
   * Read the container-local rectangle of a pinned icon. Called from
   * `drag-begin`, which the DND framework emits before it lifts the actor
   * out of the container, so the slot is still measurable.
   */
  private _captureSlot(appId: string): DragSlot | null {
    const actor = this._icons.get(appId);
    if (!actor || actor.get_parent() !== this._container) return null;
    const [x, y] = actor.get_position();
    const [w, h] = actor.get_size();
    return { x, y, w, h };
  }

  private _onDragEnd(appId: string, success: boolean): void {
    this._dragging = false;
    this._dragSlot = null;
    this._pressedAppId = null;
    this._removeDropIndicator();

    const actor = this._icons.get(appId);
    if (actor) {
      // The DND framework leaves drag-time styling to the drop target on
      // success, and its snap-back restores scale but not the fixed position
      // it took over while dragging under the pointer.
      actor.opacity = 255;
      actor.scale_x = 1;
      actor.scale_y = 1;
      actor.fixed_position_set = false;
      this._applyIconSize(actor);
    }
    if (!success) {
      // A cancelled drop re-adds the icon at the end of the container; put it
      // back where the stored favorites order says it belongs.
      this._restoreFavoriteSlot(appId);
    }

    this._onDragStateChanged?.(false);

    if (this._pendingReload) {
      this._pendingReload = false;
      // Deferred: the DND framework still owns the drag actor until it
      // finishes emitting drag-end, so rebuild on the next idle slice.
      this._removePendingReloadSource();
      this._pendingReloadSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        this._pendingReloadSourceId = null;
        this._reload();
        return GLib.SOURCE_REMOVE;
      });
    }
  }

  private _removePendingReloadSource(): void {
    if (this._pendingReloadSourceId !== null) {
      GLib.source_remove(this._pendingReloadSourceId);
      this._pendingReloadSourceId = null;
    }
  }

  private _restoreFavoriteSlot(appId: string): void {
    const actor = this._icons.get(appId);
    if (!actor || actor.get_parent() !== this._container) return;

    // A cancelled drop re-appends the icon at the end of the container.
    // Recompute its slot from the stored order rather than from the current
    // child order, which the append has just disturbed.
    const positionInFavorites = this._favorites.indexOf(appId);
    if (positionInFavorites < 0) return;
    let desired = 0;
    for (let i = 0; i < positionInFavorites; i++) {
      if (this._icons.has(this._favorites[i])) desired++;
    }

    const current = this._container.get_children().indexOf(actor);
    if (current === desired) return;

    this._container.remove_child(actor);
    this._container.insert_child_at_index(actor, desired);
    this._positionAppButton();
  }

  private _handleDragOver(
    source: DragSource | null,
    _dragActor: Clutter.Actor,
    x: number,
    y: number,
    _time: number,
  ): number {
    if (!source?.isFavorite) {
      // Not a source we created. CONTINUE lets the DND framework keep walking
      // up the target chain instead of pinning a foreign drag to this dock.
      this._removeDropIndicator();
      return DND.DragMotionResult.CONTINUE;
    }
    if (!this._dragReorderEnabled || !this._favorites.includes(source.appId)) {
      this._removeDropIndicator();
      return DND.DragMotionResult.NO_DROP;
    }

    const index = this._calcDropIndex(x, y);
    if (index < 0) {
      this._removeDropIndicator();
      return DND.DragMotionResult.NO_DROP;
    }

    this._showDropIndicator(index);
    return DND.DragMotionResult.MOVE_DROP;
  }

  private _acceptDrop(
    source: DragSource | null,
    dragActor: Clutter.Actor,
    x: number,
    y: number,
    _time: number,
  ): boolean {
    if (!this._dragReorderEnabled || !source?.isFavorite) return false;
    if (!this._favorites.includes(source.appId)) return false;

    const actor = this._icons.get(source.appId);
    if (!actor || actor !== dragActor) return false;

    const index = this._calcDropIndex(x, y);
    if (index < 0) return false;

    // Map the drop slot (computed over the visible pinned icons) back onto the
    // stored favorites list so entries without a rendered actor survive.
    const present = this._favoriteActors()
      .map((a) => this._getStored(a)?.appId)
      .filter((id): id is string => !!id && id !== source.appId);
    const beforeId = index < present.length ? present[index] : null;

    const order = this._favorites.filter((id) => id !== source.appId);
    const at = beforeId ? order.indexOf(beforeId) : order.length;
    if (at < 0) {
      order.push(source.appId);
    } else {
      order.splice(at, 0, source.appId);
    }

    const previous = this._favorites;
    this._favorites = order;
    if (!this._writeFavorites(order)) {
      this._favorites = previous;
      return false;
    }

    this._reorderFavoriteActors(order);
    this._removeDropIndicator();

    // Undo the drag-time styling applied by the DND framework: it lifts the
    // icon into the UI group, pins an explicit position under the pointer and
    // drops the opacity. Reparenting alone does not restore any of that.
    actor.fixed_position_set = false;
    actor.opacity = 255;
    actor.scale_x = 1;
    actor.scale_y = 1;
    this._applyIconSize(actor);
    return true;
  }

  private _isVerticalLayout(): boolean {
    const box = this._container as unknown as { orientation?: number; vertical?: boolean };
    if (box.orientation !== undefined) return box.orientation === Clutter.Orientation.VERTICAL;
    return box.vertical === true;
  }

  /**
   * Insertion slot for a pointer position given in container-local
   * coordinates, or -1 when the pointer is outside the pinned area.
   */
  private _calcDropIndex(x: number, y: number): number {
    const vertical = this._isVerticalLayout();
    const coord = vertical ? y : x;
    const pad = IconManager.DROP_ZONE_PADDING;

    const favs = this._favoriteActors();
    if (favs.length === 0) {
      // The dragged icon is the only pinned one, so the container has no
      // sibling left to measure against. Fall back to the slot it was lifted
      // from so the drop is accepted as a no-op rather than snapping back.
      const slot = this._dragSlot;
      if (!slot) return -1;
      const start = (vertical ? slot.y : slot.x) - pad;
      const size = vertical ? slot.h : slot.w;
      if (coord < start || coord > start + size + pad) return -1;
      return 0;
    }

    const first = favs[0];
    const [fx, fy] = first.get_position();
    const last = favs[favs.length - 1];
    const [lx, ly] = last.get_position();
    const [lw, lh] = last.get_size();

    const zoneStart = (vertical ? fy : fx) - pad;
    const zoneEnd = (vertical ? ly + lh : lx + lw) + pad;
    if (coord < zoneStart || coord > zoneEnd) return -1;

    for (let i = 0; i < favs.length; i++) {
      const [px, py] = favs[i].get_position();
      const [pw, ph] = favs[i].get_size();
      const center = vertical ? py + ph / 2 : px + pw / 2;
      if (coord < center) return i;
    }
    return favs.length;
  }

  private _showDropIndicator(index: number): void {
    const vertical = this._isVerticalLayout();
    const halfGap = this._spacing / 2;

    const favs = this._favoriteActors();
    let cross: number;
    let crossSize: number;
    let boundary: number;

    if (favs.length > 0) {
      const n = favs.length;
      const ref = index < n ? favs[index] : favs[n - 1];
      const [rx, ry] = ref.get_position();
      const [rw, rh] = ref.get_size();

      // Slot edge in container-local coordinates (midway through the gap).
      const slotAtEnd = index === n;
      boundary = vertical
        ? slotAtEnd
          ? ry + rh + halfGap
          : ry - halfGap
        : slotAtEnd
          ? rx + rw + halfGap
          : rx - halfGap;
      cross = vertical ? rx : ry;
      crossSize = vertical ? rw : rh;
    } else if (this._dragSlot) {
      // Sole pinned icon: mark the leading edge of the slot it came from.
      const slot = this._dragSlot;
      cross = vertical ? slot.x : slot.y;
      crossSize = vertical ? slot.w : slot.h;
      boundary = vertical ? slot.y - halfGap : slot.x - halfGap;
    } else {
      return;
    }

    if (!this._dropIndicator) {
      this._dropIndicator = new St.Widget({ style_class: "dock-drop-indicator" });
      // Keep the indicator out of stage picking so it can never become the
      // drop target itself.
      Shell.util_set_hidden_from_pick(this._dropIndicator, true);
      Main.layoutManager.addTopChrome(this._dropIndicator);
    }

    const thickness = IconManager.DROP_INDICATOR_THICKNESS;
    const length = Math.max(8, Math.min(IconManager.DROP_INDICATOR_LENGTH, crossSize - 8));
    const [cx, cy] = this._container.get_transformed_position();

    if (vertical) {
      this._dropIndicator.set_size(length, thickness);
      this._dropIndicator.set_position(
        cx + cross + (crossSize - length) / 2,
        cy + boundary - thickness / 2,
      );
    } else {
      this._dropIndicator.set_size(thickness, length);
      this._dropIndicator.set_position(
        cx + boundary - thickness / 2,
        cy + cross + (crossSize - length) / 2,
      );
    }
  }

  private _removeDropIndicator(): void {
    if (!this._dropIndicator) return;
    Main.layoutManager.removeChrome(this._dropIndicator);
    this._dropIndicator.destroy();
    this._dropIndicator = null;
  }

  /** Reparent and reorder pinned icons so the container matches `order`. */
  private _reorderFavoriteActors(order: string[]): void {
    const actors: IconActor[] = [];
    for (const id of order) {
      const actor = this._icons.get(id);
      if (actor) actors.push(actor);
    }

    for (const actor of actors) {
      const parent = actor.get_parent();
      if (parent) parent.remove_child(actor);
    }
    actors.forEach((actor, i) => {
      this._container.insert_child_at_index(actor, i);
    });
    this._positionAppButton();
  }

  private _writeFavorites(order: string[]): boolean {
    if (!this._favoriteSettings) return false;
    return this._favoriteSettings.set_strv("favorite-apps", order);
  }

  private _onFavoritesChangedExternally(): void {
    const order = this._readFavorites();
    const same =
      order.length === this._favorites.length && order.every((id, i) => id === this._favorites[i]);
    if (same) return;
    this._reload();
  }

  private _isPointerOver(actor: IconActor): boolean {
    const [px, py] = global.get_pointer();
    const [ax, ay] = actor.get_transformed_position();
    const [aw, ah] = actor.get_transformed_size();
    return px >= ax && px <= ax + aw && py >= ay && py <= ay + ah;
  }

  private _getStored(actor: IconActor): AppData | null {
    const data = (actor as unknown as Record<string, unknown>)._appData;
    if (!data) return null;
    return data as AppData;
  }

  private _bounce(actor: IconActor): void {
    const baseY = 0;
    const up = -28;
    const small = -10;

    // Note: translation_y is the correct GJS property name (snake_case), even though
    // the TypeScript types expect camelCase (translationY). This is a type definition mismatch.
    const ease = (params: Record<string, unknown>) =>
      actor.ease(params as Parameters<typeof actor.ease>[0]);

    ease({
      translation_y: up,
      duration: 180,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => {
        ease({
          translation_y: baseY,
          duration: 120,
          mode: Clutter.AnimationMode.EASE_IN_QUAD,
          onComplete: () => {
            ease({
              translation_y: small,
              duration: 100,
              mode: Clutter.AnimationMode.EASE_OUT_QUAD,
              onComplete: () => {
                ease({
                  translation_y: baseY,
                  duration: 80,
                  mode: Clutter.AnimationMode.EASE_IN_QUAD,
                });
              },
            });
          },
        });
      },
    });
  }

  private _showTooltip(actor: IconActor, appName: string): void {
    if (!this._tooltipText) return;

    const [x, y] = actor.get_transformed_position();
    const [width] = actor.get_size();

    this._tooltipText.set_text(appName);
    const [, tooltipWidth] = this._tooltipText.get_preferred_width(-1);

    // Position tooltip above the icon, centered
    const tooltipX = x + (width - tooltipWidth) / 2;
    const tooltipY = y - 40; // 40px above the icon

    this._tooltipText.set_position(tooltipX, tooltipY);
    this._tooltipText.show();
  }

  private _hideTooltip(): void {
    if (this._tooltipText) {
      this._tooltipText.hide();
    }
  }

  private _showContextMenu(actor: IconActor, app: Shell.App): void {
    this._closeContextMenu();
    if (!this._menuManager) return;
    const menuManager = this._menuManager;

    const menu = new PopupMenu.PopupMenu(actor, 0.5, St.Side.TOP);
    (menu as unknown as { blockSourceEvents: boolean }).blockSourceEvents = true;
    menu.box.add_style_class_name("dock-popup-menu");
    Main.uiGroup.add_child(menu.actor);
    this._contextMenu = menu;
    this._menuSignals = new SignalManager();

    const menuItems: { label: string; action: () => void }[] = [
      { label: "New Window", action: () => app.open_new_window(-1) },
    ];

    // The app's own quicklist: the actions its .desktop file declares ("New Private Window", "Compose"…).
    const info = app.get_app_info() as unknown as {
      list_actions?: () => string[];
      get_action_name: (action: string) => string | null;
      launch_action: (action: string, context: null) => void;
    } | null;
    if (info && typeof info.list_actions === "function") {
      for (const name of info.list_actions()) {
        const label = info.get_action_name(name);
        if (!label || label === "New Window") continue;
        menuItems.push({ label, action: () => info.launch_action(name, null) });
      }
    }

    if (this._mediaControlsEnabled && this._playingAppId === app.get_id()) {
      menuItems.push({
        label: "Play/Pause",
        action: () => this._onMediaAction?.("play-pause"),
      });
      menuItems.push({
        label: "Next",
        action: () => this._onMediaAction?.("next"),
      });
      menuItems.push({
        label: "Previous",
        action: () => this._onMediaAction?.("previous"),
      });
    }

    menuItems.push({ label: "Close", action: () => this._closeApp(app) });

    for (const item of menuItems) {
      const menuItem = new PopupMenu.PopupMenuItem(item.label);
      this._menuSignals.connect(menuItem, "activate", () => {
        item.action();
        this._closeContextMenu();
      });
      menu.addMenuItem(menuItem);
    }

    this._menuSignals.connect(menu, "open-state-changed", (_source, isOpen) => {
      if (!isOpen) {
        this._finalizeContextMenu();
      }
    });

    menuManager.addMenu(menu);
    this._onContextMenuActorChanged?.(menu.actor);

    this._contextMenuOpenSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      this._contextMenuOpenSourceId = null;
      if (this._contextMenu !== menu) {
        return GLib.SOURCE_REMOVE;
      }
      menu.open(BoxPointer.PopupAnimation.FULL);
      menuManager.ignoreRelease();
      return GLib.SOURCE_REMOVE;
    });
  }

  private _closeContextMenu(): void {
    if (!this._contextMenu) return;
    if (this._contextMenu.isOpen) {
      this._contextMenu.close();
    } else {
      this._finalizeContextMenu();
    }
  }

  private _finalizeContextMenu(): void {
    if (this._contextMenuOpenSourceId !== null) {
      GLib.source_remove(this._contextMenuOpenSourceId);
      this._contextMenuOpenSourceId = null;
    }

    this._onContextMenuActorChanged?.(null);
    if (this._menuSignals) {
      this._menuSignals.disconnectAll();
      this._menuSignals = null;
    }
    if (this._contextMenu) {
      const menu = this._contextMenu;
      this._contextMenu = null;
      this._menuManager?.removeMenu(menu);
      menu.destroy();
    }
  }

  private _closeApp(app: Shell.App): void {
    const windows = app.get_windows();
    for (const window of windows) {
      window.delete(global.get_current_time());
    }
  }

  private _addSeparator(): void {
    if (this._separator) return;

    this._separator = new St.Widget({
      style_class: "dock-separator",
      width: 1,
      height: 32,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });

    // Insert after the last favorite icon, before non-favorite running apps
    let insertIndex = 0;
    for (const [id] of this._icons) {
      if (this._favorites.includes(id)) {
        insertIndex++;
      } else {
        break;
      }
    }
    const appButtonOffset = this._appButton && this._appButtonPosition === 0 ? 1 : 0;
    this._container.insert_child_at_index(this._separator, insertIndex + appButtonOffset);
  }

  private _updateAppButton(): void {
    if (this._showAppButton && !this._appButton) {
      this._addAppButton();
    } else if (!this._showAppButton && this._appButton) {
      this._removeAppButton();
    }
  }

  private _addAppButton(): void {
    if (this._appButton) return;

    const padded = this._iconSize + 12;

    const appButton = new St.BoxLayout({
      style_class: "dock-app-button",
      reactive: true,
      track_hover: true,
      ...box(true),
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.FILL,
      width: padded,
      height: padded - 4,
    });
    this._appButton = appButton;

    this._appButtonIcon = new St.Icon({
      icon_name: this._appButtonIconName,
      icon_size: this._iconSize,
      style_class: "dock-app-button-icon",
    });
    appButton.add_child(this._appButtonIcon);

    this._signals.connect(appButton, "button-press-event", () => {
      if (Main.overview.visible) {
        Main.overview.hide();
      } else {
        Main.overview.showApps();
      }
      return Clutter.EVENT_STOP;
    });

    // Tooltip on hover
    this._signals.connect(appButton, "notify::hover", () => {
      if (appButton.hover) {
        this._showTooltip(appButton, "Applications");
      } else {
        this._hideTooltip();
      }
    });

    this._container.add_child(appButton);
    this._positionAppButton();

    // Notify dock to resize
    if (this._onIconsChanged) this._onIconsChanged();
  }

  private _removeAppButton(): void {
    if (!this._appButton) return;
    this._container.remove_child(this._appButton);
    this._appButton.destroy();
    this._appButton = null;
    this._appButtonIcon = null;

    // Notify dock to resize
    if (this._onIconsChanged) this._onIconsChanged();
  }

  private _positionAppButton(): void {
    if (!this._appButton) return;

    const childCount = this._container.get_n_children();
    const targetIndex = this._appButtonPosition === 0 ? 0 : childCount - 1 - this._tailCount();
    if (this._container.get_child_at_index(targetIndex) === this._appButton) return;

    this._container.set_child_at_index(this._appButton, targetIndex);
  }

  // ---- Look of the icons: size, theme, tile, colour

  /** The icon's own size: all of the slot, or the tile's inside when the icons stand on tiles. */
  private _innerSize(): number {
    return this._iconStyle === "plain" ? this._iconSize : Math.round(this._iconSize * 0.74);
  }

  /** The app's icon from the chosen theme, or null for the desktop's own (no theme chosen, not found there, or a picture of its own). */
  private _themedGicon(app: Shell.App): Gio.Icon | null {
    const resolver = this._themeResolver;
    if (!resolver) return null;
    const icon = app.get_app_info()?.get_icon();
    if (!icon || !(icon as unknown as { get_names?: () => string[] }).get_names) return null;
    const names = (icon as unknown as { get_names(): string[] }).get_names();
    return resolver.lookup(names, Math.ceil(this._innerSize() * this._getTextureMultiplier()));
  }

  setIconTheme(name: string): void {
    const resolver = name ? new ThemeResolver(name) : null;
    this._themeResolver = resolver?.usable ? resolver : null;
    this._refreshIconResolution();
  }

  setIconStyle(style: string): void {
    if (style === this._iconStyle) return;
    this._iconStyle = style;
    this._refreshIconResolution();
  }

  setIconColor(color: string): void {
    this._iconColor = color;
    for (const actor of this._icons.values()) {
      const data = this._getStored(actor);
      if (data) this._decorateIcon(data);
    }
  }

  setIconSpacing(spacing: number): void {
    this._spacing = Math.max(0, spacing);
  }

  setAppButtonIcon(name: string): void {
    this._appButtonIconName = name;
    this._appButtonIcon?.set_icon_name(name);
  }

  /** The tile behind the icon and its colour effect, as the settings say. */
  private _decorateIcon(data: AppData): void {
    const size = this._iconSize;
    const inner = this._innerSize();
    const wrapper = data.iconWrapper;
    switch (this._iconStyle) {
      case "rounded":
        wrapper.style = `border-radius: ${Math.round(size * 0.24)}px; background-color: rgba(255, 255, 255, 0.16); border: 1px solid rgba(255, 255, 255, 0.14);`;
        break;
      case "circle":
        wrapper.style = `border-radius: ${Math.ceil(size / 2)}px; background-color: rgba(255, 255, 255, 0.16); border: 1px solid rgba(255, 255, 255, 0.14);`;
        break;
      case "glass":
        wrapper.style = `border-radius: ${Math.round(size * 0.24)}px; background-color: rgba(255, 255, 255, 0.24); border: 1px solid rgba(255, 255, 255, 0.35); box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.4);`;
        break;
      default:
        wrapper.style = "";
    }
    const offset = Math.round((size - inner) / 2);
    data.icon.set_position(offset, offset);
    for (const widget of [data.icon]) {
      widget.remove_effect_by_name("dock-tone");
      const factor = this._iconColor === "monochrome" ? 1 : this._iconColor === "muted" ? 0.5 : 0;
      if (factor > 0)
        widget.add_effect_with_name("dock-tone", new Clutter.DesaturateEffect({ factor }));
    }
  }

  // ---- Minimized windows, at the dock's end

  /** The window an unpinned `app` shows in its icon's place: one of its windows, when all of them are minimized; else none. */
  private _overviewWindow(app: Shell.App): Meta.Window | null {
    const windows = app.get_windows().filter((win) => !win.skip_taskbar);
    if (windows.length === 0 || !windows.every((win) => win.minimized)) return null;
    return windows[windows.length - 1] ?? null;
  }

  /** Unpinned apps whose windows are all minimized show the overview (a window's thumbnail) as their icon. */
  private _syncOverviewIcons(): void {
    for (const [id, actor] of this._icons) {
      const data = this._getStored(actor);
      const app = this._apps.get(id);
      if (!data || !app) continue;
      const win =
        this._minimizedEnabled && !this._favorites.includes(id) ? this._overviewWindow(app) : null;
      if ((data.overview?.win ?? null) === win) continue;
      if (data.overview) {
        data.overview.widget.destroy();
        data.overview = null;
        data.icon.show();
      }
      if (!win) continue;
      const windowActor = win.get_compositor_private() as Clutter.Actor | null;
      if (!windowActor) continue;
      const size = this._iconSize;
      const widget = new St.Widget({
        style_class: "dock-minimized-thumb",
        layout_manager: new Clutter.FixedLayout(),
        width: size,
        height: size,
        clip_to_allocation: true,
      });
      const [aw, ah] = windowActor.get_size();
      if (aw > 0 && ah > 0) {
        const clone = new Clutter.Clone({ source: windowActor, reactive: false });
        const scale = Math.min(size / aw, size / ah);
        clone.set_scale(scale, scale);
        clone.set_position(
          Math.round((size - aw * scale) / 2),
          Math.round((size - ah * scale) / 2),
        );
        widget.add_child(clone);
      }
      const badgeSize = Math.round(size * 0.4);
      const badge = app.create_icon_texture(badgeSize);
      badge.set_position(size - badgeSize + 2, size - badgeSize + 2);
      widget.add_child(badge);
      widget.set_position(0, 0);
      data.iconWrapper.add_child(widget);
      data.icon.hide();
      data.overview = { win, widget };
    }
  }

  /** How many container children the stacks take at the very end (their separator and one each). */
  private _stackChildCount(): number {
    return (this._stackSeparator ? 1 : 0) + this._stackActors.length;
  }

  /** Everything after the apps: the minimized windows, then the stacks. */
  private _tailCount(): number {
    return this._minChildCount() + this._stackChildCount();
  }

  /** Which folders are stacks; the dock is rebuilt with them. */
  setStackFolders(folders: StackFolder[]): void {
    if (folders.join() === this._stackFolders.join()) return;
    this._stackFolders = folders;
    this._syncStacks();
    if (this._onIconsChanged) this._onIconsChanged();
  }

  /** Total length of the stacks along the dock, separator included, for the dock's size. */
  getStackExtent(): number {
    if (this._stackActors.length === 0) return 0;
    return 9 + this._spacing + this._stackActors.length * (this._iconSize + 12 + this._spacing);
  }

  /** The stacks, put at the very end (after the minimized windows). */
  private _syncStacks(): void {
    this._clearStacks();
    const folders = this._stackFolders.filter((f) => GLib.get_user_special_dir(STACKS[f].dir));
    if (folders.length === 0) return;
    this._stackSeparator = new St.Widget({
      style_class: "dock-separator",
      width: 1,
      height: 32,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._container.add_child(this._stackSeparator);
    for (const folder of folders) {
      const { icon, name } = STACKS[folder];
      const actor = new St.BoxLayout({
        style_class: "dock-icon dock-stack",
        reactive: true,
        track_hover: true,
        ...box(true),
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.FILL,
      }) as IconActor;
      actor.set_size(this._iconSize + 12, this._iconSize + 12 - 4);
      const glyph = new St.Icon({
        icon_name: icon,
        icon_size: this._iconSize,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        y_expand: true,
      });
      actor.add_child(glyph);
      this._signals.connect(actor, "notify::hover", () => {
        if (actor.hover) this._showTooltip(actor, name);
        else this._hideTooltip();
      });
      this._signals.connect(actor, "button-release-event", (_a, event) => {
        const button = (event as { get_button: () => number }).get_button();
        if (button === 1 || button === 3) this._openStack(actor, folder);
        return Clutter.EVENT_STOP;
      });
      this._container.add_child(actor);
      this._stackActors.push(actor);
    }
  }

  /** Takes the stacks away (a rebuild puts them back last). */
  private _clearStacks(): void {
    this._closeStackMenu();
    for (const actor of this._stackActors) actor.destroy();
    this._stackActors = [];
    this._stackSeparator?.destroy();
    this._stackSeparator = null;
  }

  /** The folder's newest files, newest first (hidden ones left out). */
  private _stackFiles(dir: string): { file: Gio.File; name: string; icon: Gio.Icon | null }[] {
    const out: { file: Gio.File; name: string; icon: Gio.Icon | null; at: number }[] = [];
    try {
      const folder = Gio.File.new_for_path(dir);
      const it = folder.enumerate_children(
        "standard::name,standard::display-name,standard::icon,standard::is-hidden,time::modified",
        Gio.FileQueryInfoFlags.NONE,
        null,
      );
      let seen = 0;
      for (let info = it.next_file(null); info && seen < 5000; info = it.next_file(null), seen++) {
        if (info.get_is_hidden()) continue;
        out.push({
          file: folder.get_child(info.get_name()),
          name: info.get_display_name(),
          icon: info.get_icon(),
          at: info.get_attribute_uint64("time::modified"),
        });
      }
      it.close(null);
    } catch (_e) {
      return [];
    }
    return out.sort((a, b) => b.at - a.at).slice(0, STACK_FILES);
  }

  private _openStack(actor: IconActor, folder: StackFolder): void {
    this._closeContextMenu();
    this._closeStackMenu();
    this._hideTooltip();
    if (!this._menuManager) return;
    const { dir, name } = STACKS[folder];
    const path = GLib.get_user_special_dir(dir);
    if (!path) return;
    const menu = new PopupMenu.PopupMenu(actor, 0.5, St.Side.TOP);
    menu.box.add_style_class_name("dock-popup-menu");
    Main.uiGroup.add_child(menu.actor);
    this._stackMenu = menu;
    const open = (file: Gio.File) => {
      try {
        Gio.AppInfo.launch_default_for_uri(file.get_uri(), global.create_app_launch_context(0, -1));
      } catch (e) {
        Main.notify(name, `Could not open ${file.get_basename()}: ${(e as Error).message}`);
      }
    };
    const files = this._stackFiles(path);
    if (files.length === 0) {
      const empty = new PopupMenu.PopupMenuItem(`${name} is empty`, { reactive: false });
      menu.addMenuItem(empty);
    }
    for (const f of files) {
      const item = new PopupMenu.PopupImageMenuItem(f.name, f.icon ?? "text-x-generic-symbolic");
      item.label.add_style_class_name("dock-stack-name");
      item.label.clutter_text.set_ellipsize(3); // Pango.EllipsizeMode.END
      item.connect("activate", () => open(f.file));
      menu.addMenuItem(item);
    }
    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    const folderItem = new PopupMenu.PopupImageMenuItem(`Open ${name}`, "folder-open-symbolic");
    folderItem.connect("activate", () => open(Gio.File.new_for_path(path)));
    menu.addMenuItem(folderItem);
    menu.connect("open-state-changed", (_m: unknown, isOpen: boolean) => {
      if (!isOpen && this._stackMenu === menu) {
        this._onContextMenuActorChanged?.(null);
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          if (this._stackMenu === menu) this._stackMenu = null;
          menu.destroy();
          return GLib.SOURCE_REMOVE;
        });
      }
    });
    this._menuManager.addMenu(menu);
    this._onContextMenuActorChanged?.(menu.actor);
    menu.open(BoxPointer.PopupAnimation.FULL);
  }

  private _closeStackMenu(): void {
    const menu = this._stackMenu;
    this._stackMenu = null;
    if (menu) {
      menu.close(BoxPointer.PopupAnimation.NONE);
      menu.destroy();
    }
  }

  /** How many container children the minimized section has (its separator and one thumbnail each). */
  private _minChildCount(): number {
    return (this._minSeparator ? 1 : 0) + this._minItems.size;
  }

  /** Whether `win` is one the dock shows as a thumbnail when minimized (a normal window the shell would list). */
  isMinimizable(win: Meta.Window): boolean {
    if (!this._minimizedEnabled || !this._isPinnedWindow(win)) return false;
    return (
      !win.skip_taskbar &&
      (win.window_type === 0 /* NORMAL */ ||
        win.window_type === 3 /* DIALOG */ ||
        win.window_type === 4) /* MODAL_DIALOG */
    );
  }

  /** Whether `win` belongs to an app pinned to the dock: only those get a thumbnail at the end. */
  private _isPinnedWindow(win: Meta.Window): boolean {
    const app = Shell.WindowTracker.get_default().get_window_app(win);
    return app !== null && this._favorites.includes(app.get_id());
  }

  private _wantedMinimized(): Meta.Window[] {
    if (!this._minimizedEnabled) return [];
    const tracker = Shell.WindowTracker.get_default();
    const active = global.workspace_manager.get_active_workspace();
    const result: Meta.Window[] = [];
    for (const actor of global.get_window_actors()) {
      const win = actor.get_meta_window();
      if (!win || !win.minimized || !this.isMinimizable(win)) continue;
      if (this._workspaceMode === 1 && win.get_workspace() !== active) continue;
      if (!tracker.get_window_app(win)) continue;
      result.push(win);
    }
    return result;
  }

  /** Thumbnails for the minimized windows there are, and none for the ones that are not any more. */
  syncMinimized(animate = true): void {
    this._syncOverviewIcons();
    if (!this._minimizedEnabled && this._minItems.size === 0) return;
    const wanted = this._wantedMinimized();
    const ids = new Set(wanted.map((win) => win.get_id()));
    for (const [id, item] of [...this._minItems]) {
      if (!ids.has(id)) this._removeMinItem(id, item, animate);
    }
    for (const win of wanted) {
      if (!this._minItems.has(win.get_id())) this._addMinItem(win, animate ? 0 : -1);
    }
    this._updateMinSeparator();
    this._refreshAllIndicators();
    if (this._onIconsChanged) this._onIconsChanged();
  }

  /**
   * A window is being minimized: its thumbnail is made now (shown once the genie has arrived) and where it will be is returned, so the
   * window flies there. The dock grows around its centre, so the slot is the end of the row less half of what it adds.
   */
  addMinimized(win: Meta.Window): Rect | null {
    if (!this.isMinimizable(win)) return null;
    const existing = this._minItems.get(win.get_id());
    if (existing) return this._minRect(existing.actor);
    // The last child before the stacks: the new thumbnail goes right after it.
    const lastIndex = this._container.get_n_children() - 1 - this._stackChildCount();
    const last = lastIndex >= 0 ? this._container.get_child_at_index(lastIndex) : null;
    const slot = this._thumbSize(win).width + 12;
    const spacing = this._spacing;
    const addsSeparator = this._minSeparator === null;
    const added = (addsSeparator ? 9 + spacing : 0) + slot + spacing;
    const vertical = this._isVerticalLayout();
    let rect: Rect | null = null;
    if (last) {
      const [lx, ly] = last.get_transformed_position();
      const [lw, lh] = last.get_transformed_size();
      const start =
        (vertical ? ly + lh : lx + lw) + (addsSeparator ? 9 + spacing : 0) + spacing - added / 2;
      rect = vertical
        ? { x: lx, y: Math.round(start), width: Math.round(lw), height: slot }
        : { x: Math.round(start), y: ly, width: slot, height: Math.round(lh) };
    }
    this._addMinItem(win, 380);
    this._updateMinSeparator();
    if (this._onIconsChanged) this._onIconsChanged();
    return rect;
  }

  /** Where `win`'s thumbnail is on screen now, for the window to fly out of it. */
  minimizedRect(win: Meta.Window): Rect | null {
    const item = this._minItems.get(win.get_id());
    return item ? this._minRect(item.actor) : null;
  }

  /** The window is back: its thumbnail goes (the genie has its rect already). */
  removeMinimized(win: Meta.Window): void {
    const item = this._minItems.get(win.get_id());
    if (item) this._removeMinItem(win.get_id(), item, true);
    this._updateMinSeparator();
    this._refreshAllIndicators();
    if (this._onIconsChanged) this._onIconsChanged();
  }

  /** Total length of the minimized section along the dock, separator included, for the dock's size. */
  getMinimizedExtent(): number {
    if (this._minItems.size === 0) return 0;
    let extent = 9 + this._spacing;
    for (const item of this._minItems.values()) extent += item.width + this._spacing;
    return extent;
  }

  private _minRect(actor: IconActor): Rect {
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(1, Math.round(w)),
      height: Math.max(1, Math.round(h)),
    };
  }

  /** The thumbnail's size: as tall as an icon, as wide as the window's shape asks within reason. */
  private _thumbSize(win: Meta.Window): { width: number; height: number } {
    const frame = win.get_frame_rect();
    const aspect = frame.height > 0 ? frame.width / frame.height : 1;
    const height = this._iconSize;
    const width = Math.round(
      Math.max(this._iconSize * 0.9, Math.min(this._iconSize * 1.8, this._iconSize * aspect)),
    );
    return { width, height };
  }

  private _updateMinSeparator(): void {
    const wanted = this._minItems.size > 0;
    if (wanted && !this._minSeparator) {
      this._minSeparator = new St.Widget({
        style_class: "dock-separator",
        width: 1,
        height: 32,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });
      // Right before the first thumbnail.
      const first = [...this._minItems.values()][0]?.actor;
      const index = first
        ? this._container.get_children().indexOf(first)
        : this._container.get_n_children() - this._stackChildCount();
      this._container.insert_child_at_index(this._minSeparator, Math.max(0, index));
    } else if (!wanted && this._minSeparator) {
      this._minSeparator.destroy();
      this._minSeparator = null;
    }
  }

  /** `delay` ms before it shows (the genie is on its way); -1 for at once without the pop. */
  private _addMinItem(win: Meta.Window, delay: number): void {
    const windowActor = win.get_compositor_private() as Clutter.Actor | null;
    const tracker = Shell.WindowTracker.get_default();
    const app = tracker.get_window_app(win);
    if (!windowActor || !app) return;
    const { width, height } = this._thumbSize(win);
    const actor = new St.BoxLayout({
      style_class: "dock-icon dock-minimized",
      reactive: true,
      track_hover: true,
      ...box(true),
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.FILL,
    }) as IconActor;
    actor.set_size(width + 12, this._iconSize + 12 - 4);

    const thumb = new St.Widget({
      style_class: "dock-minimized-thumb",
      layout_manager: new Clutter.FixedLayout(),
      x_align: Clutter.ActorAlign.CENTER,
      width,
      height,
      clip_to_allocation: true,
    });
    const [aw, ah] = windowActor.get_size();
    if (aw > 0 && ah > 0) {
      const clone = new Clutter.Clone({ source: windowActor, reactive: false });
      const scale = Math.min(width / aw, height / ah);
      clone.set_scale(scale, scale);
      clone.set_position(
        Math.round((width - aw * scale) / 2),
        Math.round((height - ah * scale) / 2),
      );
      thumb.add_child(clone);
    }
    // The app's icon in the corner, so a thumbnail says whose window it is.
    const badgeSize = Math.round(this._iconSize * 0.4);
    const badge = app.create_icon_texture(badgeSize);
    badge.set_position(width - badgeSize + 2, height - badgeSize + 2);
    thumb.add_child(badge);
    actor.add_child(thumb);
    (actor as unknown as Record<string, unknown>)._minimizedWindow = win;

    this._signals.connect(actor, "button-release-event", (_a, event) => {
      if ((event as { get_button: () => number }).get_button() !== 1)
        return Clutter.EVENT_PROPAGATE;
      if (!this._isPointerOver(actor)) return Clutter.EVENT_PROPAGATE;
      this._hideTooltip();
      win.unminimize();
      win.activate(global.get_current_time());
      return Clutter.EVENT_STOP;
    });
    this._signals.connect(actor, "notify::hover", () => {
      if (actor.hover) this._showTooltip(actor, win.get_title() || app.get_name());
      else this._hideTooltip();
    });

    this._container.insert_child_at_index(
      actor,
      this._container.get_n_children() - this._stackChildCount(),
    );
    this._positionAppButton();
    this._minItems.set(win.get_id(), { win, actor, width: width + 12 });

    if (delay >= 0) {
      actor.opacity = 0;
      actor.set_pivot_point(0.5, 1.0);
      actor.scale_x = 0.6;
      actor.scale_y = 0.6;
      (actor as unknown as { ease(p: Record<string, unknown>): void }).ease({
        opacity: 255,
        scale_x: 1,
        scale_y: 1,
        delay,
        duration: 220,
        mode: Clutter.AnimationMode.EASE_OUT_BACK,
      });
    }
  }

  private _removeMinItem(id: number, item: MinItem, animate: boolean): void {
    this._minItems.delete(id);
    const { actor } = item;
    this._hideTooltip();
    if (!animate) {
      actor.destroy();
      return;
    }
    (actor as unknown as { ease(p: Record<string, unknown>): void }).ease({
      opacity: 0,
      duration: 140,
      mode: Clutter.AnimationMode.EASE_IN_QUAD,
      onComplete: () => actor.destroy(),
    });
  }
}
