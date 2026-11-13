// Genie-like minimize / restore: while GNOME's own animation moves and shrinks the window toward its dock icon, this
// shader pinches the window into a funnel (narrower toward the bottom), the way macOS's genie does.
import Clutter from "gi://Clutter";
import GObject from "gi://GObject";
import Shell from "gi://Shell";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

class GenieEffectBase extends Shell.GLSLEffect {
    _progress = 0;
    _loc: number | null = null;
    vfunc_build_pipeline() {
        const declarations = "uniform float progress;\n";
        const code = `
            vec2 uv = cogl_tex_coord_in[0].st;
            float k = progress * 0.94;
            float w = max(1.0 - k * smoothstep(0.0, 1.0, uv.y), 0.02);
            float sx = 0.5 + (uv.x - 0.5) / w;
            if (sx < 0.0 || sx > 1.0)
                cogl_color_out = vec4(0.0);
            else
                cogl_color_out = texture2D(cogl_sampler0, vec2(sx, uv.y)) * cogl_color_in;
        `;
        this.add_glsl_snippet((Shell as unknown as { SnippetHook: { FRAGMENT: number } }).SnippetHook.FRAGMENT, declarations, code, true);
    }

    setProgress(value: number) {
        this._progress = value;
        this.queue_repaint();
    }

    vfunc_paint_target(node: unknown, paintContext: unknown) {
        this._loc ??= this.get_uniform_location("progress");
        this.set_uniform_float(this._loc, 1, [this._progress ?? 0]);
        // biome-ignore lint/suspicious/noExplicitAny: Shell.GLSLEffect.vfunc_paint_target has no usable typing
        (super.vfunc_paint_target as any)(node, paintContext);
    }
}
const GenieEffect = GObject.registerClass(GenieEffectBase);

/**
 * Minimize / restore as a clone of the window: pinched into a funnel and flown to (or from) `rect`, the dock icon.
 * GNOME's own animation lasts ~200 ms and ends with the window hidden, too short to see a funnel; this one takes
 * `duration` ms. The real window stays invisible meanwhile (`actor.opacity`) and is shown again at the end of a restore.
 */
type Rect = { x: number; y: number; width: number; height: number };

export function genie(actor: Clutter.Actor, rect: Rect | null, { reverse = false, duration = 480 } = {}): void {
    let clone: Clutter.Clone | null = null;
    try {
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_size();
        if (!rect || w < 2 || h < 2)
            return;
        clone = new Clutter.Clone({ source: actor, reactive: false });
        Main.uiGroup.add_child(clone);
        clone.set_position(x, y);
        clone.set_size(w, h);
        clone.set_pivot_point(0.5, 0.5);
        const dx = rect.x + rect.width / 2 - (x + w / 2);
        const dy = rect.y + rect.height / 2 - (y + h / 2);
        const small = Math.max(0.06, Math.min(0.12, rect.width / w));
        const effect = new GenieEffect() as InstanceType<typeof GenieEffectBase>;
        clone.add_effect_with_name("dock-genie", effect);
        const hidden = actor.opacity;
        actor.opacity = 0;
        const finish = () => {
            try { clone?.destroy(); } catch (_e) { /* already gone */ }
            clone = null;
            actor.remove_all_transitions?.();
            actor.opacity = reverse ? 255 : hidden;
        };
        const from = reverse ? { translation_x: dx, translation_y: dy, scale_x: small, scale_y: small, opacity: 0 }
                             : { translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1, opacity: 255 };
        const to = reverse ? { translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1, opacity: 255 }
                           : { translation_x: dx, translation_y: dy, scale_x: small, scale_y: small, opacity: 40 };
        clone.set(from);
        clone.ease({ ...to, duration, mode: reverse ? Clutter.AnimationMode.EASE_OUT_CUBIC : Clutter.AnimationMode.EASE_IN_CUBIC,
            onStopped: finish });
        const timeline = new Clutter.Timeline({ actor: clone, duration });
        timeline.connect("new-frame", (_t: Clutter.Timeline, ms: number) => {
            const t = Math.min(1, ms / duration);
            effect.setProgress(reverse ? 1 - t : t);
        });
        timeline.start();
    } catch (e) {
        console.error(`Dock: genie effect failed: ${e}`);
        try { clone?.destroy(); } catch (_e) { /* already gone */ }
        actor.opacity = 255;
    }
}
