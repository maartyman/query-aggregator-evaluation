#!/usr/bin/env node

const path = require('node:path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { setGlobalLoggerFactory, WinstonLoggerFactory } = require('global-logger-factory');

const argv = yargs(hideBin(process.argv))
  .option('port', {
    alias: 'p',
    type: 'number',
    description: 'Port number for the UMA server',
    default: 4000
  })
  .option('baseUrl', {
    alias: 'b',
    type: 'string',
    description: 'Base URL for the UMA server',
    default: 'http://localhost:4000/uma'
  })
  .option('loggingLevel', {
    alias: 'l',
    type: 'string',
    description: 'Log level for the UMA server',
    default: 'info'
  })
  .option('logLevel', {
    type: 'string',
    description: 'Log level for the UMA server'
  })
  .option('configLocation', {
    type: 'string',
    description: 'Original config location, used to select the precompiled mode',
    default: './config/default.json'
  })
  .option('mode', {
    type: 'string',
    choices: [ 'no-auth', 'nondelegated', 'delegated' ],
    description: 'Precompiled authorization mode'
  })
  .option('resourceRegistrationAuthorizedWebId', {
    type: 'string',
    description: 'WebID that receives all registered scopes for every registered resource',
    default: ''
  })
  .help()
  .alias('help', 'h')
  .argv;

function modeFromConfigLocation(configLocation) {
  if (configLocation.includes('no-auth')) {
    return 'no-auth';
  }
  if (configLocation.includes('delegated')) {
    return 'delegated';
  }
  if (configLocation.includes('nondelegated')) {
    return 'nondelegated';
  }
  return 'nondelegated';
}

async function main() {
  const mode = argv.mode || modeFromConfigLocation(argv.configLocation);
  const createApp = require(path.join('../dist/precompiled', `app-${mode}.js`));
  const loggingLevel = argv.logLevel || argv.loggingLevel;

  setGlobalLoggerFactory(new WinstonLoggerFactory(loggingLevel));

  const variables = {
    'urn:uma:variables:port': argv.port,
    'urn:uma:variables:baseUrl': argv.baseUrl,
    'urn:uma:variables:eyePath': 'eye',
    'urn:uma:variables:resourceRegistrationAuthorizedWebId': argv.resourceRegistrationAuthorizedWebId,
  };

  const umaServer = createApp(variables);
  await umaServer.start();
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
