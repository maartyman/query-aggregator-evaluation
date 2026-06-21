#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { AppRunner } = require('@solid/community-server');
const { ComponentsManager } = require('componentsjs');
const { ModuleStateBuilder } = require('componentsjs/lib/loading/ModuleStateBuilder');
const { PrefetchedDocumentLoader } = require('componentsjs/lib/rdf/PrefetchedDocumentLoader');

function readComponentsContext(moduleRoot) {
  for (const fileName of [ 'context.json', 'context.jsonld' ]) {
    const contextPath = path.join(moduleRoot, 'node_modules', 'componentsjs', 'components', fileName);
    if (fs.existsSync(contextPath)) {
      return JSON.parse(fs.readFileSync(contextPath, 'utf8'));
    }
  }
}

function getLocalComponentsContextAliases(workspaceRoot) {
  const repoRoot = path.resolve(workspaceRoot, '..');
  const rootContext = readComponentsContext(repoRoot);
  const workspaceContext = readComponentsContext(workspaceRoot);

  return [
    [ 'https://linkedsoftwaredependencies.org/bundles/npm/componentsjs/^5.0.0/components/context.jsonld', workspaceContext ],
    [ 'https://linkedsoftwaredependencies.org/bundles/npm/componentsjs/^6.0.0/components/context.jsonld', rootContext || workspaceContext ],
  ];
}

function addLocalComponentsContextAliases(contexts, workspaceRoot) {
  const aliases = getLocalComponentsContextAliases(workspaceRoot);

  for (const [ url, context ] of aliases) {
    if (context) {
      contexts[url] = context;
    }
  }
}

function addDefaultComponentsContextAliases(workspaceRoot) {
  for (const [ url, context ] of getLocalComponentsContextAliases(workspaceRoot)) {
    if (context) {
      PrefetchedDocumentLoader.DEFAULT_CONTEXTS[url] = context;
    }
  }
}

async function buildIsolatedModuleState(mainModulePath) {
  const cssRoot = path.resolve(mainModulePath || process.cwd());
  const workspaceRoot = path.resolve(cssRoot, '../..');
  addDefaultComponentsContextAliases(workspaceRoot);
  const builder = new ModuleStateBuilder();
  const nodeModuleImportPaths = [cssRoot, workspaceRoot];
  const nodeModulePaths = await builder.buildNodeModulePaths(nodeModuleImportPaths);
  const packageJsons = await builder.buildPackageJsons(nodeModulePaths);
  await builder.preprocessPackageJsons(packageJsons);
  const componentModules = await builder.buildComponentModules(packageJsons);
  const contexts = await builder.buildComponentContexts(packageJsons);
  addLocalComponentsContextAliases(contexts, workspaceRoot);
  const importPaths = await builder.buildComponentImportPaths(packageJsons);

  return {
    mainModulePath: cssRoot,
    nodeModuleImportPaths,
    nodeModulePaths,
    packageJsons,
    componentModules,
    contexts,
    importPaths,
  };
}

class IsolatedAppRunner extends AppRunner {
  async createComponentsManager(loaderProperties, configs) {
    const moduleState = await buildIsolatedModuleState(loaderProperties.mainModulePath);
    const componentsManager = await ComponentsManager.build({
      ...loaderProperties,
      mainModulePath: moduleState.mainModulePath,
      moduleState,
    });

    for (const config of configs) {
      await componentsManager.configRegistry.register(config);
    }

    return componentsManager;
  }
}

process.on('uncaughtExceptionMonitor', (err, origin) => {
  console.error(`Process is halting due to an ${origin} with error ${err.message}`);
});

new IsolatedAppRunner().runCliSync(process);
