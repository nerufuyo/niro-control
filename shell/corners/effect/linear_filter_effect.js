/**
 * @file Applies linear interpolation to a window. This is used to make windows
 * in the overview look better.
 */
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import { GLSLEffect, FRAGMENT } from './glsl_effect.js';
export const LinearFilterEffect = GObject.registerClass({}, class extends GLSLEffect {
    buildPipeline() {
        this.add_glsl_snippet(FRAGMENT, '', '', false);
    }
    vfunc_paint_target(node, ctx) {
        this.get_pipeline?.()?.set_layer_filters(0, Cogl.PipelineFilter.LINEAR_MIPMAP_LINEAR, Cogl.PipelineFilter.LINEAR);
        super.vfunc_paint_target(node, ctx);
    }
});
