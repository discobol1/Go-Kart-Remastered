'use strict';

/**
 * Legacy entry point — runs the full debug suite (superset of original integration tests).
 */
const { main } = require('./debug-suite');

main().then((result) => process.exit(result.ok ? 0 : 1)).catch((err) => {
  console.error(err);
  process.exit(1);
});
