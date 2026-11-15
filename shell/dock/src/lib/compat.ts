// Where GNOME Shell 46 to 51 differ for the dock. St.BoxLayout takes `vertical` up to GNOME 50 and only `orientation`
// from 51 (48 added it), so every box is made through `box()` and turned through `setVertical()`.
import Clutter from "gi://Clutter";
import Cogl from "gi://Cogl";
import GObject from "gi://GObject";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import { PACKAGE_VERSION } from "resource:///org/gnome/shell/misc/config.js";

export const SHELL_MAJOR = Number.parseInt(PACKAGE_VERSION, 10);

/** St.BoxLayout construction params for a vertical or horizontal box. */
export function box(vertical: boolean): Record<string, unknown> {
  return SHELL_MAJOR >= 48
    ? { orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL }
    : { vertical };
}

/** Turns an existing box vertical or horizontal. */
export function setVertical(target: unknown, vertical: boolean): void {
  const layout = target as { orientation?: number; vertical?: boolean };
  if (SHELL_MAJOR >= 48) layout.orientation = vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
  else layout.vertical = vertical;
}

type Hook = number;
type FallbackEffect = Clutter.ShaderEffect & {
  buildPipeline(): void;
  _snippet: Cogl.Snippet | null;
};

/**
 * A shader effect with Shell.GLSLEffect's interface; subclasses define `buildPipeline()` (only Shell.GLSLEffect has a vfunc for it). GNOME 51 removed Shell.GLSLEffect: its snippet is then given to
 * Clutter.ShaderEffect, whose uniforms are set by name (`get_uniform_location` returns the name).
 */
export function glslEffectBase(): typeof GObject.Object {
  const shell = Shell as unknown as { GLSLEffect?: typeof GObject.Object };
  if (shell.GLSLEffect) {
    class Native extends (shell.GLSLEffect as unknown as typeof Clutter.Effect) {
      vfunc_build_pipeline(): void {
        (this as unknown as { buildPipeline(): void }).buildPipeline();
      }
      buildPipeline(): void {}
    }
    return GObject.registerClass(Native) as unknown as typeof GObject.Object;
  }
  class Fallback extends Clutter.ShaderEffect {
    declare _snippet: Cogl.Snippet | null;
    get_uniform_location(name: string): string {
      return name;
    }
    add_glsl_snippet(hook: Hook, declarations: string, code: string, replace: boolean): void {
      const snippet = Cogl.Snippet.new(hook as Cogl.SnippetHook, declarations, null);
      if (replace) snippet.set_replace(code);
      else snippet.set_post(code);
      this._snippet = snippet;
    }
    vfunc_get_static_snippet(): Cogl.Snippet {
      this._snippet = null;
      (this as unknown as FallbackEffect).buildPipeline();
      return this._snippet as unknown as Cogl.Snippet;
    }
    buildPipeline(): void {}
  }
  return GObject.registerClass(Fallback) as unknown as typeof GObject.Object;
}

/** The snippet hook for a fragment shader, whichever name the shell version gives it. */
export function fragmentHook(): Hook {
  return ((Shell as unknown as { SnippetHook?: { FRAGMENT: number } }).SnippetHook?.FRAGMENT ??
    Cogl.SnippetHook.FRAGMENT) as number;
}

/** Whether the shell runs on Wayland (GNOME 50 dropped X11 and the check). */
export function isWayland(): boolean {
  return (Meta as unknown as { is_wayland_compositor?: () => boolean }).is_wayland_compositor?.() ?? true;
}

/**
 * Keeps a window that covers a whole display from going straight to the screen (X11's unredirection), past what is drawn over
 * it, as the dock and the island are over a full-screen app. Counted: keep the calls paired. GNOME 48 moved it.
 */
export function inhibitScanout(inhibit: boolean): void {
  if (SHELL_MAJOR >= 48) {
    const compositor = (global as unknown as { compositor: { disable_unredirect(): void; enable_unredirect(): void } }).compositor;
    if (inhibit) compositor.disable_unredirect();
    else compositor.enable_unredirect();
    return;
  }
  const meta = Meta as unknown as {
    disable_unredirect_for_display(display: unknown): void;
    enable_unredirect_for_display(display: unknown): void;
  };
  if (inhibit) meta.disable_unredirect_for_display(global.display);
  else meta.enable_unredirect_for_display(global.display);
}
