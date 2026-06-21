const path = require('path');
const { ComponentsManager } = require('componentsjs');
const { ModuleStateBuilder } = require('componentsjs/lib/loading/ModuleStateBuilder');
const { setGlobalLoggerFactory, WinstonLoggerFactory } = require('@solid/community-server');

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const [key, value] = arg.includes('=') ? arg.split('=') : [arg, argv[i + 1]];
    const normalizedKey = key.replace(/^--/, '');
    if (value === undefined || value.startsWith('--')) {
      result[normalizedKey] = true;
      if (value && value.startsWith('--')) {
        i--;
      }
    } else {
      result[normalizedKey] = value;
      if (!arg.includes('=')) {
        i++;
      }
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const logLevel = (args['log-level'] || 'info').toLowerCase();
  const port = Number(args.port || 4000);
  if (!Number.isFinite(port)) {
    throw new Error(`Invalid UMA port value: ${args.port}`);
  }
  const rootDir = path.join(__dirname, '../');
  const baseUrl = args['base-url'] || `http://localhost:${port}/uma`;
  const policyBase = args['policy-base'] || 'http://localhost:3000/';

  const variables = {};
  variables['urn:uma:variables:port'] = port;
  variables['urn:uma:variables:baseUrl'] = baseUrl;
  variables['urn:uma:variables:policyBaseIRI'] = policyBase;
  variables['urn:uma:variables:policyDir'] = path.join(rootDir, './config/rules/policy');
  variables['urn:uma:variables:eyePath'] = 'eye';

  const configPath = path.resolve(rootDir, args['config-location'] || './config/default.json');
  const workspaceRoot = path.join(rootDir, '../..');

  setGlobalLoggerFactory(new WinstonLoggerFactory(logLevel));

  const moduleStateBuilder = new ModuleStateBuilder();
  const nodeModuleImportPaths = [rootDir, workspaceRoot];
  const nodeModulePaths = await moduleStateBuilder.buildNodeModulePaths(nodeModuleImportPaths);
  const packageJsons = await moduleStateBuilder.buildPackageJsons(nodeModulePaths);
  await moduleStateBuilder.preprocessPackageJsons(packageJsons);
  const componentModules = await moduleStateBuilder.buildComponentModules(packageJsons);
  const contexts = await moduleStateBuilder.buildComponentContexts(packageJsons);
  const importPaths = await moduleStateBuilder.buildComponentImportPaths(packageJsons);

  const manager = await ComponentsManager.build({
    mainModulePath: rootDir,
    moduleState: {
      mainModulePath: rootDir,
      nodeModuleImportPaths,
      nodeModulePaths,
      packageJsons,
      componentModules,
      contexts,
      importPaths,
    },
    logLevel,
    typeChecking: false,
  });

  await manager.configRegistry.register(configPath);

  const umaServer = await manager.instantiate('urn:uma:default:App',{variables});
  await umaServer.start();
};

main().catch((error) => {
  console.error('Failed to start UMA server:', error);
  process.exit(1);
});
