/**
 * @file Clips shadows for windows.
 *
 * Needed because of this issue:
 * https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/4474
 */
import GObject from 'gi://GObject';
import { GLSLEffect, FRAGMENT } from './glsl_effect.js';
import { readShader } from '../utils/file.js';
const [declarations, code] = readShader(import.meta.url, 'shader/clip_shadow.frag');
export const ClipShadowEffect = GObject.registerClass({}, class extends GLSLEffect {
    buildPipeline() {
        this.add_glsl_snippet(FRAGMENT, declarations, code, false);
    }
});
