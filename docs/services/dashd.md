# Dash Service

The Dash Service is a Node.js interface to [Dash Core](https://github.com/dashpay/dash) for querying information about the Dash block chain. It will connect to a running `dashd` process. It uses additional, optional indexes in Dash Core for querying information about addresses and blocks. Results are cached for performance and there are several additional API methods added for common queries.

## Configuration

The configuration should include a "connect" configuration in "dashd". This defines the JSONRPC connection information for separately managed `dashd` processes. It's also possible to connect to several separately managed `dashd` processes with round-robin querying, for example:

```json5
{
  // ...
  "services": [
    "dashd"
  ],
  "servicesConfig": {
    "dashd": {
      "connect": [
        {
          "rpchost": "127.0.0.1",
          "rpcport": 30521,
          "rpcuser": "dashrpc",
          "rpcpassword": "local321",
          "zmqpubrawtx": "tcp://127.0.0.1:30611"
        },
        {
          "rpchost": "127.0.0.1",
          "rpcport": 30522,
          "rpcuser": "dashrpc",
          "rpcpassword": "local321",
          "zmqpubrawtx": "tcp://127.0.0.1:30622"
        },
        {
          "rpchost": "127.0.0.1",
          "rpcport": 30523,
          "rpcuser": "dashrpc",
          "rpcpassword": "local321",
          "zmqpubrawtx": "tcp://127.0.0.1:30633"
        }
      ]
    }
  }
}
```

**Note**: For detailed example configuration see [`regtest/cluster.js`](regtest/cluster.js)


## API Documentation
Methods are available by directly interfacing with the service:

```js
node.services.dashd.<methodName>
```

### Chain

**Getting Latest Blocks**

```js
// gives the block hashes sorted from low to high within a range of timestamps
var high = 1460393372; // Mon Apr 11 2016 12:49:25 GMT-0400 (EDT)
var low = 1460306965; // Mon Apr 10 2016 12:49:25 GMT-0400 (EDT)
node.services.dashd.getBlockHashesByTimestamp(high, low, function(err, blockHashes) {
  //...
});

// get the current tip of the chain
node.services.dashd.getBestBlockHash(function(err, blockHash) {
  //...
})
```

**Getting Synchronization and Node Status**

```js
// gives a boolean if the daemon is fully synced (not the initial block download)
node.services.dashd.isSynced(function(err, synced) {
  //...
})

// gives the current estimate of blockchain download as a percentage
node.services.dashd.syncPercentage(function(err, percent) {
  //...
});

// gives information about the chain including total number of blocks
node.services.dashd.getInfo(function(err, info) {
  //...
});
```

**Generate Blocks**

```js
// will generate a block for the "regtest" network (development purposes)
var numberOfBlocks = 10;
node.services.dashd.generateBlock(numberOfBlocks, function(err, blockHashes) {
  //...
});
```

### Blocks and Transactions

**Getting Block Information**

It's possible to query blocks by both block hash and by height. Blocks are given as Node.js Buffers and can be parsed via Bitcore:

```js
var blockHeight = 0;
node.services.dashd.getRawBlock(blockHeight, function(err, blockBuffer) {
  if (err) {
    throw err;
  }
  var block = bitcore.Block.fromBuffer(blockBuffer);
  console.log(block);
};

// get a bitcore object of the block (as above)
node.services.dashd.getBlock(blockHash, function(err, block) {
  //...
};

// get only the block header and index (including chain work, height, and previous hash)
node.services.dashd.getBlockHeader(blockHeight, function(err, blockHeader) {
  //...
});

// get the block with a list of txids
node.services.dashd.getBlockOverview(blockHash, function(err, blockOverview) {
  //...
};
```

**Retrieving and Sending Transactions**

Get a transaction asynchronously by reading it from disk:

```js
var txid = '3dba349df7225e071179256eea2195083cd89985124be3b05e48de509cf1e268';
node.services.dashd.getRawTransaction(txid, function(err, transactionBuffer) {
  if (err) {
    throw err;
  }
  var transaction = bitcore.Transaction().fromBuffer(transactionBuffer);
});

// get a bitcore object of the transaction (as above)
node.services.dashd.getTransaction(txid, function(err, transaction) {
  //...
});

// retrieve the transaction with input values, fees, spent and block info
node.services.dashd.getDetailedTransaction(txid, function(err, transaction) {
  //...
});
```

Send a transaction to the network:

```js
var numberOfBlocks = 3;
node.services.dashd.estimateFee(numberOfBlocks, function(err, feesPerKilobyte) {
  //...
});

node.services.dashd.sendTransaction(transaction.serialize(), function(err, hash) {
  //...
});
```

### Addresses

**Get Unspent Outputs**

One of the most common uses will be to retrieve unspent outputs necessary to create a transaction, here is how to get the unspent outputs for an address:

```js
var address = 'yegvhonA7HaRvBqp57RVncFAuuqRbMQNXk';
node.services.dashd.getAddressUnspentOutputs(address, options, function(err, unspentOutputs) {
  // see below
});
```

The `unspentOutputs` will have the format:

```js
[
  {
    address: 'yegvhonA7HaRvBqp57RVncFAuuqRbMQNXk',
    txid: '65e991800c93f8272c38f28366ca901d3bb9096d34598f2903c5578ec277c85d',
    outputIndex: 1,
    height: 150,
    satoshis: 281250000,
    script: '76a914c982406f087057a97456e48d335546ae8d93a03c88ac',
    confirmations: 3
  }
]
```

**View Balances**

```js
var address = 'yTyBtDZp16HtS1jpNd1vD11y6LSyvm1XzX';
node.services.dashd.getAddressBalance(address, options, function(err, balance) {
  // balance will be in satoshis with "received" and "balance"
});
```

**View Address History**

This method will give history of an address limited by a range of block heights by using the "start" and "end" arguments. The "start" value is the more recent, and greater, block height. The "end" value is the older, and lesser, block height. This feature is most useful for synchronization as previous history can be omitted. Furthermore for large ranges of block heights, results can be paginated by using the "from" and "to" arguments.

```js
var addresses = ['yTyBtDZp16HtS1jpNd1vD11y6LSyvm1XzX'];
var options = {
  start: 345000,
  end: 344000,
  queryMempool: true
};
node.services.dashd.getAddressHistory(addresses, options, function(err, history) {
  // see below
});
```

The history format will be:

```js
{
  totalCount: 1, // The total number of items within "start" and "end"
  items: [
    {
      addresses: {
        'yTyBtDZp16HtS1jpNd1vD11y6LSyvm1XzX': {
          inputIndexes: [],
          outputIndexes: [0]
        }
      },
      satoshis: 1000000000,
      tx: <detailed_transaction> // the same format as getDetailedTransaction
    }
  ]
}
```

**View Address Summary**

```js
var address = 'yTyBtDZp16HtS1jpNd1vD11y6LSyvm1XzX';
var options = {
  noTxList: false
};

node.services.dashd.getAddressSummary(address, options, function(err, summary) {
  // see below
});
```

The `summary` will have the format (values are in satoshis):

```js
{
  totalReceived: 1000000000,
  totalSpent: 0,
  balance: 1000000000,
  unconfirmedBalance: 1000000000,
  appearances: 1,
  unconfirmedAppearances: 0,
  txids: [
    '3f7d13efe12e82f873f4d41f7e63bb64708fc4c942eb8c6822fa5bd7606adb00'
  ]
}
```
**Notes**:
- `totalReceived` does not exclude change *(the amount of satoshis originating from the same address)*
- `unconfirmedBalance` is the delta that the unconfirmed transactions have on the total balance *(can be both positive and negative)*
- `unconfirmedAppearances` is the total number of unconfirmed transactions
- `appearances` is the total confirmed transactions
- `txids` Are sorted in block order with the most recent at the beginning. A maximum of 1000 *(default)* will be returned, the `from` and `to` options can be used to get further values.


## Events
The Dash Service exposes two events via the Bus, and there are a few events that can be directly registered:

```js
node.services.dashd.on('tip', function(blockHash) {
  // a new block tip has been added, if there is a rapid update (with a second) this will not emit every tip update
});

node.services.dashd.on('tx', function(transactionBuffer) {
  // a new transaction has entered the mempool
});

node.services.dashd.on('block', function(blockHash) {
  // a new block has been added
});
```

For details on instantiating a bus for a node, see the [Bus Documentation](../bus.md).
- Name: `dashd/rawtransaction`
- Name: `dashd/hashblock`
- Name: `dashd/addresstxid`, Arguments: [address, address...]

**Examples:**

```js
bus.subscribe('dashd/rawtransaction');
bus.subscribe('dashd/hashblock');
bus.subscribe('dashd/addresstxid', ['XxoNntPX7RNFKHUhuGNUthb1UQpYnKuCsk']);

bus.on('dashd/rawtransaction', function(transactionHex) {
  //...
});

bus.on('dashd/hashblock', function(blockhashHex) {
  //...
});

bus.on('dashd/addresstxid', function(data) {
  // data.address;
  // data.txid;
});
```
