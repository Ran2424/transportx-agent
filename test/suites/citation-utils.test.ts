const { registerSuite } = require('../support/test-suite.ts');
require('../cases/citation-compiler.cases.ts');
require('../cases/citation-projection.cases.ts');
require('../cases/citation-registry.cases.ts');
registerSuite('citation-utils');
