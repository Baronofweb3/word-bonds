// Builds the Word Bonds site into one self-contained file: ../site/index.html
//   cd web && npm install && node build.mjs [handleRegistryAddress]
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
const reg = process.argv[2] || '0x22c27b5a70b9c082911d7ec555d8fc9d8de1e0e3';
const r = await build({ entryPoints: ['app.js'], bundle: true, minify: true, format: 'iife', write: false, target: 'es2020',
  define: { __REGISTRY__: JSON.stringify(reg) }, logLevel: 'warning' });
const js = r.outputFiles[0].text.replace(/<\/script>/g, '<\\/script>');
const body = readFileSync('template.html', 'utf8').replace('/*BUNDLE*/', () => js);
const head = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n';
const cut = body.indexOf('<div class="shell">');
writeFileSync('../site/index.html', `${head}${body.slice(0, cut)}</head>\n<body>\n${body.slice(cut)}</body>\n</html>\n`);
console.log('wrote ../site/index.html');
