#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const conflictFiles = ['package.json', 'package-lock.json'];
const installCommand = 'npm install';

function hasMarkers(str) {
  return str.includes('<<<<<<<') || str.includes('=======') || str.includes('>>>>>>>');
}

function versionNums(v) {
  const m = v.match(/[0-9]+(\.[0-9]+)*/);
  return m ? m[0].split('.').map(Number) : [0];
}

function higherVersion(a, b) {
  const va = versionNums(a);
  const vb = versionNums(b);
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const x = va[i] || 0;
    const y = vb[i] || 0;
    if (x > y) return a;
    if (x < y) return b;
  }
  return a;
}

function mergeDeps(a = {}, b = {}) {
  const out = { ...a };
  for (const [name, ver] of Object.entries(b)) {
    out[name] = out[name] ? higherVersion(out[name], ver) : ver;
  }
  return out;
}

function deepMerge(a = {}, b = {}) {
  const result = { ...a };
  for (const [key, val] of Object.entries(b)) {
    if (key === 'dependencies' || key === 'devDependencies') {
      result[key] = mergeDeps(a[key], val);
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      result[key] = deepMerge(a[key] || {}, val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

function resolveFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (!hasMarkers(raw)) {
    return JSON.parse(raw);
  }
  const oursMatch = raw.match(/<<<<<<<[^\n]*\n([\s\S]*?)=======/);
  const theirsMatch = raw.match(/=======\n([\s\S]*?)>>>>>>>/);
  if (!oursMatch || !theirsMatch) {
    throw new Error(`Unable to parse conflict markers in ${file}`);
  }
  const ours = JSON.parse(oursMatch[1]);
  const theirs = JSON.parse(theirsMatch[1]);
  const merged = deepMerge(ours, theirs);
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

function run(cmd) {
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (err) {
    throw new Error(`Command failed: ${cmd}\n${err.message}`);
  }
}

function main() {
  let pkg;
  for (const file of conflictFiles) {
    const resolved = resolveFile(path.resolve(process.cwd(), file));
    if (path.basename(file) === 'package.json') pkg = resolved;
  }
  run(installCommand);
  if (pkg && pkg.scripts && pkg.scripts.lint) {
    run('npm run lint');
  }
  if (pkg && pkg.scripts && pkg.scripts.test) {
    run('npm test');
  }
  console.log('✅ Conflicts resolved, install & lint/tests passed');
}

main();
