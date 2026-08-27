import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const packageDir = resolve(root, "dist", "owen-google-drive-sync");
const required = ["main.js", "manifest.json", "styles.css", "LICENSE"];

await rm(packageDir, { recursive: true, force: true });
await mkdir(packageDir, { recursive: true });
for (const file of required) {
  await copyFile(resolve(root, file), resolve(packageDir, file));
}

const manifest = JSON.parse(await readFile(resolve(packageDir, "manifest.json"), "utf8"));
if (manifest.id !== "owen-google-drive-sync" || manifest.isDesktopOnly !== false) {
  throw new Error("Packaged manifest does not match the private mobile plugin contract.");
}
const files = (await readdir(packageDir)).sort();
if (files.join(",") !== required.slice().sort().join(",")) {
  throw new Error(`Unexpected package contents: ${files.join(", ")}`);
}
console.log(`package: ${packageDir} (${files.join(", ")})`);
