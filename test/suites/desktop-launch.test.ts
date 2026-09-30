const { registerSuite } = require('../support/test-suite.ts');
require('../cases/agent-host-desktop.cases.ts');
require('../cases/session-pi-launch.cases.ts');
registerSuite('desktop-launch');
