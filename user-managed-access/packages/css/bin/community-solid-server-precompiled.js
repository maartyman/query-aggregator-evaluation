#!/usr/bin/env node

const path = require('node:path');

function getConfigArgs(argv) {
  const configs = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-c' || arg === '--config') {
      while (argv[i + 1] && !argv[i + 1].startsWith('-')) {
        configs.push(argv[++i]);
      }
    } else if (arg.startsWith('--config=')) {
      configs.push(arg.slice('--config='.length));
    }
  }
  return configs;
}

function readOption(argv, names, fallback) {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    for (const name of names) {
      if (arg === name && argv[i + 1] && !argv[i + 1].startsWith('-')) {
        return argv[i + 1];
      }
      if (arg.startsWith(`${name}=`)) {
        return arg.slice(name.length + 1);
      }
    }
  }
  return fallback;
}

function createVariables(argv) {
  return {
    'urn:solid-server:default:variable:baseUrl': readOption(argv, [ '--baseUrl', '--base-url', '-b' ], 'http://localhost:3000/'),
    'urn:solid-server:default:variable:loggingLevel': readOption(argv, [ '--loggingLevel', '--log-level', '-l' ], 'info'),
    'urn:solid-server:default:variable:port': Number(readOption(argv, [ '--port', '-p' ], '3000')),
    'urn:solid-server:default:variable:socket': readOption(argv, [ '--socket' ], undefined),
    'urn:solid-server:default:variable:rootFilePath': readOption(argv, [ '--rootFilePath', '--root-file-path', '-f' ], './.data'),
    'urn:solid-server:default:variable:sparqlEndpoint': readOption(argv, [ '--sparqlEndpoint', '--sparql-endpoint' ], undefined),
    'urn:solid-server:default:variable:showStackTrace': readOption(argv, [ '--showStackTrace', '--show-stack-trace' ], 'false') === 'true',
    'urn:solid-server:default:variable:podConfigJson': readOption(argv, [ '--podConfigJson', '--pod-config-json' ], undefined),
    'urn:solid-server:default:variable:seedConfig': readOption(argv, [ '--seedConfig', '--seed-config' ], undefined),
    'urn:solid-server:default:variable:workers': Number(readOption(argv, [ '--workers' ], '1')),
    'urn:solid-server:default:variable:confirmMigration': readOption(argv, [ '--confirmMigration', '--confirm-migration' ], 'false') === 'true',
  };
}

function selectApp(argv) {
  const configs = getConfigArgs(argv);
  const isNoAuth = configs.some((config) => config.endsWith('/no-auth.json') || config.endsWith('config/no-auth.json'));
  const app = isNoAuth ? 'app-no-auth.js' : 'app-auth.js';
  return require(path.join('../dist/precompiled', app));
}

async function main() {
  const variables = createVariables(process.argv);
  const createApp = selectApp(process.argv);
  const app = createApp(variables);
  await app.start();
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
