Bitcore Node Dash
============

A Dash full node for building applications and services with Node.js. A node is extensible and can be configured to run additional services. At the minimum a node has an interface to [Dash Core with additional indexing](https://github.com/snogcel/dash/tree/v0.12.1.x) for more advanced address queries. Additional services can be enabled to make a node more useful such as exposing new APIs, running a block explorer and wallet service.

## Install

```bash
npm install -g bitcore-node-dash
```

Installation of bitcore-node-dash can also be performed using a Dockerfile. Please note that this Dockerfile is still under development and should be considered an 'Alpha' version, see [docker-bitcore_insight_dash](https://github.com/moocowmoo/docker-bitcore_insight_dash) for more details.

## Prerequisites

- Dash Core (v0.12.1.x) with support for additional indexing *(see above)*
- Node.js v0.10, v0.12, v4 or v5
- ZeroMQ *(libzmq3-dev for Ubuntu/Debian or zeromq on OSX)*
- ~20GB of disk storage
- ~1GB of RAM

## Configuration

Bitcore includes a Command Line Interface (CLI) for managing, configuring and interfacing with your Bitcore Node.

```bash
bitcore-node-dash create -d <dash-data-dir> mynode
cd mynode
bitcore-node-dash install <service>
bitcore-node-dash install https://github.com/yourname/helloworld
bitcore-node-dash start
```

This will create a directory with configuration files for your node and install the necessary dependencies.

Please note that [Dash Core with additional indexing](https://github.com/snogcel/dash/tree/v0.12.1.x) must be compiled seperately. Once completed the dashd binary should be placed into the &lt;dash-data-dir&gt; folder specified during node creation.

For more information about (and developing) services, please see the [Service Documentation](docs/services.md).

## Add-on Services

There are several add-on services available to extend the functionality of Bitcore:

- [Insight API Dash](https://github.com/dashpay/insight-api-dash/tree/master)
- [Insight UI Dash](https://github.com/dashpay/insight-ui-dash/tree/master)
- Bitcore Wallet Service (coming soon)

## Documentation

- [Upgrade Notes](docs/upgrade.md)
- [Services](docs/services.md)
  - [Bitcoind](docs/services/bitcoind.md) - Interface to Bitcoin Core
  - [Web](docs/services/web.md) - Creates an express application over which services can expose their web/API content
- [Development Environment](docs/development.md) - Guide for setting up a development environment
- [Node](docs/node.md) - Details on the node constructor
- [Bus](docs/bus.md) - Overview of the event bus constructor
- [Release Process](docs/release.md) - Information about verifying a release and the release process.

## Contributing

Please send pull requests for bug fixes, code optimization, and ideas for improvement. For more information on how to contribute, please refer to our [CONTRIBUTING](https://github.com/bitpay/bitcore/blob/master/CONTRIBUTING.md) file.

## License

Code released under [the MIT license](https://github.com/bitpay/bitcore-node-dash/blob/master/LICENSE).

Copyright 2013-2015 BitPay, Inc.

- bitcoin: Copyright (c) 2009-2015 Bitcoin Core Developers (MIT License)
