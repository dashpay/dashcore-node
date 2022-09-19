'use strict';

var path = require('path');
var fs = require('fs');

/**
 * Will return the path and default dashcore-node configuration. It will search for the
 * configuration file in the "~/.dashcore" directory, and if it doesn't exist, it will create one
 * based on default settings.
 * @param {Object} [options]
 * @param {Array} [options.additionalServices] - An optional array of services.
 */
function getDefaultConfig(options) {
  /* jshint maxstatements: 40 */
  if (!options) {
    options = {};
  }

  var defaultPath = path.resolve(process.env.HOME, './.dashcore');
  var defaultConfigFile = path.resolve(defaultPath, './dashcore-node.json');

  if (!fs.existsSync(defaultPath)) {
    fs.mkdirSync(defaultPath, { recursive: true });
  }

  var defaultServices = ['dashd', 'web'];
  if (options.additionalServices) {
    defaultServices = defaultServices.concat(options.additionalServices);
  }

  if (!fs.existsSync(defaultConfigFile)) {

    var defaultConfig = {
      network: 'livenet',
      port: 3001,
      services: defaultServices,
      servicesConfig: {
        dashd: {
          connect: [{
            rpchost: '127.0.0.1',
            rpcport: 9998,
            rpcuser: 'dash',
            rpcpassword: 'local321',
            zmqpubrawtx: 'tcp://127.0.0.1:28332'
          }]
        }
      }
    };
    fs.writeFileSync(defaultConfigFile, JSON.stringify(defaultConfig, null, 2));
  }

  var defaultDataDir = path.resolve(defaultPath, './data');

  if (!fs.existsSync(defaultDataDir)) {
    fs.mkdirSync(defaultDataDir, { recursive: true });
  }

  var config = JSON.parse(fs.readFileSync(defaultConfigFile, 'utf-8'));

  return {
    path: defaultPath,
    config: config
  };

}

module.exports = getDefaultConfig;
