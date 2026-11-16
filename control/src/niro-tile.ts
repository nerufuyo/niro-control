// @ts-nocheck: gjs entry
// niro-tile: the tiling's command line. Runs under `gjs -m`.
import System from 'system';

import {runTileCli} from './tileCli.js';

System.exit(runTileCli(ARGV));
