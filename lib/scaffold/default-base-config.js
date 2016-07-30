'use strict';

var path = require('path');

/**
 * Will return the path and default bitcore-node-dash configuration on environment variables
 * or default locations.
 * @param {Object} options
 * @param {String} options.network - "testnet" or "livenet"
 * @param {String} options.datadir - Absolute path to bitcoin database directory
 */
function getDefaultBaseConfig(options) {
  if (!options) {
    options = {};
  }

  var datadir = options.datadir || path.resolve(process.env.HOME, '.dash');

  return {
    path: process.cwd(),
    config: {
      network: options.network || 'livenet',
      port: 3001,
      services: ['bitcoind', 'web'],
      servicesConfig: {
        bitcoind: {
          spawn: {
            datadir: datadir,
            exec: path.resolve(__dirname, datadir, 'dashd')
          }
        }
      }
    }
  };
}

module.exports = getDefaultBaseConfig;
