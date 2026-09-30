const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const SRC = path.join(ROOT, "extension");
const DIST = path.join(ROOT, "dist");

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function buildTarget(name, manifestFile) {
  const outDir = path.join(DIST, name);
  fs.rmSync(outDir, { recursive: true, force: true });
  copyRecursive(SRC, outDir);
  fs.copyFileSync(path.join(ROOT, manifestFile), path.join(outDir, "manifest.json"));
  console.log(`נבנה: dist/${name}`);
}

const targets = process.argv.slice(2);
const buildChrome = targets.length === 0 || targets.includes("chrome");
const buildFirefox = targets.length === 0 || targets.includes("firefox");

if (buildChrome) buildTarget("chrome", "manifest.chrome.json");
if (buildFirefox) buildTarget("firefox", "manifest.firefox.json");
