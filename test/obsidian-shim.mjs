// Minimal stand-in for the Obsidian API used by mock integration and executor
// tests. It never reads or writes a real vault.
export async function requestUrl(opts) {
  const { url, method = "GET", headers = {}, contentType, body } = opts;
  const doThrow = opts.throw !== false;
  const h = { ...headers };
  if (contentType) h["Content-Type"] = contentType;
  const res = await fetch(url, {
    method,
    headers: h,
    body: body instanceof ArrayBuffer ? Buffer.from(body) : body,
  });
  const arrayBuffer = await res.arrayBuffer();
  const text = new TextDecoder().decode(arrayBuffer);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON responses (including resumable 308s) are expected.
  }
  if (doThrow && res.status >= 400) {
    throw new Error(`Request failed, status ${res.status}`);
  }
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    arrayBuffer,
    text,
    json,
  };
}

export const Platform = { isDesktopApp: true };

export class App {}

const SharedTFile = globalThis.__obsidianTestTFile ?? class TFile {
  constructor(path, bytes = new ArrayBuffer(0), mtime = Date.now()) {
    this.path = path;
    this.stat = { mtime, size: bytes.byteLength };
  }
};
globalThis.__obsidianTestTFile = SharedTFile;
export { SharedTFile as TFile };

class MockElement {
  empty() {}
  createEl() { return new MockElement(); }
  createDiv() { return new MockElement(); }
  setText() {}
  addClass() {}
  detach() {}
  querySelectorAll() { return []; }
}

const SharedNotice = globalThis.__obsidianTestNotice ?? class Notice {
  static messages = [];
  constructor(message) {
    this.message = String(message);
    SharedNotice.messages.push(this.message);
  }
};
globalThis.__obsidianTestNotice = SharedNotice;
export { SharedNotice as Notice };

export class Plugin {
  constructor(app = {}) {
    this.app = app;
    this.manifest = { id: "owen-google-drive-sync" };
    this.__data = null;
  }
  async loadData() { return this.__data; }
  async saveData(data) { this.__data = structuredClone(data); }
  addStatusBarItem() { return new MockElement(); }
  addRibbonIcon() { return new MockElement(); }
  addCommand() {}
  addSettingTab() {}
  registerEvent() {}
  registerDomEvent() {}
}

export class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl = new MockElement();
  }
  setTitle() {}
  open() { this.onOpen?.(); }
  close() { this.onClose?.(); }
}

class Component {
  constructor() {
    this.inputEl = {};
  }
  setButtonText() { return this; }
  setCta() { return this; }
  setWarning() { return this; }
  setPlaceholder() { return this; }
  setValue() { return this; }
  onClick(callback) { this.click = callback; return this; }
  onChange(callback) { this.change = callback; return this; }
}

export class Setting {
  constructor() {}
  setName() { return this; }
  setDesc() { return this; }
  addButton(callback) { callback(new Component()); return this; }
  addText(callback) { callback(new Component()); return this; }
  addTextArea(callback) { callback(new Component()); return this; }
  addToggle(callback) { callback(new Component()); return this; }
}

export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = new MockElement();
  }
}

export class FileView {}

export function normalizePath(path) {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
