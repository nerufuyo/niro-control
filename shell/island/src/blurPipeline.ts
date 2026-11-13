// @ts-nocheck: GLib variants are untyped here
// Blur's strength lives in its `pipelines` setting (its default pipeline's blur radius), not in the old `sigma` key.
import GLib from 'gi://GLib';

const isBlur = effect => effect.type.deep_unpack().includes('blur');

/** The default pipeline's effects as plain objects of variants, and the whole setting around it. */
function unpack(root) {
    const pipelines = root.get_value('pipelines').deep_unpack();
    const effects = pipelines.pipeline_default.effects.deep_unpack().map(effect => effect.deep_unpack());
    return {pipelines, effects};
}

/** Sets the radius of the default pipeline's blur; `root` is Blur's own settings (the root schema). */
export function setBlurRadius(root, radius: number) {
    const {pipelines, effects} = unpack(root);
    const blur = effects.find(isBlur);
    if (!blur)
        return false;
    const params = blur.params.deep_unpack();
    params.unscaled_radius = GLib.Variant.new_int32(Math.max(0, Math.round(radius)));
    blur.params = new GLib.Variant('a{sv}', params);
    pipelines.pipeline_default.effects = new GLib.Variant('av', effects.map(effect => new GLib.Variant('a{sv}', effect)));
    root.set_value('pipelines', new GLib.Variant('a{sa{sv}}', pipelines));
    return true;
}

/** The radius now set on the default pipeline's blur, or null. */
export function blurRadius(root) {
    const blur = unpack(root).effects.find(isBlur);
    return blur ? blur.params.deep_unpack().unscaled_radius.deep_unpack() : null;
}
