#!/usr/bin/env node

if (require.main === module) {
  const { resolveAppPaths } = require('./app-paths.js');
  const { initializeHostLogging } = require('./diagnostic-log.js');
  initializeHostLogging(resolveAppPaths().logsDir, process.env.TAU_DESKTOP !== '1' && !process.argv.includes('--desktop'));
}

const tau = require('./server-main.js');

if (require.main === module) {
  tau.startCli();
}

module.exports = tau;
