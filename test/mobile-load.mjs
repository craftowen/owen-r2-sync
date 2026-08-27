import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const source = await readFile(new URL("../main.js", import.meta.url), "utf8");
class Empty {}
const obsidian = {
  App: Empty,
  FileView: Empty,
  Modal: Empty,
  Notice: Empty,
  Platform: { isDesktopApp: false },
  Plugin: Empty,
  PluginSettingTab: Empty,
  Setting: Empty,
  TFile: Empty,
  normalizePath: (path) => path,
  requestUrl: () => {
    throw new Error("requestUrl must not run while loading the mobile bundle");
  },
};
const forbidden = [];
const module = { exports: {} };
vm.runInNewContext(source, {
  module,
  exports: module.exports,
  require(id) {
    if (id === "obsidian") return obsidian;
    forbidden.push(id);
    throw new Error(`Forbidden mobile module load: ${id}`);
  },
  window: {
    setTimeout,
    clearTimeout,
    open() {},
  },
  document: {},
  navigator: {},
  crypto: webcrypto,
  TextDecoder,
  TextEncoder,
  URL,
  URLSearchParams,
  atob,
  btoa,
  console,
});

assert.equal(typeof module.exports.default, "function");
assert.deepEqual(forbidden, []);
console.log("mobile load: bundle loaded without Node or Electron runtime access");
