#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const INCLUDE_DIRS = ['icons', 'src'];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function copyDirRecursive(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function createZip(sourceDir, zipPath) {
  if (fs.existsSync(zipPath)) {
    fs.rmSync(zipPath, { force: true });
  }
  execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: sourceDir });
}

function buildTarget(targetName, manifestObj) {
  const version = manifestObj.version || '1.0.0';
  const outDir = path.join(DIST_DIR, targetName);
  const zipPath = path.join(DIST_DIR, `subclick-${targetName}-v${version}.zip`);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const dir of INCLUDE_DIRS) {
    copyDirRecursive(path.join(ROOT, dir), path.join(outDir, dir));
  }

  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(manifestObj, null, 2) + '\n',
    'utf8'
  );

  createZip(outDir, zipPath);
  return { outDir, zipPath };
}

function buildAll() {
  const baseManifest = readJson(path.join(ROOT, 'manifest.json'));
  const firefoxOverrides = readJson(path.join(ROOT, 'manifest.firefox.json'));

  // Clean Chrome MV3 manifest (no Gecko keys or background.scripts)
  const chromeManifest = Object.assign({}, baseManifest);
  delete chromeManifest.browser_specific_settings;
  if (chromeManifest.background && chromeManifest.background.scripts) {
    delete chromeManifest.background.scripts;
  }

  // Clean Firefox MV3 manifest (Event Page scripts + Gecko settings + data_collection_permissions)
  const firefoxManifest = Object.assign({}, baseManifest, firefoxOverrides);

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const chromeOut = buildTarget('chrome', chromeManifest);
  const firefoxOut = buildTarget('firefox', firefoxManifest);

  return { chrome: chromeOut, firefox: firefoxOut };
}

if (require.main === module) {
  const result = buildAll();
  console.log('Built Chrome package :', result.chrome.zipPath);
  console.log('Built Firefox package:', result.firefox.zipPath);
  console.log('Unpacked Chrome dir  :', result.chrome.outDir);
  console.log('Unpacked Firefox dir :', result.firefox.outDir);
}

module.exports = { buildAll };
