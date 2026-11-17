import { readFileSync, writeFileSync } from 'node:fs';
import { synthesize } from '../tapesynth/packages/synth/dist/index.js';
import { compile, decodeNetlist, hexToBytes, pack, step } from '../tapesynth/packages/core/dist/index.js';
const [,, src, out] = process.argv;
const r = await synthesize({ kind: 'verilog', source: readFileSync(src, 'utf8'), objective: 'area' });
const { candidates, warnings, log, ...tsyn } = r;
writeFileSync(out, JSON.stringify(tsyn, null, 1));
console.log(JSON.stringify({ nIn: r.nIn, nOut: r.nOut, nState: r.nState, metrics: r.metrics, verification: r.verification, pins: r.pins, warnings }, null, 1));
