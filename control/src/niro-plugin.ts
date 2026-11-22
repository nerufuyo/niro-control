// @ts-nocheck: gjs entry
// niro-plugin: the plugin manifest checker (validation only). Runs under `gjs -m`.
import System from 'system';

import {runPluginCli} from './pluginCli.js';

System.exit(runPluginCli(ARGV));
