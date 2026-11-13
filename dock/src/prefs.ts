import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";
import { SignalManager } from "./lib/signalManager.js";

const BIND_FLAGS = 0 | 1 | 2 | 4; // DEFAULT | GET | SET | NO_SENSITIVITY

export default class MacosDockPreferences extends ExtensionPreferences {
  private _signals = new SignalManager();

  async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    const settings = this.getSettings();

    const page = new Adw.PreferencesPage({
      title: "General",
      icon_name: "preferences-system-symbolic",
    });
    window.add(page);

    // Appearance group
    const appearanceGroup = new Adw.PreferencesGroup({
      title: "Appearance",
      description: "Visual look of the dock",
    });
    page.add(appearanceGroup);

    const iconSizeRow = new Adw.SpinRow({
      title: "Icon size",
      subtitle: "Pixel size of dock icons",
      adjustment: new Gtk.Adjustment({
        lower: 16,
        upper: 96,
        step_increment: 2,
        page_increment: 8,
        value: settings.get_int("icon-size"),
      }),
    });
    settings.bind("icon-size", iconSizeRow, "value", BIND_FLAGS);
    appearanceGroup.add(iconSizeRow);

    // Position group
    const positionGroup = new Adw.PreferencesGroup({
      title: "Position",
      description: "Where the dock appears on screen",
    });
    page.add(positionGroup);

    const positionModel = new Gtk.StringList({
      strings: ["Bottom", "Left", "Right", "Top"],
    });
    const positionRow = new Adw.ComboRow({
      title: "Dock position",
      subtitle: "Choose which screen edge the dock attaches to",
      model: positionModel,
      selected: settings.get_int("dock-position"),
    });
    this._signals.connect(positionRow, "notify::selected", () => {
      settings.set_int("dock-position", positionRow.selected);
    });
    this._signals.connect(settings, "changed::dock-position", () => {
      positionRow.selected = settings.get_int("dock-position");
    });
    positionGroup.add(positionRow);

    const appButtonPositionRow = new Adw.ComboRow({
      title: "Applications button position",
      subtitle: "Choose which end of the dock holds the Show Apps button",
      model: new Gtk.StringList({ strings: ["Start of dock", "End of dock"] }),
      selected: settings.get_int("show-applications-button-position"),
    });
    this._signals.connect(appButtonPositionRow, "notify::selected", () => {
      settings.set_int("show-applications-button-position", appButtonPositionRow.selected);
    });
    this._signals.connect(settings, "changed::show-applications-button-position", () => {
      appButtonPositionRow.selected = settings.get_int("show-applications-button-position");
    });
    positionGroup.add(appButtonPositionRow);

    // Background group
    const bgGroup = new Adw.PreferencesGroup({
      title: "Background",
      description: "Customize the dock background",
    });
    page.add(bgGroup);

    const opacityRow = new Adw.SpinRow({
      title: "Opacity",
      subtitle: "Dock background opacity (0-100%)",
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 100,
        step_increment: 5,
        page_increment: 10,
        value: settings.get_int("dock-opacity"),
      }),
    });
    settings.bind("dock-opacity", opacityRow, "value", BIND_FLAGS);
    bgGroup.add(opacityRow);

    const borderRadiusRow = new Adw.SpinRow({
      title: "Border radius",
      subtitle: "Corner radius of the dock in pixels",
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 50,
        step_increment: 1,
        page_increment: 4,
        value: settings.get_int("dock-border-radius"),
      }),
    });
    settings.bind("dock-border-radius", borderRadiusRow, "value", BIND_FLAGS);
    bgGroup.add(borderRadiusRow);

    const blurRow = new Adw.SwitchRow({
      title: "Enable blur",
      subtitle: "Frosted glass effect behind the dock",
    });
    settings.bind("dock-blur-enabled", blurRow, "active", BIND_FLAGS);
    bgGroup.add(blurRow);

    const customCssRow = new Adw.ExpanderRow({
      title: "Custom CSS",
      subtitle: "Apply a stylesheet to customize dock elements",
    });
    const customCssContent = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 12,
      margin_top: 8,
      margin_bottom: 8,
      margin_start: 12,
      margin_end: 12,
    });
    const customCssHelp = new Gtk.Label({
      label:
        "Use dock selectors such as .macos-dock-container, .macos-dock-icon, and .macos-dock-app-button.",
      wrap: true,
      xalign: 0,
    });
    customCssContent.append(customCssHelp);

    const customCssEditor = new Gtk.TextView({
      monospace: true,
      wrap_mode: Gtk.WrapMode.NONE,
      accepts_tab: true,
      height_request: 180,
    });
    customCssEditor.buffer.set_text(settings.get_string("custom-css"), -1);
    const customCssScroll = new Gtk.ScrolledWindow({
      hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
      vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
      min_content_height: 180,
      child: customCssEditor,
    });
    customCssContent.append(customCssScroll);

    const customCssActions = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 6,
      halign: Gtk.Align.END,
    });
    const resetCssButton = new Gtk.Button({ label: "Reset" });
    this._signals.connect(resetCssButton, "clicked", () => {
      customCssEditor.buffer.set_text("", -1);
      settings.set_string("custom-css", "");
    });
    customCssActions.append(resetCssButton);

    const applyCssButton = new Gtk.Button({
      label: "Apply CSS",
      css_classes: ["suggested-action"],
    });
    this._signals.connect(applyCssButton, "clicked", () => {
      const [start, end] = customCssEditor.buffer.get_bounds();
      settings.set_string("custom-css", customCssEditor.buffer.get_text(start, end, true));
    });
    customCssActions.append(applyCssButton);
    customCssContent.append(customCssActions);
    customCssRow.add_row(customCssContent);
    bgGroup.add(customCssRow);
    this._signals.connect(settings, "changed::custom-css", () => {
      customCssEditor.buffer.set_text(settings.get_string("custom-css"), -1);
    });

    // Behavior group
    const behaviorGroup = new Adw.PreferencesGroup({
      title: "Behavior",
    });
    page.add(behaviorGroup);

    const autoHideRow = new Adw.SwitchRow({
      title: "Auto-hide",
      subtitle: "Dock hides when the pointer moves away from it",
    });
    settings.bind("auto-hide", autoHideRow, "active", BIND_FLAGS);
    behaviorGroup.add(autoHideRow);

    const bounceRow = new Adw.SwitchRow({
      title: "Bounce on launch",
      subtitle: "Animate the dock icon when an app starts",
    });
    settings.bind("bounce-on-launch", bounceRow, "active", BIND_FLAGS);
    behaviorGroup.add(bounceRow);

    const animDurationRow = new Adw.SpinRow({
      title: "Animation duration",
      subtitle: "Show/hide animation time in milliseconds (0 = instant)",
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 1000,
        step_increment: 10,
        page_increment: 50,
        value: settings.get_int("animation-duration"),
      }),
    });
    settings.bind("animation-duration", animDurationRow, "value", BIND_FLAGS);
    behaviorGroup.add(animDurationRow);

    const showThresholdRow = new Adw.SpinRow({
      title: "Show threshold",
      subtitle: "Distance in pixels from screen edge to trigger dock show",
      adjustment: new Gtk.Adjustment({
        lower: 5,
        upper: 100,
        step_increment: 5,
        page_increment: 10,
        value: settings.get_int("show-threshold"),
      }),
    });
    settings.bind("show-threshold", showThresholdRow, "value", BIND_FLAGS);
    behaviorGroup.add(showThresholdRow);

    const keyboardNavRow = new Adw.SwitchRow({
      title: "Keyboard navigation",
      subtitle:
        "Register dock shortcuts (Super+D and Super+1–0). Disabled by default to keep GNOME shortcuts free.",
    });
    settings.bind("enable-keyboard-nav", keyboardNavRow, "active", BIND_FLAGS);
    behaviorGroup.add(keyboardNavRow);

    const appButtonRow = new Adw.SwitchRow({
      title: "Show applications button",
      subtitle: "Show a grid icon to access all apps",
    });
    settings.bind("show-applications-button", appButtonRow, "active", BIND_FLAGS);
    behaviorGroup.add(appButtonRow);

    const showRunningAppsRow = new Adw.SwitchRow({
      title: "Show running applications",
      subtitle: "Show non-favorite running apps in the dock",
    });
    settings.bind("show-running-apps", showRunningAppsRow, "active", BIND_FLAGS);
    behaviorGroup.add(showRunningAppsRow);

    const dragReorderRow = new Adw.SwitchRow({
      title: "Drag to reorder",
      subtitle: "Drag pinned icons to change their order",
    });
    settings.bind("drag-reorder", dragReorderRow, "active", BIND_FLAGS);
    behaviorGroup.add(dragReorderRow);

    const workspaceModeModel = new Gtk.StringList({
      strings: ["All workspaces", "Current workspace only"],
    });
    const workspaceModeRow = new Adw.ComboRow({
      title: "Workspace mode",
      subtitle: "Which workspaces show running applications",
      model: workspaceModeModel,
      selected: settings.get_int("dock-workspace-mode"),
    });
    this._signals.connect(workspaceModeRow, "notify::selected", () => {
      settings.set_int("dock-workspace-mode", workspaceModeRow.selected);
    });
    this._signals.connect(settings, "changed::dock-workspace-mode", () => {
      workspaceModeRow.selected = settings.get_int("dock-workspace-mode");
    });
    behaviorGroup.add(workspaceModeRow);

    const windowPreviewsRow = new Adw.SwitchRow({
      title: "Window previews",
      subtitle: "Show live thumbnail previews of open windows on hover",
    });
    settings.bind("window-previews", windowPreviewsRow, "active", BIND_FLAGS);
    behaviorGroup.add(windowPreviewsRow);

    const previewScaleRow = new Adw.SpinRow({
      title: "Preview thumbnail width",
      subtitle: "Width of each preview thumbnail in pixels",
      adjustment: new Gtk.Adjustment({
        lower: 100,
        upper: 400,
        step_increment: 10,
        page_increment: 20,
        value: settings.get_int("preview-scale"),
      }),
    });
    settings.bind("preview-scale", previewScaleRow, "value", BIND_FLAGS);
    behaviorGroup.add(previewScaleRow);

    // Magnification group
    const magGroup = new Adw.PreferencesGroup({
      title: "Magnification",
      description: "Icon grows when the pointer is near it",
    });
    page.add(magGroup);

    const magEnabledRow = new Adw.SwitchRow({
      title: "Enable magnification",
    });
    settings.bind("magnification-enabled", magEnabledRow, "active", BIND_FLAGS);
    magGroup.add(magEnabledRow);

    // Max scale - connect to adjustment's signal, not the row's
    const magScaleAdj = new Gtk.Adjustment({
      lower: 1.0,
      upper: 2.0,
      step_increment: 0.05,
      page_increment: 0.1,
      value: settings.get_double("magnification-scale"),
    });
    const magScaleRow = new Adw.SpinRow({
      title: "Max scale",
      subtitle: "1.0 = no magnification, 2.0 = double size",
      adjustment: magScaleAdj,
      digits: 2,
    });
    this._signals.connect(magScaleAdj, "value-changed", () => {
      settings.set_double("magnification-scale", magScaleAdj.get_value());
    });
    this._signals.connect(settings, "changed::magnification-scale", () => {
      magScaleAdj.set_value(settings.get_double("magnification-scale"));
    });
    magGroup.add(magScaleRow);

    // Falloff distance
    const magFalloffAdj = new Gtk.Adjustment({
      lower: 40,
      upper: 300,
      step_increment: 10,
      page_increment: 20,
      value: settings.get_int("magnification-falloff"),
    });
    const magFalloffRow = new Adw.SpinRow({
      title: "Falloff distance",
      subtitle: "How far the magnification wave reaches (pixels)",
      adjustment: magFalloffAdj,
    });
    this._signals.connect(magFalloffAdj, "value-changed", () => {
      settings.set_int("magnification-falloff", magFalloffAdj.get_value());
    });
    this._signals.connect(settings, "changed::magnification-falloff", () => {
      magFalloffAdj.set_value(settings.get_int("magnification-falloff"));
    });
    magGroup.add(magFalloffRow);

    // Indicators group
    const indGroup = new Adw.PreferencesGroup({
      title: "Indicators",
    });
    page.add(indGroup);

    const indicatorsRow = new Adw.SwitchRow({
      title: "Running indicators",
      subtitle: "Show a dot under icons of running apps",
    });
    settings.bind("running-indicators", indicatorsRow, "active", BIND_FLAGS);
    indGroup.add(indicatorsRow);

    // Indicator style
    const indicatorStyleModel = new Gtk.StringList({
      strings: ["Dots per window", "Horizontal bar"],
    });
    const indicatorStyleRow = new Adw.ComboRow({
      title: "Indicator style",
      subtitle: "Dots per window (macOS) or a single horizontal bar",
      model: indicatorStyleModel,
      selected: settings.get_int("running-indicator-style"),
    });
    this._signals.connect(indicatorStyleRow, "notify::selected", () => {
      settings.set_int("running-indicator-style", indicatorStyleRow.selected);
    });
    this._signals.connect(settings, "changed::running-indicator-style", () => {
      indicatorStyleRow.selected = settings.get_int("running-indicator-style");
    });
    indGroup.add(indicatorStyleRow);

    // Media group
    const mediaGroup = new Adw.PreferencesGroup({
      title: "Media",
      description: "Music player integration",
    });
    page.add(mediaGroup);

    const mediaIndicatorRow = new Adw.SwitchRow({
      title: "Media indicator",
      subtitle: "Show a music note on the currently playing app icon",
    });
    settings.bind("media-indicator", mediaIndicatorRow, "active", BIND_FLAGS);
    mediaGroup.add(mediaIndicatorRow);

    const mediaControlsRow = new Adw.SwitchRow({
      title: "Media controls",
      subtitle: "Show play/pause/next/previous in the context menu",
    });
    settings.bind("media-controls", mediaControlsRow, "active", BIND_FLAGS);
    mediaGroup.add(mediaControlsRow);

    // Performance group
    const perfGroup = new Adw.PreferencesGroup({
      title: "Performance",
    });
    page.add(perfGroup);

    // Icon Quality
    const qualityModel = new Gtk.StringList({ strings: ["x1", "x2", "x4"] });
    const qualityRow = new Adw.ComboRow({
      title: "Icon Quality",
      subtitle: "Set icon resolution to improve rendering quality",
      model: qualityModel,
      selected:
        settings.get_int("icon-quality") === 4 ? 2 : settings.get_int("icon-quality") === 2 ? 1 : 0,
    });
    this._signals.connect(qualityRow, "notify::selected", () => {
      const values = [1, 2, 4];
      settings.set_int("icon-quality", values[qualityRow.selected]);
    });
    this._signals.connect(settings, "changed::icon-quality", () => {
      const v = settings.get_int("icon-quality");
      qualityRow.selected = v === 4 ? 2 : v === 2 ? 1 : 0;
    });
    perfGroup.add(qualityRow);

    // Framerate
    const fpsModel = new Gtk.StringList({ strings: ["30", "60", "120"] });
    const fpsRow = new Adw.ComboRow({
      title: "Framerate",
      subtitle: "Set animation framerate. Higher is smoother but uses more CPU",
      model: fpsModel,
      selected:
        settings.get_int("magnification-framerate") === 120
          ? 2
          : settings.get_int("magnification-framerate") === 60
            ? 1
            : 0,
    });
    this._signals.connect(fpsRow, "notify::selected", () => {
      const values = [30, 60, 120];
      settings.set_int("magnification-framerate", values[fpsRow.selected]);
    });
    this._signals.connect(settings, "changed::magnification-framerate", () => {
      const v = settings.get_int("magnification-framerate");
      fpsRow.selected = v === 120 ? 2 : v === 60 ? 1 : 0;
    });
    perfGroup.add(fpsRow);

    // Disconnect all tracked signals when the window is closed.
    this._signals.connect(window, "close-request", () => this._signals.disconnectAll());
  }
}
