'use strict';

var fs = require('fs');
var path = require('path');
var spawn = require('child_process').spawn;
var util = require('util');
var dashcore = require('@dashevo/dashcore-lib');
var zmq = require('zeromq');
var async = require('async');
var LRU = require('lru-cache');
var DashdRPC = require('@dashevo/dashd-rpc');
var $ = dashcore.util.preconditions;
var _  = dashcore.deps._;
var Transaction = dashcore.Transaction;
var Proposal = dashcore.GovObject.Proposal;

var index = require('../');
var errors = index.errors;
var log = index.log;
var utils = require('../utils');
var Service = require('../service');
var rawtxTopicBuffer = new Buffer('7261777478', 'hex');
var rawtxlockTopicBuffer = new Buffer('72617774786c6f636b', 'hex');
/**
 * Provides a friendly event driven API to dashd in Node.js. Manages starting and
 * stopping dashd as a child process for application support, as well as connecting
 * to multiple dashd processes for server infrastructure. Results are cached in an
 * LRU cache for improved performance and methods added for common queries.
 *
 * @param {Object} options
 * @param {Node} options.node - A reference to the node
 */
function Dash(options) {
  if (!(this instanceof Dash)) {
    return new Dash(options);
  }

  Service.call(this, options);
  this.options = options;

  this._initCaches();

  // dashd child process
  this.spawn = false;

  // event subscribers
  this.subscriptions = {};
  this.subscriptions.rawtransaction = [];
  this.subscriptions.transactionlock = [];
  this.subscriptions.hashblock = [];
  this.subscriptions.address = {};

  // set initial settings
  this._initDefaults(options);

  // available dashd nodes
  this._initClients();

  // for testing purposes
  this._process = options.process || process;

  this.on('error', function(err) {
    log.error(err.stack);
  });
}
util.inherits(Dash, Service);

Dash.dependencies = [];

Dash.DEFAULT_MAX_TXIDS = 1000;
Dash.DEFAULT_MAX_HISTORY = 50;
Dash.DEFAULT_MAX_UTXO = 1000;
Dash.DEFAULT_SHUTDOWN_TIMEOUT = 15000;
Dash.DEFAULT_ZMQ_SUBSCRIBE_PROGRESS = 0.9999;
Dash.DEFAULT_MAX_ADDRESSES_QUERY = 10000;
Dash.DEFAULT_SPAWN_RESTART_TIME = 5000;
Dash.DEFAULT_SPAWN_STOP_TIME = 10000;
Dash.DEFAULT_TRY_ALL_INTERVAL = 1000;
Dash.DEFAULT_REINDEX_INTERVAL = 10000;
Dash.DEFAULT_START_RETRY_INTERVAL = 5000;
Dash.DEFAULT_TIP_UPDATE_INTERVAL = 15000;
Dash.DEFAULT_TRANSACTION_CONCURRENCY = 5;
Dash.DEFAULT_INSTANTSEND_FEE = 10000;
Dash.DEFAULT_CONFIG_SETTINGS = {
  server: 1,
  whitelist: '127.0.0.1',
  txindex: 1,
  addressindex: 1,
  timestampindex: 1,
  spentindex: 1,
  zmqpubrawtx: 'tcp://127.0.0.1:28332',
  zmqpubrawtxlock: 'tcp://127.0.0.1:28332',
  zmqpubhashblock: 'tcp://127.0.0.1:28332',
  rpcallowip: '127.0.0.1',
  rpcuser: 'dash',
  rpcpassword: 'local321',
  uacomment: 'dashcore'
};

Dash.prototype._initDefaults = function(options) {
  /* jshint maxcomplexity: 15 */

  // limits
  this.maxTxids = options.maxTxids || Dash.DEFAULT_MAX_TXIDS;
  this.maxTransactionHistory = options.maxTransactionHistory || Dash.DEFAULT_MAX_HISTORY;
  this.maxUTXOHistory = options.maxUTXOHistory || Dash.DEFAULT_MAX_UTXO;
  this.maxAddressesQuery = options.maxAddressesQuery || Dash.DEFAULT_MAX_ADDRESSES_QUERY;
  this.shutdownTimeout = options.shutdownTimeout || Dash.DEFAULT_SHUTDOWN_TIMEOUT;

  // spawn restart setting
  this.spawnRestartTime = options.spawnRestartTime || Dash.DEFAULT_SPAWN_RESTART_TIME;
  this.spawnStopTime = options.spawnStopTime || Dash.DEFAULT_SPAWN_STOP_TIME;

  // try all interval
  this.tryAllInterval = options.tryAllInterval || Dash.DEFAULT_TRY_ALL_INTERVAL;
  this.startRetryInterval = options.startRetryInterval || Dash.DEFAULT_START_RETRY_INTERVAL;

  // rpc limits
  this.transactionConcurrency = options.transactionConcurrency || Dash.DEFAULT_TRANSACTION_CONCURRENCY;

  // sync progress level when zmq subscribes to events
  this.zmqSubscribeProgress = options.zmqSubscribeProgress || Dash.DEFAULT_ZMQ_SUBSCRIBE_PROGRESS;
};

Dash.prototype._initCaches = function() {

  var CACHES = [
    {name:'utxos', lru:50000},
    {name:'txids', lru:50000},
    {name:'balance', lru:50000},
    {name:'summary', lru:50000},
    {name:'blockOverview', lru:144},
    {name:'transactionDetailed', lru:100000},
    {name:'masternodeList', lru:50000},
    {name:'sporksList', lru:50},
    //governance
    {name:'gov', lru:20},

    //cache valid indefinitely
    {name:'transaction', lru:100000},
    {name:'rawTransaction', lru:50000},
    {name:'block', lru:144},
    {name:'rawBlock', lru:72},
    {name:'blockHeader', lru:288}
  ];
  var self = this;
  CACHES.forEach(function (el) {
    self[el.name+'Cache']=LRU(el.lru);
  });
  // caches valid until there is a new block

  this.zmqKnownTransactions = LRU(5000);
  this.zmqKnownTransactionLocks = LRU(5000);
  this.zmqKnownBlocks = LRU(50);
  this.lastTip = 0;
  this.lastTipTimeout = false;

};

Dash.prototype._initClients = function() {
  var self = this;
  this.nodes = [];
  this.nodesIndex = 0;
  Object.defineProperty(this, 'client', {
    get: function() {
      var client = self.nodes[self.nodesIndex].client;
      self.nodesIndex = (self.nodesIndex + 1) % self.nodes.length;
      return client;
    },
    enumerable: true,
    configurable: false
  });
};

/**
 * Called by Node to determine the available API methods.
 */
Dash.prototype.getAPIMethods = function() {
  var methods = [
    ['getBlock', this, this.getBlock, 1],
    ['getRawBlock', this, this.getRawBlock, 1],
    ['getBlockHeader', this, this.getBlockHeader, 1],
    ['getBlockHeaders', this, this.getBlockHeaders, 1],
    ['getBlockOverview', this, this.getBlockOverview, 1],
    ['getBlockHashesByTimestamp', this, this.getBlockHashesByTimestamp, 2],
    ['getBestBlockHash', this, this.getBestBlockHash, 0],
    ['getBestChainLock', this, this.getBestChainLock, 0],
    ['getSpentInfo', this, this.getSpentInfo, 1],
    ['getMNList', this, this.getMNList, 1],
    ['getInfo', this, this.getInfo, 0],
    ['syncPercentage', this, this.syncPercentage, 0],
    ['isSynced', this, this.isSynced, 0],
    ['getRawTransaction', this, this.getRawTransaction, 1],
    ['getTransaction', this, this.getTransaction, 1],
    ['getDetailedTransaction', this, this.getDetailedTransaction, 1],
    ['sendTransaction', this, this.sendTransaction, 1],
    ['estimateFee', this, this.estimateFee, 1],
    ['getAddressTxids', this, this.getAddressTxids, 2],
    ['getAddressBalance', this, this.getAddressBalance, 2],
    ['getAddressUnspentOutputs', this, this.getAddressUnspentOutputs, 2],
    ['getAddressUnspentOutputsPaginated', this, this.getAddressUnspentOutputsPaginated, 2],
    ['getAddressHistory', this, this.getAddressHistory, 2],
    ['getAddressSummary', this, this.getAddressSummary, 1],
    ['generateBlock', this, this.generateBlock, 1]
  ];
  return methods;
};

/**
 * Called by the Bus to determine the available events.
 */
Dash.prototype.getPublishEvents = function() {
  return [
    {
      name: 'dashd/rawtransaction',
      scope: this,
      subscribe: this.subscribe.bind(this, 'rawtransaction'),
      unsubscribe: this.unsubscribe.bind(this, 'rawtransaction')
    },
    {
      name: 'dashd/transactionlock',
      scope: this,
      subscribe: this.subscribe.bind(this, 'transactionlock'),
      unsubscribe: this.unsubscribe.bind(this, 'transactionlock')
    },
    {
      name: 'dashd/hashblock',
      scope: this,
      subscribe: this.subscribe.bind(this, 'hashblock'),
      unsubscribe: this.unsubscribe.bind(this, 'hashblock')
    },
    {
      name: 'dashd/addresstxid',
      scope: this,
      subscribe: this.subscribeAddress.bind(this),
      unsubscribe: this.unsubscribeAddress.bind(this)
    }
  ];
};

Dash.prototype.subscribe = function(name, emitter) {
  this.subscriptions[name].push(emitter);
  log.info(emitter.remoteAddress, 'subscribe:', 'dashd/' + name, 'total:', this.subscriptions[name].length);
};

Dash.prototype.unsubscribe = function(name, emitter) {
  var index = this.subscriptions[name].indexOf(emitter);
  if (index > -1) {
    this.subscriptions[name].splice(index, 1);
  }
  log.info(emitter.remoteAddress, 'unsubscribe:', 'dashd/' + name, 'total:', this.subscriptions[name].length);
};

Dash.prototype.subscribeAddress = function(emitter, addresses) {
  var self = this;

  function addAddress(addressStr) {
    if(self.subscriptions.address[addressStr]) {
      var emitters = self.subscriptions.address[addressStr];
      var index = emitters.indexOf(emitter);
      if (index === -1) {
        self.subscriptions.address[addressStr].push(emitter);
      }
    } else {
      self.subscriptions.address[addressStr] = [emitter];
    }
  }
  if(addresses){
    for(var i = 0; i < addresses.length; i++) {
      if (dashcore.Address.isValid(addresses[i], this.node.network)) {
        addAddress(addresses[i]);
      }
    }
  }

  log.info(emitter.remoteAddress, 'subscribe:', 'dashd/addresstxid', 'total:', _.size(this.subscriptions.address));
};

Dash.prototype.unsubscribeAddress = function(emitter, addresses) {
  var self = this;
  if(!addresses) {
    return this.unsubscribeAddressAll(emitter);
  }

  function removeAddress(addressStr) {
    var emitters = self.subscriptions.address[addressStr];
    var index = emitters.indexOf(emitter);
    if(index > -1) {
      emitters.splice(index, 1);
      if (emitters.length === 0) {
        delete self.subscriptions.address[addressStr];
      }
    }
  }

  for(var i = 0; i < addresses.length; i++) {
    if(this.subscriptions.address[addresses[i]]) {
      removeAddress(addresses[i]);
    }
  }

  log.info(emitter.remoteAddress, 'unsubscribe:', 'dashd/addresstxid', 'total:', _.size(this.subscriptions.address));
};

/**
 * A helper function for the `unsubscribe` method to unsubscribe from all addresses.
 * @param {String} name - The name of the event
 * @param {EventEmitter} emitter - An instance of an event emitter
 */
Dash.prototype.unsubscribeAddressAll = function(emitter) {
  for(var hashHex in this.subscriptions.address) {
    var emitters = this.subscriptions.address[hashHex];
    var index = emitters.indexOf(emitter);
    if(index > -1) {
      emitters.splice(index, 1);
    }
    if (emitters.length === 0) {
      delete this.subscriptions.address[hashHex];
    }
  }
  log.info(emitter.remoteAddress, 'unsubscribe:', 'dashd/addresstxid', 'total:', _.size(this.subscriptions.address));
};

Dash.prototype._getDefaultConfig = function() {
  var config = '';
  var defaults = Dash.DEFAULT_CONFIG_SETTINGS;
  for(var key in defaults) {
    config += key + '=' + defaults[key] + '\n';
  }
  return config;
};

Dash.prototype._parseDashConf = function(configPath) {
  var options = {};
  var file = fs.readFileSync(configPath);
  var unparsed = file.toString().split('\n');
  for(var i = 0; i < unparsed.length; i++) {
    var line = unparsed[i];
    if (!line.match(/^\#/) && line.match(/\=/)) {
      var option = line.split('=');
      var value;
      if (!Number.isNaN(Number(option[1]))) {
        value = Number(option[1]);
      } else {
        value = option[1];
      }
      options[option[0]] = value;
    }
  }
  return options;
};

Dash.prototype._expandRelativeDatadir = function() {
  if (!utils.isAbsolutePath(this.options.spawn.datadir)) {
    $.checkState(this.node.configPath);
    $.checkState(utils.isAbsolutePath(this.node.configPath));
    var baseConfigPath = path.dirname(this.node.configPath);
    this.options.spawn.datadir = path.resolve(baseConfigPath, this.options.spawn.datadir);
  }
};

Dash.prototype._loadSpawnConfiguration = function(node) {
  /* jshint maxstatements: 25 */

  $.checkArgument(this.options.spawn, 'Please specify "spawn" in dashd config options');
  $.checkArgument(this.options.spawn.datadir, 'Please specify "spawn.datadir" in dashd config options');
  $.checkArgument(this.options.spawn.exec, 'Please specify "spawn.exec" in dashd config options');

  this._expandRelativeDatadir();

  var spawnOptions = this.options.spawn;
  var configPath = path.resolve(spawnOptions.datadir, './dash.conf');

  log.info('Using Dash config file:', configPath);

  this.spawn = {};
  this.spawn.datadir = this.options.spawn.datadir;
  this.spawn.exec = this.options.spawn.exec;
  this.spawn.configPath = configPath;
  this.spawn.config = {};

  if (!fs.existsSync(spawnOptions.datadir)) {
    fs.mkdirSync(spawnOptions.datadir, { recursive: true });
  }

  if (!fs.existsSync(configPath)) {
    var defaultConfig = this._getDefaultConfig();
    fs.writeFileSync(configPath, defaultConfig);
  }

  _.extend(this.spawn.config, this._getDefaultConf());
  _.extend(this.spawn.config, this._parseDashConf(configPath));

  var networkConfigPath = this._getNetworkConfigPath();
  if (networkConfigPath && fs.existsSync(networkConfigPath)) {
    _.extend(this.spawn.config, this._parseDashConf(networkConfigPath));
  }

  var spawnConfig = this.spawn.config;

  this._checkConfigIndexes(spawnConfig, node);

};

Dash.prototype._checkConfigIndexes = function(spawnConfig, node) {
  $.checkState(
    spawnConfig.txindex && spawnConfig.txindex === 1,
    '"txindex" option is required in order to use transaction query features of dashcore-node. ' +
      'Please add "txindex=1" to your configuration and reindex an existing database if ' +
      'necessary with reindex=1'
  );

  $.checkState(
    spawnConfig.addressindex && spawnConfig.addressindex === 1,
    '"addressindex" option is required in order to use address query features of dashcore-node. ' +
      'Please add "addressindex=1" to your configuration and reindex an existing database if ' +
      'necessary with reindex=1'
  );

  $.checkState(
    spawnConfig.spentindex && spawnConfig.spentindex === 1,
    '"spentindex" option is required in order to use spent info query features of dashcore-node. ' +
      'Please add "spentindex=1" to your configuration and reindex an existing database if ' +
      'necessary with reindex=1'
  );

  $.checkState(
    spawnConfig.server && spawnConfig.server === 1,
    '"server" option is required to communicate to dashd from dashcore. ' +
      'Please add "server=1" to your configuration and restart'
  );

  $.checkState(
    spawnConfig.zmqpubrawtx,
    '"zmqpubrawtx" option is required to get event updates from dashd. ' +
      'Please add "zmqpubrawtx=tcp://127.0.0.1:<port>" to your configuration and restart'
  );

  $.checkState(
      spawnConfig.zmqpubrawtxlock,
      '"zmqpubrawtxlock" option is required to get transaction locks from dashd. ' +
      'Please add "zmqpubrawtxlock=tcp://127.0.0.1:<port>" to your configuration and restart'
  );

  $.checkState(
    spawnConfig.zmqpubhashblock,
    '"zmqpubhashblock" option is required to get event updates from dashd. ' +
      'Please add "zmqpubhashblock=tcp://127.0.0.1:<port>" to your configuration and restart'
  );

  $.checkState(
    (spawnConfig.zmqpubhashblock === spawnConfig.zmqpubrawtx),
    '"zmqpubrawtx" and "zmqpubhashblock" are expected to the same host and port in dash.conf'
  );

  if (spawnConfig.reindex && spawnConfig.reindex === 1) {
    log.warn('Reindex option is currently enabled. This means that dashd is undergoing a reindex. ' +
             'The reindex flag will start the index from beginning every time the node is started, so it ' +
             'should be removed after the reindex has been initiated. Once the reindex is complete, the rest ' +
             'of dashcore-node services will start.');
    node._reindex = true;
  }
};

Dash.prototype._resetCaches = function() {
  this.transactionDetailedCache.reset();
  this.utxosCache.reset();
  this.txidsCache.reset();
  this.balanceCache.reset();
  this.summaryCache.reset();
  this.blockOverviewCache.reset();
  this.masternodeListCache.reset();
  this.sporksListCache.reset();
  this.govCache.del('info');
  this.govCache.del('count');
};

/**
 * This method will call 'func' with 'client' and 'done' arguments
 * until done will be called without first parameter or until clients runs out. Then it will call 'callback' arg.
 * @param func
 * @param callback
 * @private
 */
Dash.prototype._tryAllClients = function(func, callback) {
  var self = this;
  //Storing current node index into closure
  var nextClientToTry = this.nodesIndex;
  //Incrementing this.nodesIndex for proper round-robin
  this.nodesIndex = (this.nodesIndex + 1) % self.nodes.length;
  var retry = function(done) {
    var client = self.nodes[nextClientToTry].client;
    nextClientToTry = (nextClientToTry + 1) % self.nodes.length;
    func(client, done);
  };
  async.retry({times: this.nodes.length, interval: this.tryAllInterval || 1000}, retry, callback);
};

Dash.prototype._wrapRPCError = function(errObj) {
  var err = new errors.RPCError(errObj.message);
  err.code = errObj.code;
  return err;
};

Dash.prototype._initChain = function(callback) {
  var self = this;

  self.client.getBestBlockHash(function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }

    self.client.getBlock(response.result, function(err, response) {
      if (err) {
        return callback(self._wrapRPCError(err));
      }

      self.height = response.result.height;

      self.client.getBlockHash(0, function(err, response) {
        if (err) {
          return callback(self._wrapRPCError(err));
        }
        var blockhash = response.result;
        self.getRawBlock(blockhash, function(err, blockBuffer) {
          if (err) {
            return callback(err);
          }
          self.genesisBuffer = blockBuffer;
          self.emit('ready');
          log.info('Dash Daemon Ready');
          callback();
        });
      });

    });
  });
};

Dash.prototype._getDefaultConf = function() {
  var networkOptions = {
    rpcport: 9998
  };
  if (this.node.network === dashcore.Networks.testnet) {
    networkOptions.rpcport = 19998;
  }
  return networkOptions;
};

Dash.prototype._getNetworkConfigPath = function() {
  var networkPath;
  if (this.node.network === dashcore.Networks.testnet) {
    networkPath = 'testnet3/dash.conf';
    if (this.node.network.regtestEnabled) {
      networkPath = 'regtest/dash.conf';
    }
  }
  return networkPath;
};

Dash.prototype._getNetworkOption = function() {
  var networkOption;
  if (this.node.network === dashcore.Networks.testnet) {
    networkOption = '--testnet';
    if (this.node.network.regtestEnabled) {
      networkOption = '--regtest';
    }
  }
  return networkOption;
};

Dash.prototype._zmqBlockHandler = function(node, message) {
  var self = this;

  // Update the current chain tip
  self._rapidProtectedUpdateTip(node, message);

  // Notify block subscribers
  var id = message.toString('binary');
  if (!self.zmqKnownBlocks.get(id)) {
    self.zmqKnownBlocks.set(id, true);
    self.emit('block', message);

    for (var i = 0; i < this.subscriptions.hashblock.length; i++) {
      this.subscriptions.hashblock[i].emit('dashd/hashblock', message.toString('hex'));
    }
  }

};

Dash.prototype._rapidProtectedUpdateTip = function(node, message) {
  var self = this;

  // Prevent a rapid succession of tip updates
  if (new Date() - self.lastTip > 1000) {
    self.lastTip = new Date();
    self._updateTip(node, message);
  } else {
    clearTimeout(self.lastTipTimeout);
    self.lastTipTimeout = setTimeout(function() {
      self._updateTip(node, message);
    }, 1000);
  }
};

Dash.prototype._updateTip = function(node, message) {
  var self = this;

  var hex = message.toString('hex');
  if (hex !== self.tiphash) {
    self.tiphash = message.toString('hex');

    // reset block valid caches
    self._resetCaches();

    node.client.getBlock(self.tiphash, function(err, response) {
      if (err) {
        var error = self._wrapRPCError(err);
        self.emit('error', error);
      } else {
        self.height = response.result.height;
        $.checkState(self.height >= 0);
        self.emit('tip', self.height);
      }
    });

    if(!self.node.stopping) {
      self.syncPercentage(function(err, percentage) {
        if (err) {
          self.emit('error', err);
        } else {
          if (Math.round(percentage) >= 100) {
            self.emit('synced', self.height);
          }
          log.info('Dash Height:', self.height, 'Percentage:', percentage.toFixed(2));
        }
      });
    }
  }
};

Dash.prototype._getAddressesFromTransaction = function(transaction) {
  var addresses = [];

  for (var i = 0; i < transaction.inputs.length; i++) {
    var input = transaction.inputs[i];
    if (input.script) {
      var inputAddress = input.script.toAddress(this.node.network);
      if (inputAddress) {
        addresses.push(inputAddress.toString());
      }
    }
  }

  for (var j = 0; j < transaction.outputs.length; j++) {
    var output = transaction.outputs[j];
    if (output.script) {
      var outputAddress = output.script.toAddress(this.node.network);
      if (outputAddress) {
        addresses.push(outputAddress.toString());
      }
    }
  }

  return _.uniq(addresses);
};

Dash.prototype._notifyAddressTxidSubscribers = function(txid, transaction) {
  var addresses = this._getAddressesFromTransaction(transaction);
  for (var i = 0; i < addresses.length; i++) {
    var address = addresses[i];
    if(this.subscriptions.address[address]) {
      var emitters = this.subscriptions.address[address];
      for(var j = 0; j < emitters.length; j++) {
        emitters[j].emit('dashd/addresstxid', {
          address: address,
          txid: txid
        });
      }
    }
  }
};

Dash.prototype._zmqTransactionHandler = function(node, message) {
  // It happen that ZMQ is throwing 'rawtx'
  // We discard this as they are improper received message from ZMQ.
  if (message.equals(rawtxTopicBuffer)) {
    return false;
  }
  var self = this;
  var hash = dashcore.crypto.Hash.sha256sha256(message);
  var id = hash.toString('binary');
  if (!self.zmqKnownTransactions.get(id)) {
    self.zmqKnownTransactions.set(id, true);
    self.emit('tx', message);

    // Notify transaction subscribers
    for (var i = 0; i < this.subscriptions.rawtransaction.length; i++) {
      this.subscriptions.rawtransaction[i].emit('dashd/rawtransaction', message.toString('hex'));
    }

    var tx = dashcore.Transaction();
    tx.fromString(message);
    var txid = dashcore.util.buffer.reverse(hash).toString('hex');
    self._notifyAddressTxidSubscribers(txid, tx);

  }
};

Dash.prototype._zmqTransactionLockHandler = function (node, message) {
  // It happen that ZMQ is throwing 'rawtxlock'
  // We discard this as they are improper received message from ZMQ.
  if (message.equals(rawtxlockTopicBuffer)) {
    return false;
  }

  var self = this;
  var hash = dashcore.crypto.Hash.sha256sha256(message);
  var id = hash.toString('binary');
  if (!self.zmqKnownTransactionLocks.get(id)) {
    self.zmqKnownTransactionLocks.set(id, true);
    self.emit('txlock', message);

    // Notify transaction lock subscribers
    for (var i = 0; i < this.subscriptions.transactionlock.length; i++) {
      this.subscriptions.transactionlock[i].emit('dashd/transactionlock', message.toString('hex'));
    }

  }
};

Dash.prototype._checkSyncedAndSubscribeZmqEvents = function(node) {
  var self = this;
  var interval;

  function checkAndSubscribe(callback) {
    // update tip
    node.client.getBestBlockHash(function(err, response) {
      if (err) {
        return callback(self._wrapRPCError(err));
      }
      var blockhash = new Buffer(response.result, 'hex');
      self.emit('block', blockhash);
      self._updateTip(node, blockhash);

      // check if synced
      node.client.getBlockchainInfo(function(err, response) {
        if (err) {
          return callback(self._wrapRPCError(err));
        }
        var progress = response.result.verificationprogress;
        if (progress >= self.zmqSubscribeProgress) {
          // subscribe to events for further updates
          self._subscribeZmqEvents(node);
          clearInterval(interval);
          callback(null, true);
        } else {
          callback(null, false);
        }
      });
    });
  }

  checkAndSubscribe(function(err, synced) {
    if (err) {
      log.error(err);
    }
    if (!synced) {
      interval = setInterval(function() {
        if (self.node.stopping) {
          return clearInterval(interval);
        }
        checkAndSubscribe(function(err) {
          if (err) {
            log.error(err);
          }
        });
      }, node._tipUpdateInterval || Dash.DEFAULT_TIP_UPDATE_INTERVAL);
    }
  });

};

Dash.prototype._subscribeZmqEvents = function(node) {
  var self = this;
  node.zmqSubSocket.subscribe('hashblock');
  node.zmqSubSocket.subscribe('rawtx');
  node.zmqSubSocket.subscribe('rawtxlock');
  node.zmqSubSocket.on('message', function(topic, message) {
    var topicString = topic.toString('utf8');
    if (topicString === 'rawtxlock') {
      self._zmqTransactionLockHandler(node, message);
    } else if (topicString === 'rawtx') {
      self._zmqTransactionHandler(node, message);
    } else if (topicString === 'hashblock') {
      self._zmqBlockHandler(node, message);
    }
  });
};

Dash.prototype._initZmqSubSocket = function(node, zmqUrl) {
  var self = this;
  node.zmqSubSocket = zmq.socket('sub');

  node.zmqSubSocket.on('connect', function(fd, endPoint) {
    log.info('ZMQ connected to:', endPoint);
  });

  node.zmqSubSocket.on('connect_delay', function(fd, endPoint) {
    log.warn('ZMQ connection delay:', endPoint);
  });

  node.zmqSubSocket.on('disconnect', function(fd, endPoint) {
    log.warn('ZMQ disconnect:', endPoint);
  });

  node.zmqSubSocket.on('monitor_error', function(err) {
    log.error('Error in monitoring: %s, will restart monitoring in 5 seconds', err);
    setTimeout(function() {
      self.zmqSubSocket.monitor(500, 0);
    }, 5000);
  });

  node.zmqSubSocket.monitor(500, 0);
  node.zmqSubSocket.connect(zmqUrl);
};

Dash.prototype._checkReindex = function(node, callback) {
  var self = this;
  var interval;
  function finish(err) {
    clearInterval(interval);
    callback(err);
  }
  if (!node._reindex) {
    return callback();
  }

  interval = setInterval(function() {
    node.client.getBlockchainInfo(function(err, response) {
      if (err) {
        return finish(self._wrapRPCError(err));
      }
      var percentSynced = response.result.verificationprogress * 100;
      log.info('Dash Core Daemon Reindex Percentage: ' + percentSynced.toFixed(2));

      if (Math.round(percentSynced) >= 100) {
        node._reindex = false;
        finish();
      }
    });
  }, node._reindexWait || Dash.DEFAULT_REINDEX_INTERVAL);

};

Dash.prototype._loadTipFromNode = function(node, callback) {
  var self = this;
  node.client.getBestBlockHash(function(err, response) {
    if (err && err.code === -28) {
      log.warn(err.message);
      return callback(self._wrapRPCError(err));
    } else if (err) {
      return callback(self._wrapRPCError(err));
    }
    node.client.getBlock(response.result, function(err, response) {
      if (err) {
        return callback(self._wrapRPCError(err));
      }
      self.height = response.result.height;
      $.checkState(self.height >= 0);
      self.emit('tip', self.height);
      callback();
    });
  });
};

Dash.prototype._stopSpawnedDash = function(callback) {
  var self = this;
  var spawnOptions = this.options.spawn;
  var pidPath = spawnOptions.datadir + '/dashd.pid';

  function stopProcess() {
    fs.readFile(pidPath, 'utf8', function(err, pid) {
      if (err && err.code === 'ENOENT') {
        // pid file doesn't exist we can continue
        return callback(null);
      } else if (err) {
        return callback(err);
      }
      pid = parseInt(pid);
      if (!Number.isFinite(pid)) {
        // pid doesn't exist we can continue
        return callback(null);
      }
      try {
        log.warn('Stopping existing spawned dash process with pid: ' + pid);
        self._process.kill(pid, 'SIGINT');
      } catch(err) {
        if (err && err.code === 'ESRCH') {
          log.warn('Unclean dash process shutdown, process not found with pid: ' + pid);
          return callback(null);
        } else if(err) {
          return callback(err);
        }
      }
      setTimeout(function() {
        stopProcess();
      }, self.spawnStopTime);
    });
  }

  stopProcess();
};

Dash.prototype._spawnChildProcess = function(callback) {
  var self = this;

  var node = {};
  node._reindex = false;
  node._reindexWait = 10000;

  try {
    self._loadSpawnConfiguration(node);
  } catch(e) {
    return callback(e);
  }

  var options = [
    '--conf=' + this.spawn.configPath,
    '--datadir=' + this.spawn.datadir,
  ];

  if (self._getNetworkOption()) {
    options.push(self._getNetworkOption());
  }

  self._stopSpawnedDash(function(err) {
    if (err) {
      return callback(err);
    }

    log.info('Starting dash process');
    self.spawn.process = spawn(self.spawn.exec, options, {stdio: 'inherit'});

    self.spawn.process.on('error', function(err) {
      self.emit('error', err);
    });

    self.spawn.process.once('exit', function(code) {
      if (!self.node.stopping) {
        log.warn('Dash process unexpectedly exited with code:', code);
        log.warn('Restarting dash child process in ' + self.spawnRestartTime + 'ms');
        setTimeout(function() {
          self._spawnChildProcess(function(err) {
            if (err) {
              return self.emit('error', err);
            }
            log.warn('Dash process restarted');
          });
        }, self.spawnRestartTime);
      }
    });

    var exitShutdown = false;

    async.retry({times: 60, interval: self.startRetryInterval}, function(done) {
      if (self.node.stopping) {
        exitShutdown = true;
        return done();
      }

      node.client = new DashdRPC({
        protocol: 'http',
        host: '127.0.0.1',
        port: self.spawn.config.rpcport,
        user: self.spawn.config.rpcuser,
        pass: self.spawn.config.rpcpassword
      });

      self._loadTipFromNode(node, done);

    }, function(err) {
      if (err) {
        return callback(err);
      }
      if (exitShutdown) {
        return callback(new Error('Stopping while trying to spawn dashd.'));
      }

      self._initZmqSubSocket(node, self.spawn.config.zmqpubrawtx);

      self._checkReindex(node, function(err) {
        if (err) {
          return callback(err);
        }
        self._checkSyncedAndSubscribeZmqEvents(node);
        callback(null, node);
      });

    });

  });

};

Dash.prototype._connectProcess = function(config, callback) {
  var self = this;
  var node = {};
  var exitShutdown = false;

  async.retry({times: 60, interval: self.startRetryInterval}, function(done) {
    if (self.node.stopping) {
      exitShutdown = true;
      return done();
    }

    node.client = new DashdRPC({
      protocol: config.rpcprotocol || 'http',
      host: config.rpchost || '127.0.0.1',
      port: config.rpcport,
      user: config.rpcuser,
      pass: config.rpcpassword,
      rejectUnauthorized: _.isUndefined(config.rpcstrict) ? true : config.rpcstrict
    });

    self._loadTipFromNode(node, done);

  }, function(err) {
    if (err) {
      return callback(err);
    }
    if (exitShutdown) {
      return callback(new Error('Stopping while trying to connect to dashd.'));
    }

    self._initZmqSubSocket(node, config.zmqpubrawtx);
    self._subscribeZmqEvents(node);

    callback(null, node);
  });
};

/**
 * Called by Node to start the service
 * @param {Function} callback
 */
Dash.prototype.start = function(callback) {
  var self = this;

  async.series([
    function(next) {
      if (self.options.spawn) {
        self._spawnChildProcess(function(err, node) {
          if (err) {
            return next(err);
          }
          self.nodes.push(node);
          next();
        });
      } else {
        next();
      }
    },
    function(next) {
      if (self.options.connect) {
        async.map(self.options.connect, self._connectProcess.bind(self), function(err, nodes) {
          if (err) {
            return next(err);
          }
          for(var i = 0; i < nodes.length; i++) {
            self.nodes.push(nodes[i]);
          }
          next();
        });
      } else {
        next();
      }
    }
  ], function(err) {
    if (err) {
      return callback(err);
    }
    if (self.nodes.length === 0) {
      return callback(new Error('Dash configuration options "spawn" or "connect" are expected'));
    }
    self._initChain(callback);
  });

};

/**
 * Helper to determine the state of the database.
 * @param {Function} callback
 */
Dash.prototype.isSynced = function(callback) {
  this.syncPercentage(function(err, percentage) {
    if (err) {
      return callback(err);
    }
    if (Math.round(percentage) >= 100) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  });
};

/**
 * Helper to determine the progress of the database.
 * @param {Function} callback
 */
Dash.prototype.syncPercentage = function(callback) {
  var self = this;
  this.client.getBlockchainInfo(function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    var percentSynced = response.result.verificationprogress * 100;
    callback(null, percentSynced);
  });
};

Dash.prototype._normalizeAddressArg = function(addressArg) {
  var addresses = [addressArg];
  if (Array.isArray(addressArg)) {
    addresses = addressArg;
  }
  return addresses;
};

/**
 * Will get the balance for an address or multiple addresses
 * @param {String|Address|Array} addressArg - An address string, dashcore address, or array of addresses
 * @param {Object} options
 * @param {Function} callback
 */
Dash.prototype.getAddressBalance = function(addressArg, options, callback) {
  var self = this;
  var addresses = self._normalizeAddressArg(addressArg);
  var cacheKey = addresses.join('');
  var balance = self.balanceCache.get(cacheKey);
  if (balance) {
    return setImmediate(function() {
      callback(null, balance);
    });
  } else {
    this.client.getAddressBalance({addresses: addresses}, function(err, response) {
      if (err) {
        return callback(self._wrapRPCError(err));
      }
      self.balanceCache.set(cacheKey, response.result);
      callback(null, response.result);
    });
  }
};

/**
 * Will get the unspent outputs for an address or multiple addresses and return paginated results
 * @param {String|Address|Array} addressArg - An address string, dashcore address, or array of addresses
 * @param {Object} options
 * @param {Function} callback
 */
Dash.prototype.getAddressUnspentOutputsPaginated = function(addressArg, options, callback) {
  var self = this;
  var queryMempool = _.isUndefined(options.queryMempool) ? true : options.queryMempool;
  var addresses = self._normalizeAddressArg(addressArg);
  var cacheKey = addresses.join('');
  var utxos = self.utxosCache.get(cacheKey);
  var fromArg = parseInt(options.from || 0);
  var toArg = parseInt(options.to || self.maxUTXOHistory);
  var fromHeight = parseInt(options.fromHeight) || undefined;
  var toHeight = parseInt(options.toHeight) || undefined;

  function transformUnspentOutput(delta) {
    var script = dashcore.Script.fromAddress(delta.address);
    return {
      address: delta.address,
      txid: delta.txid,
      outputIndex: delta.index,
      script: script.toHex(),
      satoshis: delta.satoshis,
      timestamp: delta.timestamp
    };
  }

  function updateWithMempool(confirmedUtxos, mempoolDeltas) {
    /* jshint maxstatements: 21 */
    var utxos = [];
    var totalCount = confirmedUtxos.length;

    if (!mempoolDeltas || !mempoolDeltas.length) {
      utxos = self._paginate(confirmedUtxos, fromArg, toArg, fromHeight, toHeight);
      return {
        totalCount: totalCount,
        items: utxos
      };
    }

    var isSpentOutputs = false;
    var mempoolUnspentOutputs = [];
    var spentOutputs = [];

    for (var i = 0; i < mempoolDeltas.length; i++) {
      var delta = mempoolDeltas[i];
      if (delta.prevtxid && delta.satoshis <= 0) {
        isSpentOutputs = true;
        if (!spentOutputs[delta.prevtxid]) {
          spentOutputs[delta.prevtxid] = [delta.prevout];
        } else {
          spentOutputs[delta.prevtxid].push(delta.prevout);
        }
      } else {
        mempoolUnspentOutputs.push(transformUnspentOutput(delta));
      }
    }

    utxos = self._paginate(
      mempoolUnspentOutputs.reverse().concat(confirmedUtxos), fromArg, toArg, fromHeight, toHeight);

    if (isSpentOutputs) {
      var filteredUtxos = utxos.filter(function(utxo) {
        if (!spentOutputs[utxo.txid]) {
          return true;
        } else {
          return (spentOutputs[utxo.txid].indexOf(utxo.outputIndex) === -1);
        }
      });
      return {
        totalCount: totalCount,
        items: filteredUtxos
      };
    }

    return {
      totalCount: totalCount,
      items: utxos
    };
  }

  function finish(mempoolDeltas) {
    if (utxos) {
      return setImmediate(function() {
        callback(null, updateWithMempool(utxos, mempoolDeltas));
      });
    } else {
      self.client.getAddressUtxos({addresses: addresses}, function(err, response) {
        if (err) {
          return callback(self._wrapRPCError(err));
        }
        var utxos = response.result.reverse();
        self.utxosCache.set(cacheKey, utxos);
        callback(null, updateWithMempool(utxos, mempoolDeltas));
      });
    }
  }

  if (queryMempool) {
    self.client.getAddressMempool({addresses: addresses}, function(err, response) {
      if (err) {
        return callback(self._wrapRPCError(err));
      }
      finish(response.result);
    });
  } else {
    finish();
  }

};

/**
 * Will get the unspent outputs for an address or multiple addresses
 * @param {String|Address|Array} addressArg - An address string, dashcore address, or array of addresses
 * @param {Object} options
 * @param {Function} callback
 */
Dash.prototype.getAddressUnspentOutputs = function(addressArg, options, callback) {
  var self = this;
  var queryMempool = _.isUndefined(options.queryMempool) ? true : options.queryMempool;
  var addresses = self._normalizeAddressArg(addressArg);
  var cacheKey = addresses.join('');
  var utxos = self.utxosCache.get(cacheKey);

  function transformUnspentOutput(delta) {
    var script = dashcore.Script.fromAddress(delta.address);
    return {
      address: delta.address,
      txid: delta.txid,
      outputIndex: delta.index,
      script: script.toHex(),
      satoshis: delta.satoshis,
      timestamp: delta.timestamp
    };
  }

  function updateWithMempool(confirmedUtxos, mempoolDeltas) {
    /* jshint maxstatements: 20 */
    if (!mempoolDeltas || !mempoolDeltas.length) {
      return confirmedUtxos;
    }
    var isSpentOutputs = false;
    var mempoolUnspentOutputs = [];
    var spentOutputs = [];

    for (var i = 0; i < mempoolDeltas.length; i++) {
      var delta = mempoolDeltas[i];
      if (delta.prevtxid && delta.satoshis <= 0) {
        isSpentOutputs = true;
        if (!spentOutputs[delta.prevtxid]) {
          spentOutputs[delta.prevtxid] = [delta.prevout];
        } else {
          spentOutputs[delta.prevtxid].push(delta.prevout);
        }
      } else {
        mempoolUnspentOutputs.push(transformUnspentOutput(delta));
      }
    }

    var utxos = mempoolUnspentOutputs.reverse().concat(confirmedUtxos);

    if (isSpentOutputs) {
      return utxos.filter(function(utxo) {
        if (!spentOutputs[utxo.txid]) {
          return true;
        } else {
          return (spentOutputs[utxo.txid].indexOf(utxo.outputIndex) === -1);
        }
      });
    }

    return utxos;
  }

  function finish(mempoolDeltas) {
    if (utxos) {
      return setImmediate(function() {
        callback(null, updateWithMempool(utxos, mempoolDeltas));
      });
    } else {
      self.client.getAddressUtxos({addresses: addresses}, function(err, response) {
        if (err) {
          return callback(self._wrapRPCError(err));
        }
        var utxos = response.result.reverse();
        self.utxosCache.set(cacheKey, utxos);
        callback(null, updateWithMempool(utxos, mempoolDeltas));
      });
    }
  }

  if (queryMempool) {
    self.client.getAddressMempool({addresses: addresses}, function(err, response) {
      if (err) {
        return callback(self._wrapRPCError(err));
      }
      finish(response.result);
    });
  } else {
    finish();
  }

};

Dash.prototype._getBalanceFromMempool = function(deltas) {
  var satoshis = 0;
  for (var i = 0; i < deltas.length; i++) {
    satoshis += deltas[i].satoshis;
  }
  return satoshis;
};

Dash.prototype._getTxidsFromMempool = function(deltas) {
  var mempoolTxids = [];
  var mempoolTxidsKnown = {};
  for (var i = 0; i < deltas.length; i++) {
    var txid = deltas[i].txid;
    if (!mempoolTxidsKnown[txid]) {
      mempoolTxids.push(txid);
      mempoolTxidsKnown[txid] = true;
    }
  }
  return mempoolTxids;
};

Dash.prototype._getHeightRangeQuery = function(options, clone) {
  if (options.start >= 0 && options.end >= 0) {
    if (options.end > options.start) {
      throw new TypeError('"end" is expected to be less than or equal to "start"');
    }
    if (clone) {
      // reverse start and end as the order in dashcore is most recent to less recent
      clone.start = options.end;
      clone.end = options.start;
    }
    return true;
  }
  return false;
};

/**
 * Will get the txids for an address or multiple addresses
 * @param {String|Address|Array} addressArg - An address string, dashcore address, or array of addresses
 * @param {Object} options
 * @param {Function} callback
 */
Dash.prototype.getAddressTxids = function(addressArg, options, callback) {
  /* jshint maxstatements: 16 */
  var self = this;
  var queryMempool = _.isUndefined(options.queryMempool) ? true : options.queryMempool;
  var rangeQuery = false;
  try {
    rangeQuery = self._getHeightRangeQuery(options);
  } catch(err) {
    return callback(err);
  }
  if (rangeQuery) {
    queryMempool = false;
  }
  var addresses = self._normalizeAddressArg(addressArg);
  var cacheKey = addresses.join('');
  var mempoolTxids = [];
  var txids = self.txidsCache.get(cacheKey);

  function finish() {
    if (txids && !rangeQuery) {
      var allTxids = mempoolTxids.reverse().concat(txids);
      return setImmediate(function() {
        callback(null, allTxids);
      });
    } else {
      var txidOpts = {
        addresses: addresses
      };
      if (rangeQuery) {
        self._getHeightRangeQuery(options, txidOpts);
      }
      self.client.getAddressTxids(txidOpts, function(err, response) {
        if (err) {
          return callback(self._wrapRPCError(err));
        }
        response.result.reverse();
        if (!rangeQuery) {
          self.txidsCache.set(cacheKey, response.result);
        }
        var allTxids = mempoolTxids.reverse().concat(response.result);
        return callback(null, allTxids);
      });
    }
  }

  if (queryMempool) {
    self.client.getAddressMempool({addresses: addresses}, function(err, response) {
      if (err) {
        return callback(self._wrapRPCError(err));
      }
      mempoolTxids = self._getTxidsFromMempool(response.result);
      finish();
    });
  } else {
    finish();
  }

};

Dash.prototype._getConfirmationsDetail = function(transaction) {
  $.checkState(this.height > 0, 'current height is unknown');
  var confirmations = 0;
  if (transaction.height >= 0) {
    confirmations = this.height - transaction.height + 1;
  }
  if (confirmations < 0) {
    log.warn('Negative confirmations calculated for transaction:', transaction.hash);
  }
  return Math.max(0, confirmations);
};

Dash.prototype._getAddressDetailsForInput = function(input, inputIndex, result, addressStrings) {
  if (!input.address) {
    return;
  }
  var address = input.address;
  if (addressStrings.indexOf(address) >= 0) {
    if (!result.addresses[address]) {
      result.addresses[address] = {
        inputIndexes: [inputIndex],
        outputIndexes: []
      };
    } else {
      result.addresses[address].inputIndexes.push(inputIndex);
    }
    result.satoshis -= input.satoshis;
  }
};

Dash.prototype._getAddressDetailsForOutput = function(output, outputIndex, result, addressStrings) {
  if (!output.address) {
    return;
  }
  var address = output.address;
  if (addressStrings.indexOf(address) >= 0) {
    if (!result.addresses[address]) {
      result.addresses[address] = {
        inputIndexes: [],
        outputIndexes: [outputIndex]
      };
    } else {
      result.addresses[address].outputIndexes.push(outputIndex);
    }
    result.satoshis += output.satoshis;
  }
};

Dash.prototype._getAddressDetailsForTransaction = function(transaction, addressStrings) {
  var result = {
    addresses: {},
    satoshis: 0
  };

  for (var inputIndex = 0; inputIndex < transaction.inputs.length; inputIndex++) {
    var input = transaction.inputs[inputIndex];
    this._getAddressDetailsForInput(input, inputIndex, result, addressStrings);
  }

  for (var outputIndex = 0; outputIndex < transaction.outputs.length; outputIndex++) {
    var output = transaction.outputs[outputIndex];
    this._getAddressDetailsForOutput(output, outputIndex, result, addressStrings);
  }

  $.checkState(Number.isFinite(result.satoshis));

  return result;
};

/**
 * Will expand into a detailed transaction from a txid
 * @param {Object} txid - A dash transaction id
 * @param {Function} callback
 */
Dash.prototype._getAddressDetailedTransaction = function(txid, options, next) {
  var self = this;

  self.getDetailedTransaction(
    txid,
    function(err, transaction) {
      if (err) {
        return next(err);
      }

      var addressDetails = self._getAddressDetailsForTransaction(transaction, options.addressStrings);

      var details = {
        addresses: addressDetails.addresses,
        satoshis: addressDetails.satoshis,
        confirmations: self._getConfirmationsDetail(transaction),
        tx: transaction
      };
      next(null, details);
    }
  );
};

Dash.prototype._getAddressStrings = function(addresses) {
  var addressStrings = [];
  for (var i = 0; i < addresses.length; i++) {
    var address = addresses[i];
    if (address instanceof dashcore.Address) {
      addressStrings.push(address.toString());
    } else if (_.isString(address)) {
      addressStrings.push(address);
    } else {
      throw new TypeError('Addresses are expected to be strings');
    }
  }
  return addressStrings;
};

Dash.prototype._paginate = function(fullArray, fromArg, toArg, fromHeight, toHeight) {
  var slicedArray;
  var filteredArray;
  var from = parseInt(fromArg);
  var to = parseInt(toArg);
  if (fromHeight !== undefined && toHeight !== undefined) {
    $.checkState(
      fromHeight < toHeight, '"fromHeight" (' + fromHeight + ')' +
      ' is expected to be less than "toHeight" (' + toHeight + ')');
    filteredArray = fullArray.filter(function(item) {
      if (item.height >= fromHeight && item.height <= toHeight) {
        return item;
      }
    });
  }
  if (fromHeight !== undefined && toHeight === undefined) {
    filteredArray = fullArray.filter(function(item) {
      if (item.height >= fromHeight) {
        return item;
      }
    });
  }
  if (toHeight !== undefined && fromHeight === undefined) {
    filteredArray = fullArray.filter(function(item) {
      if (item.height <= toHeight) {
        return item;
      }
    });
  }
  $.checkState(from < to, '"from" (' + from + ') is expected to be less than "to" (' + to + ')');
  if (filteredArray) {
    slicedArray = filteredArray.slice(from, to);
  } else {
    slicedArray = fullArray.slice(from, to);
  }
  return slicedArray;
};

/**
 * Will detailed transaction history for an address or multiple addresses
 * @param {String|Address|Array} addressArg - An address string, dashcore address, or array of addresses
 * @param {Object} options
 * @param {Function} callback
 */
Dash.prototype.getAddressHistory = function(addressArg, options, callback) {
  var self = this;
  var addresses = self._normalizeAddressArg(addressArg);
  if (addresses.length > this.maxAddressesQuery) {
    return callback(new TypeError('Maximum number of addresses (' + this.maxAddressesQuery + ') exceeded'));
  }

  var queryMempool = _.isUndefined(options.queryMempool) ? true : options.queryMempool;
  var addressStrings = this._getAddressStrings(addresses);

  var fromArg = parseInt(options.from || 0);
  var toArg = parseInt(options.to || self.maxTransactionHistory);
  var fromHeight = parseInt(options.fromHeight) || undefined;
  var toHeight = parseInt(options.toHeight) || undefined;

  if ((toArg - fromArg) > self.maxTransactionHistory) {
    return callback(new Error(
      '"from" (' + options.from + ') and "to" (' + options.to + ') range should be less than or equal to ' +
        self.maxTransactionHistory
    ));
  }

  self.getAddressTxids(addresses, options, function(err, txids) {
    if (err) {
      return callback(err);
    }

    var totalCount = txids.length;
    try {
      txids = self._paginate(txids, fromArg, toArg, fromHeight, toHeight);
    } catch(e) {
      return callback(e);
    }

    async.mapLimit(
      txids,
      self.transactionConcurrency,
      function(txid, next) {
        self._getAddressDetailedTransaction(txid, {
          queryMempool: queryMempool,
          addressStrings: addressStrings
        }, next);
      },
      function(err, transactions) {
        if (err) {
          return callback(err);
        }
        callback(null, {
          totalCount: totalCount,
          items: transactions
        });
      }
    );
  });
};

/**
 * Will get the summary including txids and balance for an address or multiple addresses
 * @param {String|Address|Array} addressArg - An address string, dashcore address, or array of addresses
 * @param {Object} options
 * @param {Function} callback
 */
Dash.prototype.getAddressSummary = function(addressArg, options, callback) {
  var self = this;
  var summary = {};
  var queryMempool = _.isUndefined(options.queryMempool) ? true : options.queryMempool;
  var summaryTxids = [];
  var mempoolTxids = [];
  var addresses = self._normalizeAddressArg(addressArg);
  var cacheKey = addresses.join('');

  function finishWithTxids() {
    if (!options.noTxList) {
      var allTxids = mempoolTxids.reverse().concat(summaryTxids);
      var fromArg = parseInt(options.from || 0);
      var toArg = parseInt(options.to || self.maxTxids);
      var fromHeight = parseInt(options.fromHeight) || undefined;
      var toHeight = parseInt(options.toHeight) || undefined;

      if ((toArg - fromArg) > self.maxTxids) {
        return callback(new Error(
            '"from" (' + fromArg + ') and "to" (' + toArg + ') range should be less than or equal to ' +
            self.maxTxids
        ));
      }
      var paginatedTxids;
      try {
        paginatedTxids = self._paginate(allTxids, fromArg, toArg, fromHeight, toHeight);
      } catch(e) {
        return callback(e);
      }

      var allSummary = _.clone(summary);
      allSummary.txids = paginatedTxids;
      callback(null, allSummary);
    } else {
      callback(null, summary);
    }
  }

  function querySummary() {
    async.parallel([
      function getTxList(done) {
        self.getAddressTxids(addresses, {queryMempool: false}, function(err, txids) {
          if (err) {
            return done(err);
          }
          summaryTxids = txids;
          summary.appearances = txids.length;
          done();
        });
      },
      function getBalance(done) {
        self.getAddressBalance(addresses, options, function(err, data) {
          if (err) {
            return done(err);
          }
          summary.totalReceived = data.received;
          summary.totalSpent = data.received - data.balance;
          summary.balance = data.balance;
          done();
        });
      },
      function getMempool(done) {
        if (!queryMempool) {
          return done();
        }
        self.client.getAddressMempool({'addresses': addresses}, function(err, response) {
          if (err) {
            return done(self._wrapRPCError(err));
          }
          mempoolTxids = self._getTxidsFromMempool(response.result);
          summary.unconfirmedAppearances = mempoolTxids.length;
          summary.unconfirmedBalance = self._getBalanceFromMempool(response.result);
          done();
        });
      },
    ], function(err) {
      if (err) {
        return callback(err);
      }
      self.summaryCache.set(cacheKey, summary);
      finishWithTxids();
    });
  }

  if (options.noTxList) {
    var summaryCache = self.summaryCache.get(cacheKey);
    if (summaryCache) {
      callback(null, summaryCache);
    } else {
      querySummary();
    }
  } else {
    querySummary();
  }

};

/**
 * If blockArg is number, will try to ask all available clients for block hash and return it.
 * If blockArg is string, will return that string back.
 * @param {String|Number} blockArg - block height or hash
 * @param {Function} callback
 * @private
 */
Dash.prototype._maybeGetBlockHash = function(blockArg, callback) {
  var self = this;
  if (_.isNumber(blockArg) || (blockArg.length < 40 && /^[0-9]+$/.test(blockArg))) {
    self._tryAllClients(function(client, done) {
      client.getBlockHash(blockArg, function(err, response) {
        if (err) {
          return done(self._wrapRPCError(err));
        }
        done(null, response.result);
      });
    }, callback);
  } else {
    callback(null, blockArg);
  }
};

/**
 * Will retrieve a block as a Node.js Buffer
 * @param {String|Number} block - A block hash or block height number
 * @param {Function} callback
 */
Dash.prototype.getRawBlock = function(blockArg, callback) {
  // TODO apply performance patch to the RPC method for raw data
  var self = this;

  function queryBlock(err, blockhash) {
    if (err) {
      return callback(err);
    }
    self._tryAllClients(function(client, done) {
      self.client.getBlock(blockhash, false, function(err, response) {
        if (err) {
          return done(self._wrapRPCError(err));
        }
        var buffer = new Buffer(response.result, 'hex');
        self.rawBlockCache.set(blockhash, buffer);
        done(null, buffer);
      });
    }, callback);
  }

  var cachedBlock = self.rawBlockCache.get(blockArg);
  if (cachedBlock) {
    return setImmediate(function() {
      callback(null, cachedBlock);
    });
  } else {
    self._maybeGetBlockHash(blockArg, queryBlock);
  }
};

/**
 * Similar to getBlockHeader but will include a list of txids
 * @param {String|Number} block - A block hash or block height number
 * @param {Function} callback
 */
Dash.prototype.getBlockOverview = function(blockArg, callback) {
  var self = this;

  function queryBlock(err, blockhash) {
    if (err) {
      return callback(err);
    }
    var cachedBlock = self.blockOverviewCache.get(blockhash);
    if (cachedBlock) {
      return setImmediate(function() {
        callback(null, cachedBlock);
      });
    } else {
      self._tryAllClients(function(client, done) {
        client.getBlock(blockhash, true, function(err, response) {
          if (err) {
            return done(self._wrapRPCError(err));
          }
          var result = response.result;
          var blockOverview = {
            hash: result.hash,
            version: result.version,
            confirmations: result.confirmations,
            height: result.height,
            chainWork: result.chainwork,
            prevHash: result.previousblockhash,
            nextHash: result.nextblockhash,
            merkleRoot: result.merkleroot,
            time: result.time,
            medianTime: result.mediantime,
            nonce: result.nonce,
            bits: result.bits,
            difficulty: result.difficulty,
            txids: result.tx
          };
          self.blockOverviewCache.set(blockhash, blockOverview);
          done(null, blockOverview);
        });
      }, callback);
    }
  }

  self._maybeGetBlockHash(blockArg, queryBlock);
};

/**
 * Will retrieve a block as a Dashcore object
 * @param {String|Number} block - A block hash or block height number
 * @param {Function} callback
 */
Dash.prototype.getBlock = function(blockArg, callback) {
  // TODO apply performance patch to the RPC method for raw data
  var self = this;

  function queryBlock(err, blockhash) {
    if (err) {
      return callback(err);
    }
    var cachedBlock = self.blockCache.get(blockhash);
    if (cachedBlock) {
      return setImmediate(function() {
        callback(null, cachedBlock);
      });
    } else {
      self._tryAllClients(function(client, done) {
        client.getBlock(blockhash, false, function(err, response) {
          if (err) {
            return done(self._wrapRPCError(err));
          }
          var blockObj = dashcore.Block.fromString(response.result);
          self.blockCache.set(blockhash, blockObj);
          done(null, blockObj);
        });
      }, callback);
    }
  }

  self._maybeGetBlockHash(blockArg, queryBlock);
};

/**
 * Will retrieve an array of block hashes within a range of timestamps
 * @param {Number} high - The more recent timestamp in seconds
 * @param {Number} low - The older timestamp in seconds
 * @param {Function} callback
 */
Dash.prototype.getBlockHashesByTimestamp = function(high, low, callback) {
  var self = this;
  self.client.getBlockHashes(high, low, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response.result);
  });
};

/**
 * Will return the block index information, the output will have the format:
 * {
 *   hash: '0000000000000a817cd3a74aec2f2246b59eb2cbb1ad730213e6c4a1d68ec2f6',
 *   confirmations: 5,
 *   height: 828781,
 *   chainWork: '00000000000000000000000000000000000000000000000ad467352c93bc6a3b',
 *   prevHash: '0000000000000504235b2aff578a48470dbf6b94dafa9b3703bbf0ed554c9dd9',
 *   nextHash: '00000000000000eedd967ec155f237f033686f0924d574b946caf1b0e89551b8'
 *   version: 536870912,
 *   merkleRoot: '124e0f3fb5aa268f102b0447002dd9700988fc570efcb3e0b5b396ac7db437a9',
 *   time: 1462979126,
 *   medianTime: 1462976771,
 *   nonce: 2981820714,
 *   bits: '1a13ca10',
 *   difficulty: 847779.0710240941,
 * }
 * @param {String|Number} block - A block hash or block height
 * @param {Function} callback
 */
Dash.prototype.getBlockHeader = function(blockArg, callback) {
  var self = this;

  function queryHeader(err, blockhash) {
    if (err) {
      return callback(err);
    }
    self._tryAllClients(function(client, done) {
      client.getBlockHeader(blockhash, function(err, response) {
        if (err) {
          return done(self._wrapRPCError(err));
        }
        var result = response.result;
        var header = {
          hash: result.hash,
          version: result.version,
          confirmations: result.confirmations,
          height: result.height,
          chainWork: result.chainwork,
          prevHash: result.previousblockhash,
          nextHash: result.nextblockhash,
          merkleRoot: result.merkleroot,
          time: result.time,
          medianTime: result.mediantime,
          nonce: result.nonce,
          bits: result.bits,
          difficulty: result.difficulty
        };
        done(null, header);
      });
    }, callback);
  }

  self._maybeGetBlockHash(blockArg, queryHeader);
};

/***
 * Will return an array of block headers (up to 2000) with the format:
 * [{
 *   hash: '0000000000000a817cd3a74aec2f2246b59eb2cbb1ad730213e6c4a1d68ec2f6',
 *   confirmations: 5,
 *   height: 828781,
 *   chainWork: '00000000000000000000000000000000000000000000000ad467352c93bc6a3b',
 *   prevHash: '0000000000000504235b2aff578a48470dbf6b94dafa9b3703bbf0ed554c9dd9',
 *   nextHash: '00000000000000eedd967ec155f237f033686f0924d574b946caf1b0e89551b8'
 *   version: 536870912,
 *   merkleRoot: '124e0f3fb5aa268f102b0447002dd9700988fc570efcb3e0b5b396ac7db437a9',
 *   time: 1462979126,
 *   medianTime: 1462976771,
 *   nonce: 2981820714,
 *   bits: '1a13ca10',
 *   difficulty: 847779.0710240941,
 * },{...}]
 * @param {String|Number} blockArg - A block hash or block height
 * @param {Function} callback
 * @param {String|Number} nbOfBlockToFetch - A value allowing to choose how many block to fetch
 */
Dash.prototype.getBlockHeaders = function(blockArg, callback, nbOfBlockToFetch) {
	var self = this;
	var _toFetch = 25;

	if (nbOfBlockToFetch) {

		if (nbOfBlockToFetch.constructor.name === 'String' && !isNaN(parseInt(nbOfBlockToFetch))) {
      _toFetch = parseInt(nbOfBlockToFetch);
		}
		if (nbOfBlockToFetch.constructor.name === 'Number') {
			_toFetch = nbOfBlockToFetch;
		}
		if (_toFetch > 250) {
		  _toFetch = 250;//Limit to avoid asking to many blocks.
		}
	}

	self._maybeGetBlockHash(blockArg, function(err, blockhash) {
	  if (err) {
	    return callback(err);
    }
    var headers = [];
    var nextHash = blockhash;
    var headersLeft = _toFetch;

    async.until(function until() {
      return headersLeft === 0 || !nextHash;
    }, function getHeader(done) {
      self.getBlockHeader(nextHash, function (err, blockHeader) {
        if (err) {
          return done(err);
        }
        headersLeft--;
        if (!blockHeader) {
          return done(null, headers);
        }
        headers.push(blockHeader);
        nextHash = blockHeader.nextHash;
        return done(null, headers);
      });
    }, callback);
  });
};

/**
 * Will estimate the fee per kilobyte.
 * @param {Number} blocks - The number of blocks for the transaction to be confirmed.
 * @param {Function} callback
 */
Dash.prototype.estimateFee = function(blocks, callback) {
  var self = this;
  this.client.estimateFee(blocks, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response.result);
  });
};

/**
 * Will add a transaction to the mempool and relay to connected peers
 * @param {String|Transaction} transaction - The hex string of the transaction
 * @param {Object=} options
 * @param {Boolean=} options.maxFeeRate - Cap large fees (0 for unlimited)
 * @param {Function} callback
 */
Dash.prototype.sendTransaction = function(tx, options, callback) {
  var self = this;
  var maxFeeRate = 0.00015000; // duff/kB (typically 1000)
  var isInstantSend = false;
  if (_.isFunction(options) && _.isUndefined(callback)) {
    callback = options;
  } else if (_.isObject(options)) {
    if(options.hasOwnProperty('maxFeeRate')){
	  maxFeeRate = options.maxFeeRate;
    }
    if(options.hasOwnProperty('allowAbsurdFees')){
      console.warn(`the boolean 'allowAbsurdFees' has been replaced by the int 'maxFeeRate'`);
      if(true === options.allowAbsurdFees) {
        maxFeeRate = 0; // unlimited
      }
    }
    if(options.hasOwnProperty('isInstantSend')){
	  isInstantSend = options.isInstantSend;
    }
  }

  this.client.sendRawTransaction(tx, maxFeeRate, isInstantSend, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response.result);
  });

};

Dash.prototype._getRawTransactionData = function(txid, callback) {
  var self = this;
  self._tryAllClients(function(client, done) {
    client.getRawTransaction(txid, function(err, response) {
      if (err) {
        return done(self._wrapRPCError(err));
      }
      done(null, response.result);
    });
  }, callback);
};

/**
 * Will get a transaction as a Node.js Buffer. Results include the mempool.
 * @param {String} txid - The transaction hash
 * @param {Function} callback
 */
Dash.prototype.getRawTransaction = function(txid, callback) {
  var self = this;
  var tx = self.rawTransactionCache.get(txid);
  if (tx) {
    return setImmediate(function() {
      callback(null, tx);
    });
  } else {
    self._getRawTransactionData(txid, function(err, transactionData) {
      if (err) {
        return callback(err);
      }
      var buffer = new Buffer(transactionData, 'hex');
      self.rawTransactionCache.set(txid, buffer);
      callback(null, buffer);
    });
  }
};

/**
 * Will get a transaction as a Dashcore Transaction. Results include the mempool.
 * @param {String} txid - The transaction hash
 * @param {Boolean} queryMempool - Include the mempool
 * @param {Function} callback
 */
Dash.prototype.getTransaction = function(txid, callback) {
  var self = this;
  var tx = self.transactionCache.get(txid);
  if (tx) {
    return setImmediate(function() {
      callback(null, tx);
    });
  } else {
    self._getRawTransactionData(txid, function(err, transactionData) {
      if (err) {
        return callback(err);
      }
      var tx = Transaction();
      tx.fromString(transactionData);
      self.transactionCache.set(txid, tx);
      callback(null, tx);
    });
  }
};

/**
 * Will get a detailed view of a transaction including addresses, amounts and fees.
 *
 * Example result:
 * {
 *   blockHash: '000000000000000002cd0ba6e8fae058747d2344929ed857a18d3484156c9250',
 *   height: 411462,
 *   blockTimestamp: 1463070382,
 *   version: 1,
 *   hash: 'de184cc227f6d1dc0316c7484aa68b58186a18f89d853bb2428b02040c394479',
 *   locktime: 411451,
 *   coinbase: true,
 *   inputs: [
 *     {
 *       prevTxId: '3d003413c13eec3fa8ea1fe8bbff6f40718c66facffe2544d7516c9e2900cac2',
 *       outputIndex: 0,
 *       sequence: 123456789,
 *       script: [hexString],
 *       scriptAsm: [asmString],
 *       address: '1LCTmj15p7sSXv3jmrPfA6KGs6iuepBiiG',
 *       satoshis: 771146
 *     }
 *   ],
 *   outputs: [
 *     {
 *       satoshis: 811146,
 *       script: '76a914d2955017f4e3d6510c57b427cf45ae29c372c99088ac',
 *       scriptAsm: 'OP_DUP OP_HASH160 d2955017f4e3d6510c57b427cf45ae29c372c990 OP_EQUALVERIFY OP_CHECKSIG',
 *       address: '1LCTmj15p7sSXv3jmrPfA6KGs6iuepBiiG',
 *       spentTxId: '4316b98e7504073acd19308b4b8c9f4eeb5e811455c54c0ebfe276c0b1eb6315',
 *       spentIndex: 1,
 *       spentHeight: 100
 *     }
 *   ],
 *   inputSatoshis: 771146,
 *   outputSatoshis: 811146,
 *   feeSatoshis: 40000
 * };
 *
 * @param {String} txid - The hex string of the transaction
 * @param {Function} callback
 */
Dash.prototype.getDetailedTransaction = function(txid, callback) {
  var self = this;
  var tx = self.transactionDetailedCache.get(txid);

  function addInputsToTx(tx, result) {
    tx.inputs = [];
    tx.inputSatoshis = 0;
    for(var inputIndex = 0; inputIndex < result.vin.length; inputIndex++) {
      var input = result.vin[inputIndex];
      if (!tx.coinbase) {
        tx.inputSatoshis += input.valueSat;
      }
      var script = null;
      var scriptAsm = null;
      if (input.scriptSig) {
        script = input.scriptSig.hex;
        scriptAsm = input.scriptSig.asm;
      } else if (input.coinbase) {
        script = input.coinbase;
      }
      tx.inputs.push({
        prevTxId: input.txid || null,
        outputIndex: _.isUndefined(input.vout) ? null : input.vout,
        script: script,
        scriptAsm: scriptAsm || null,
        sequence: input.sequence,
        address: input.address || null,
        satoshis: _.isUndefined(input.valueSat) ? null : input.valueSat
      });
    }
  }

  function addOutputsToTx(tx, result) {
    tx.outputs = [];
    tx.outputSatoshis = 0;
    for(var outputIndex = 0; outputIndex < result.vout.length; outputIndex++) {
      var out = result.vout[outputIndex];
      tx.outputSatoshis += out.valueSat;
      var address = null;
      if (out.scriptPubKey && out.scriptPubKey.addresses && out.scriptPubKey.addresses.length === 1) {
        address = out.scriptPubKey.addresses[0];
      }
      tx.outputs.push({
        satoshis: out.valueSat,
        script: out.scriptPubKey.hex,
        scriptAsm: out.scriptPubKey.asm,
        spentTxId: out.spentTxId,
        spentIndex: out.spentIndex,
        spentHeight: out.spentHeight,
        address: address
      });
    }
  }

  function addTxlockToTx(tx, result) {
    tx.txlock = result.instantlock || result.chainlock;
  }

  function addExtraPayloadToTx(tx, result) {
    if (result.version !== 3 || result.type === 0) {
      return;
    }
    tx.type = result.type;
    tx.extraPayloadSize = result.extraPayloadSize;
    tx.extraPayload = result.extraPayload;

    if (result.proRegTx !== undefined) {
      tx.proRegTx = result.proRegTx;
    }
    if (result.proUpServTx !== undefined) {
      tx.proUpServTx = result.proUpServTx;
    }
    if (result.proUpRegTx !== undefined) {
      tx.proUpRegTx = result.proUpRegTx;
    }
    if (result.proUpRevTx !== undefined) {
      tx.proUpRevTx = result.proUpRevTx;
    }
    if (result.cbTx !== undefined) {
      tx.cbTx = result.cbTx;
    }
    if (result.qcTx !== undefined) {
      tx.qcTx = result.qcTx;
    }
  }

  if (tx) {
    return setImmediate(function() {
      callback(null, tx);
    });
  } else {
    self._tryAllClients(function(client, done) {
      client.getRawTransaction(txid, 1, function(err, response) {
        if (err) {
          return done(self._wrapRPCError(err));
        }
        var result = response.result;
        var tx = {
          hex: result.hex,
          blockHash: result.blockhash,
          height: result.height ? result.height : -1,
          blockTimestamp: result.time,
          version: result.version,
          hash: txid,
          locktime: result.locktime,
        };

        if (result.vin[0] && result.vin[0].coinbase) {
          tx.coinbase = true;
        }

        addInputsToTx(tx, result);
        addOutputsToTx(tx, result);
        addExtraPayloadToTx(tx, result);

        if (!tx.coinbase) {
          tx.feeSatoshis = tx.inputSatoshis - tx.outputSatoshis;
        } else {
          tx.feeSatoshis = 0;
        }

        addTxlockToTx(tx, result);

        self.transactionDetailedCache.set(txid, tx);

        done(null, tx);
      });
    }, callback);
  }
};


/**
 * Returns a list of governance objects.
 * @param options - should be either "1" or "2", used to filter the object type
 * @param callback
 */
Dash.prototype.govObjectList = function(options, callback) {
  var self = this;
  this.client.gobject('list', function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    var gobjects = Object.keys(response.result);
    var result = [];

    for (var i = 0; i < gobjects.length; i++) {

      var proposal = new Proposal(response.result[gobjects[i]].DataHex);
      if ((options.type && proposal.type === options.type)) {
          result.push({
              Hash: gobjects[i],
              DataHex: response.result.DataHex,
              DataObject: {
                  end_epoch: proposal.end_epoch,
                  name: proposal.name,
                  payment_address: proposal.payment_address,
                  payment_amount: proposal.payment_amount,
                  start_epoch: proposal.start_epoch,
                  type: proposal.type,
                  url: proposal.url
              },
              AbsoluteYesCount: response.result[gobjects[i]].AbsoluteYesCount,
              YesCount: response.result[gobjects[i]].YesCount,
              NoCount: response.result[gobjects[i]].NoCount,
              AbstainCount: response.result[gobjects[i]].AbstainCount
          });
      }

    }

    callback(null, result);

  });
};

Dash.prototype.getCurrentVotes = function (govhash, callback) {
  var self = this;
  this.client.gobject('getcurrentvotes', govhash, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response);
  });
};

Dash.prototype.getVotes = function (govhash, callback) {
  var self = this;
  this.client.gobject('getvotes', govhash, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response);
  });
};

Dash.prototype.getSuperBlockBudget = function (blockindex, callback) {
  var self = this;
  this.client.getsuperblockbudget(blockindex, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response);
  });
};
/*jshint maxparams: 6 */
Dash.prototype.govObjectSubmit = function (parentHash, revision, time, dataHex, feeTxId, callback) {
  var self = this;
  this.client.gobject('submit', parentHash, revision, time, dataHex, feeTxId, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response);
  });
};

Dash.prototype.govObjectDeserialize = function (hexdata, callback) {
  var self = this;
  this.client.gobject('deserialize', hexdata, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response);
  });
};

Dash.prototype.govObjectCheck = function(hexdata, callback){
  var self = this;

  this.client.gobject('check', hexdata, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response);
  });
};
Dash.prototype.govObjectInfo = function (callback) {
  var self = this;
  var result = self.govCache.get('info');
  if(result){
    callback(null, result);
  }else{
    this.client.getgovernanceinfo(function(err, response) {

      if (err) {
        return callback(self._wrapRPCError(err));
      }
      self.govCache.set('info',response);
      callback(null, response);
    });
  }
};
Dash.prototype.govCount = function (callback) {
  var self = this;
  var result = self.govCache.get('count');
  if(result){
    callback(null, result);
  }else{
    this.client.gobject('count',function(err, response) {

      if (err) {
        return callback(self._wrapRPCError(err));
      }
      self.govCache.set('count',response);
      callback(null, response);
    });
  }
};
Dash.prototype.getSpork = function(callback){
	var self = this;
	var SporksList = {};
	self.client.spork('show', function(err, response){
		if(response && response.hasOwnProperty('result')){
			var result = {sporks:response.result};
			var SporksData = self.sporksListCache.get('');
			if (SporksData) {
				return setImmediate(function() {
					callback(null, SporksData);
				});
			}else{
				SporksList=result;
				self.sporksListCache.set('', SporksList);
				return callback(null, SporksList);
			}
		}else{
			return callback(new Error('Impossible to get Sporks Data'),null);
		}
	});
};

Dash.prototype.getMNList = function(callback){
  var self = this;
  var rawResults= {};
  var MNList = [];

  var checkSync = function checkSync(next) {
    self.isSynced(function (err, isSynced) {
      if (err) {
        return next(err);
      }
      if (!isSynced) {
        return next(new Error('Blockchain is not synced yet'));
      }
      return next();
    });
  };

  var getRank = function(next){
    self.client.masternodelist('rank', function(err, response){
      if(response && response.hasOwnProperty('result')){
        var result = response.result;
        rawResults.rank=result;
      }
	  next();
    });
  };
  var getProtocol = function(next){
	  self.client.masternodelist('protocol', function(err, response){
		  if(response && response.hasOwnProperty('result')){
			  var result = response.result;
			  rawResults.protocol=result;
		  }
		  next();
	  });
  };
  var getPayee = function(next){
	  self.client.masternodelist('payee', function(err, response){
		  if(response && response.hasOwnProperty('result')){
			  var result = response.result;
			  rawResults.payee=result;
		  }
		  next();
	  });
  };
  var getLastSeen = function(next){
	  self.client.masternodelist('lastseen', function(err, response){
		  if(response && response.hasOwnProperty('result')){
			  var result = response.result;
			  rawResults.lastseen=result;
		  }
		  next();
	  });
  };
  var getActiveSeconds=function(next){
	  self.client.masternodelist('activeseconds', function(err, response){
		  if(response && response.hasOwnProperty('result')){
			  var result = response.result;
			  rawResults.activeseconds=result;
		  }
		  next();
	  });
  };
  var getIP = function(next){
	  self.client.masternodelist('addr', function(err, response){
		  if(response && response.hasOwnProperty('result')){
			  var result = response.result;
			  rawResults.addr=result;
		  }
		  next();
	  });
  };
  var getStatus = function(next){
	  self.client.masternodelist('status', function(err, response){
		  if(response && response.hasOwnProperty('result')){
			  var result = response.result;
			  rawResults.status=result;
		  }
		  next();
	  });
  };

  var prepareResponse = function(err){
    if(err){
	    return callback(self._wrapRPCError(err),null);
    }
    var keys = Object.keys(rawResults);
    if(
        keys.indexOf('rank') > -1 &&
	    keys.indexOf('protocol')> -1 &&
	    keys.indexOf('payee')> -1 &&
	    keys.indexOf('lastseen')> -1 &&
	    keys.indexOf('activeseconds')> -1 &&
	    keys.indexOf('addr')> -1
    ){
        var rankKeys = Object.keys(rawResults.lastseen);
        var rankLength = rankKeys.length;

        //We get threw all vins by rank
        for(var i = 0; i<rankLength; i++){
          var vin = rankKeys[i];
          var MN = {
              vin:vin,
              status:rawResults.status[vin],
              rank:i+1,
              ip:rawResults.addr[vin],
              protocol:rawResults.protocol[vin],
              payee:rawResults.payee[vin],
              activeseconds:rawResults.activeseconds[vin],
              lastseen:rawResults.lastseen[vin],
            };
          MNList.push(MN);
        }
    }else{
          return callback(new Error('Invalid MasternodeList'),null);
    }
	  self.masternodeListCache.set('', MNList);
	  return callback(null, MNList);
  };
  var MNListData = self.masternodeListCache.get('');
  if (MNListData) {
      return setImmediate(function() {
	      callback(null, MNListData);
      });
  } else {
	  return async.series([
	    checkSync,
      getRank,
      getProtocol,
      getPayee,
      getLastSeen,
      getActiveSeconds,
      getIP,
      getStatus
    ],
    prepareResponse);
  }
};


/**
 * Retrieves a Governance Object by Hash
 * @param hash
 * @param callback
 */
Dash.prototype.govObjectHash = function(hash, callback) {
  var self = this;

  this.client.gobject('get', hash, function(err, response) {
      if (err) {
          return callback(self._wrapRPCError(err));
      }

      var result = [];

      var proposal = new Proposal(response.result.DataHex);

      // TODO: serialize proposal back to Hex to verify it's consistent with RPC
          result.push({
              Hash: response.result.Hash,
              CollateralHash: response.result.CollateralHash,
              DataHex: response.result.DataHex,
              DataObject: {
                  end_epoch: proposal.end_epoch,
                  name: proposal.name,
                  payment_address: proposal.payment_address,
                  payment_amount: proposal.payment_amount,
                  start_epoch: proposal.start_epoch,
                  type: proposal.type,
                  url: proposal.url
              },
              CreationTime: response.result.CreationTime,
              FundingResult: response.result.FundingResult,
              ValidResult: response.result.ValidResult,
              DeleteResult: response.result.DeleteResult,
              EndorsedResult: response.result.EndorsedResult
          });

      callback(null, result);

  });

};

/**
 * Checks if gobject is valid
 * @param hexdata
 * @param callback
 */
Dash.prototype.govObjectCheck = function govObjectCheck(hexdata, callback) {
  var self = this;
  this.client.gobject('check', hexdata, function (err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    return callback(null, response.result);
  });
};

/**
 * Will get the best block hash for the chain.
 * @param {Function} callback
 */
Dash.prototype.getBestBlockHash = function(callback) {
  var self = this;
  this.client.getBestBlockHash(function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response.result);
  });
};

/**
 * Will get the block hash and height of the best chainlock.
 * @param {Function} callback
 */
Dash.prototype.getBestChainLock = function (callback) {
  var self = this;
  this.client.getBestChainLock(function (err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response.result);
  });
};


/**
 * Will give the txid and inputIndex that spent an output
 * @param {Function} callback
 */
Dash.prototype.getSpentInfo = function(options, callback) {
  var self = this;
  this.client.getSpentInfo(options, function(err, response) {
    if (err && err.code === -5) {
      return callback(null, {});
    } else if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response.result);
  });
};

/**
 * This will return information about the database in the format:
 * {
 *   version: 110000,
 *   protocolVersion: 70002,
 *   blocks: 151,
 *   timeOffset: 0,
 *   connections: 0,
 *   difficulty: 4.6565423739069247e-10,
 *   testnet: false,
 *   network: 'testnet'
 *   relayFee: 1000,
 *   errors: ''
 * }
 * @param {Function} callback
 */
Dash.prototype.getInfo = function(callback) {
  var self = this;
  var client = this.client;

  client.getNetworkInfo(function (err, networkResponse){
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    const networkInfo = networkResponse.result;
    client.getBlockchainInfo(function (err, blockchainResponse){
      if(err){
        return callback(self._wrapRPCError(err));
      }
      const blockchainInfo = blockchainResponse.result;
      const info = {
        bestBlockHash: blockchainInfo.bestblockhash,
        blocks: blockchainInfo.blocks,
        chain: blockchainInfo.chain,
        difficulty: blockchainInfo.difficulty,
        errors: blockchainInfo.warnings,
        version: networkInfo.version,
        subVersion: networkInfo.subversion,
        protocolVersion: networkInfo.protocolversion,
        timeOffset: networkInfo.timeoffset,
        connections: networkInfo.connections,
        relayFee: networkInfo.relayfee,
        network: self.node.getNetworkName()
      };
      callback(null, info);
    });
  });
};

Dash.prototype.generateBlock = function(num, callback) {
  var self = this;
  this.client.generate(num, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response.result);
  });
};

/**
 * Called by Node to stop the service.
 * @param {Function} callback
 */
Dash.prototype.stop = function(callback) {
  if (this.spawn && this.spawn.process) {
    var exited = false;
    this.spawn.process.once('exit', function(code) {
      if (!exited) {
        exited = true;
        if (code !== 0) {
          var error = new Error('dashd spawned process exited with status code: ' + code);
          error.code = code;
          return callback(error);
        } else {
          return callback();
        }
      }
    });
    this.spawn.process.kill('SIGINT');
    setTimeout(function() {
      if (!exited) {
        exited = true;
        return callback(new Error('dashd process did not exit'));
      }
    }, this.shutdownTimeout).unref();
  } else {
    callback();
  }
};

module.exports = Dash;
