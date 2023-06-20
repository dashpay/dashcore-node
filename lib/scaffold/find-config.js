"use strict";

var dashcore = require("@dashevo/dashcore-lib");
var $ = dashcore.util.preconditions;
var _ = dashcore.deps._;
var path = require("path");
var fs = require("fs");
var utils = require("../utils");

/**
 * Will return the path and dashcore-node configuration
 * @param {String} cwd - The absolute path to the current working directory
 */
function findConfig(cwd) {
  $.checkArgument(_.isString(cwd), "Argument should be a string");
  $.checkArgument(utils.isAbsolutePath(cwd), "Argument should be an absolute path");
  var directory = String(cwd);
  while (!fs.existsSync(path.resolve(directory, "dashcore-node.json"))) {
    directory = path.resolve(directory, "../");
    if (directory === "/") {
      return false;
    }
  }
  return {
    path: directory,
    config: require(path.resolve(directory, "dashcore-node.json")),
  };
}

module.exports = findConfig;
