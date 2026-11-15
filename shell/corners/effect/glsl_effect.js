/**
 * @file A shader effect with Shell.GLSLEffect's interface. GNOME 51 removed Shell.GLSLEffect: the snippet is then given
 * to Clutter.ShaderEffect, whose uniforms are set by name (`get_uniform_location` returns the name).
 */
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

export const FRAGMENT = Shell.SnippetHook?.FRAGMENT ?? Cogl.SnippetHook.FRAGMENT;

// Subclasses define `buildPipeline()` (not a vfunc: only Shell.GLSLEffect has one) and call `add_glsl_snippet` in it.
export const GLSLEffect = Shell.GLSLEffect ? GObject.registerClass({ GTypeName: 'CornersGLSLEffect' }, class extends Shell.GLSLEffect {
    vfunc_build_pipeline() {
        this.buildPipeline();
    }
    buildPipeline() { }
}) : GObject.registerClass({ GTypeName: 'CornersGLSLEffect' }, class extends Clutter.ShaderEffect {
    get_uniform_location(name) {
        return name;
    }
    add_glsl_snippet(hook, declarations, code, replace) {
        const snippet = Cogl.Snippet.new(hook, declarations, null);
        if (replace)
            snippet.set_replace(code);
        else
            snippet.set_post(code);
        this._snippet = snippet;
    }
    vfunc_get_static_snippet() {
        this._snippet = null;
        this.buildPipeline();
        return this._snippet;
    }
    buildPipeline() { }
});
