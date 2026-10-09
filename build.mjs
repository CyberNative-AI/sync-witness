// Bundles src/*.js (CommonJS) into the single main.js that Obsidian loads. No dependencies.
import fs from 'node:fs';
const modules = ['core', 'store', 'patch', 'main'];
let out = '/* Sync Witness — built from src/ by build.mjs */\n"use strict";\n';
out += 'const __modules = {};\nconst __cache = {};\n';
out += 'function __require(name) {\n  if (name === "obsidian") return require("obsidian");\n  const key = name.replace("./", "");\n  if (!__cache[key]) { const module = { exports: {} }; __cache[key] = module; __modules[key](module, module.exports); }\n  return __cache[key].exports;\n}\n';
for (const m of modules) {
  const src = fs.readFileSync(`src/${m}.js`, 'utf8').replace(/\brequire\(/g, '__require(');
  out += `__modules[${JSON.stringify(m)}] = function (module, exports) {\n${src}\n};\n`;
}
out += 'module.exports = __require("./main");\n';
fs.writeFileSync('main.js', out);
console.log(`main.js ${out.length} bytes`);
