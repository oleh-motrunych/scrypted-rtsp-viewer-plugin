const config = require(process.env.SCRYPTED_DEFAULT_WEBPACK_CONFIG);
const path = require('node:path');

// The SDK ships CommonJS containing import.meta for its optional ESM loader.
// Keep webpack from interpreting that file as an ES module and losing its exports.
config.module.rules.push({
  test: /@scrypted[\\/]sdk[\\/]dist[\\/]src[\\/]index\.js$/,
  type: 'javascript/dynamic',
  use: path.resolve(__dirname, 'scripts/scrypted-sdk-loader.cjs'),
});

module.exports = config;
