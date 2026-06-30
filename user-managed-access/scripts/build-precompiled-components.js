#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(root, '..');
const compiler = path.join(root, 'node_modules', '.bin', 'componentsjs-compile-config');
const wildcardRange = { '@type': 'ParameterRangeWildcard' };

function run(command, args, options = {}) {
  console.error(`$ ${[command, ...args].join(' ')}`);
  return execFileSync(command, args, {
    cwd: root,
    stdio: options.stdout ? [ 'ignore', options.stdout, 'inherit' ] : 'inherit',
  });
}

function listJsonLdFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const location = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listJsonLdFiles(location));
    } else if (entry.isFile() && location.endsWith('.jsonld')) {
      result.push(location);
    }
  }
  return result;
}

function walkJson(value, options) {
  if (!value || typeof value !== 'object') {
    return;
  }
  if (Object.prototype.hasOwnProperty.call(value, '')) {
    delete value[''];
  }
  if (options.relaxRanges && Object.prototype.hasOwnProperty.call(value, 'range')) {
    value.range = wildcardRange;
  }
  for (const child of Object.values(value)) {
    walkJson(child, options);
  }
}

function sanitizeJsonLdFiles(files, options = {}) {
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    walkJson(data, options);
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  }
}

function sanitizeCompileMetadata() {
  const emptyTermRoots = [
    path.join(root, 'node_modules'),
    path.join(workspaceRoot, 'node_modules'),
    path.join(root, 'packages', 'uma', 'dist'),
    path.join(root, 'packages', 'css', 'dist'),
  ];
  sanitizeJsonLdFiles(emptyTermRoots.flatMap(listJsonLdFiles));

  const rangeRoots = [
    path.join(root, 'packages', 'uma', 'dist'),
    path.join(root, 'packages', 'css', 'dist'),
    path.join(root, 'node_modules', '@solid', 'community-server', 'dist'),
    path.join(root, 'node_modules', 'asynchronous-handlers', 'dist'),
  ];
  sanitizeJsonLdFiles(rangeRoots.flatMap(listJsonLdFiles), { relaxRanges: true });
}

function compile(instance, config, mainModulePath, output) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const fd = fs.openSync(output, 'w');
  try {
    run('node', [
      compiler,
      instance,
      '-c',
      config,
      '-p',
      mainModulePath,
      '-f',
    ], { stdout: fd });
  } finally {
    fs.closeSync(fd);
  }
  patchPrecompiledRequires(output);
}

function patchPrecompiledRequires(output) {
  let content = fs.readFileSync(output, 'utf8');
  content = content.replaceAll("require('./dist/index.js')", "require('../index.js')");
  fs.writeFileSync(output, content);
}

function main() {
  run('yarn', [ 'workspace', '@solidlab/uma-css', 'run', 'build' ]);
  run('yarn', [ 'workspace', '@solidlab/uma', 'run', 'build' ]);
  sanitizeCompileMetadata();

  compile(
    'urn:solid-server:default:App',
    'packages/css/config/precompiled/auth.json',
    'packages/css',
    path.join(root, 'packages', 'css', 'dist', 'precompiled', 'app-auth.js')
  );
  compile(
    'urn:solid-server:default:App',
    'packages/css/config/precompiled/no-auth.json',
    'packages/css',
    path.join(root, 'packages', 'css', 'dist', 'precompiled', 'app-no-auth.js')
  );

  for (const mode of [ 'no-auth', 'nondelegated', 'delegated' ]) {
    compile(
      'urn:uma:default:App',
      `packages/uma/config/${mode}.json`,
      'packages/uma',
      path.join(root, 'packages', 'uma', 'dist', 'precompiled', `app-${mode}.js`)
    );
  }
}

main();
