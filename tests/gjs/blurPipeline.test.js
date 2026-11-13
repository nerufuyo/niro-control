// Run: GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR=<blur schemas> gjs -m tests/gjs/blurPipeline.test.js
import Gio from 'gi://Gio';
import {blurRadius, setBlurRadius} from '../../shell/island/build/src/blurPipeline.js';

const root = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.blur-my-shell'});
const before = blurRadius(root);
if (before !== 30) throw new Error(`default radius should be 30, got ${before}`);
if (!setBlurRadius(root, 12)) throw new Error('setBlurRadius found no blur effect');
if (blurRadius(root) !== 12) throw new Error(`radius should be 12, got ${blurRadius(root)}`);
const light = root.get_value('pipelines').deep_unpack().pipeline_default_light.effects.deep_unpack().length;
if (light !== 2) throw new Error('other pipelines must stay as they were');
print('blurPipeline: ok');
