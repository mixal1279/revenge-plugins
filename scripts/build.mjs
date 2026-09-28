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
  react: "(vendetta.metro.common.React||window.React)",
  "react-native": "(vendetta.metro.common.ReactNative||window.ReactNative)",
  "@revenge-mod": "vendetta",
  "@revenge-mod/metro": "vendetta.metro",
  "@revenge-mod/metro/common": "vendetta.metro.common",
  "@revenge-mod/patcher": "vendetta.patcher",
  "@revenge-mod/ui": "vendetta.ui",
  "@revenge-mod/ui/toasts": "vendetta.ui.toasts",
  "@revenge-mod/ui/assets": "vendetta.ui.assets",
  "@revenge-mod/plugin": "vendetta.plugin"
};

bundled = bundled.replace(/require\("([^"]+)"\)/g, (match, id) => {
  const mapped = requireMap[id];
  if (!mapped) throw new Error("Unmapped require in bundle: " + id);
  return mapped;
});

const wrapped = '(function(vendetta){' + bundled +
  '\nvar _exp=typeof module!=="undefined"?module.exports:{};' +
  '\nvar _plugin=(_exp&&_exp.__esModule&&_exp.default!=null)?_exp.default:(_exp&&_exp.default!=null?_exp.default:_exp);' +
  '\nreturn _plugin;' +
  '\n})(vendetta)';

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
