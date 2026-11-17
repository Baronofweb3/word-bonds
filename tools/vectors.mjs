// Simulate the synthesised netlist and write test vectors: one line per case, "inputsHex outputsHex".
import { readFileSync, writeFileSync } from 'node:fs';
import { compile, decodeNetlist, hexToBytes, bytesToHex, pack, step } from '../tapesynth/packages/core/dist/index.js';
const t = JSON.parse(readFileSync('circuits/hold_rule.tsyn.json', 'utf8'));
const c = compile(decodeNetlist(hexToBytes(t.netlist)), t.nIn, t.nOut);
const bits = (held, floor, expired) => { const b = []; for (let i = 0; i < 16; i++) b.push((held >> i) & 1); for (let i = 0; i < 16; i++) b.push((floor >> i) & 1); b.push(expired); return b; };
let seed = 0x9e3779b9; const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed; };
const edge = [0, 1, 2, 255, 256, 257, 4999, 5000, 5001, 9999, 10000, 10001, 32767, 32768, 65534, 65535];
const cases = [];
for (const h of edge) for (const f of edge) for (const e of [0, 1]) cases.push([h, f, e]);
for (let i = 0; i < 3000; i++) cases.push([rnd() & 0xffff, rnd() & 0xffff, rnd() & 1]);
for (let i = 0; i < 1000; i++) { const f = rnd() & 0xffff; const d = (rnd() % 5) - 2; cases.push([Math.min(65535, Math.max(0, f + d)), f, rnd() & 1]); }
let lines = [], bad = 0;
for (const [h, f, e] of cases) {
  const o = step(c, [], bits(h, f, e)).outputs;
  const expBreach = h < f ? 1 : 0, expRelease = e && !(h < f) ? 1 : 0;
  if (o[0] !== expBreach || o[1] !== expRelease) bad++;
  lines.push(bytesToHex(pack(bits(h, f, e))).slice(2) + ' ' + bytesToHex(pack(o)).slice(2));
}
writeFileSync('circuits/hold_rule.vectors.txt', lines.join('\n') + '\n');
console.log('cases', cases.length, 'mismatch vs spec', bad, 'sample', lines[0], lines[5], lines[lines.length - 1]);
