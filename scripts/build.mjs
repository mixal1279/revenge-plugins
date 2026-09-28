import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as esbuild from "esbuild";

const entry = "GlobalSearch/src/index.ts";
const out = "GlobalSearch/index.js";

const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  minify: true,
  write: false,
  format: "cjs",
  platform: "neutral",
  target: ["es2015"],
  external: [
    "react",
    "react-native",
    "@revenge-mod",
    "@revenge-mod/metro",
    "@revenge-mod/metro/common",
    "@revenge-mod/patcher",
    "@revenge-mod/ui",
    "@revenge-mod/ui/toasts",
    "@revenge-mod/ui/assets",
    "@revenge-mod/plugin"
  ]
});

let bundled = result.outputFiles[0].text;

const requireMap = {
  react: "(bunny.metro.common.React||window.React)",
  "react-native": "(bunny.metro.common.ReactNative||window.ReactNative)",
  "@revenge-mod": "bunny",
  "@revenge-mod/metro": "bunny.metro",
  "@revenge-mod/metro/common": "bunny.metro.common",
  "@revenge-mod/patcher": "bunny.patcher",
  "@revenge-mod/ui": "bunny.ui",
  "@revenge-mod/ui/toasts": "bunny.ui.toasts",
  "@revenge-mod/ui/assets": "bunny.ui.assets",
  "@revenge-mod/plugin": "({ storage: (bunny.plugin?.createStorage ? bunny.plugin.createStorage() : bunny.plugin?.storage) })"
};

bundled = bundled.replace(/require\("([^"]+)"\)/g, (match, id) => {
  const mapped = requireMap[id];
  if (!mapped) throw new Error("Unmapped require in bundle: " + id);
  return mapped;
});

const wrapped =
  '(function(bunny){' +
  'var module={exports:{}};var exports=module.exports;\n' +
  bundled +
  '\n' +
  'globalThis.plugin=(module.exports&&module.exports.__esModule&&module.exports.default!=null)' +
  '?module.exports.default:(module.exports&&module.exports.default!=null?module.exports.default:module.exports);' +
  '})(bunny);';

await mkdir("GlobalSearch", { recursive: true });
await writeFile(out, wrapped);

const manifest = JSON.parse(await readFile("GlobalSearch/manifest.json", "utf8"));
manifest.main = "index.js";
manifest.hash = createHash("sha256").update(wrapped).digest("hex");

await writeFile(
  "GlobalSearch/manifest.json",
  JSON.stringify(manifest, null, 2) + "\n"
);

console.log("Built " + out + ": " + wrapped.length + " bytes");
