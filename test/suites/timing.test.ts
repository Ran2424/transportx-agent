const { registerSuite } = require('../support/test-suite.ts');
require('../cases/session-event-timing.cases.ts');
require('../cases/timing-metrics.cases.ts');
registerSuite('timing');
