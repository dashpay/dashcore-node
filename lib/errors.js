"use strict";

var createError = require("errno").create;

var DashcoreNodeError = createError("DashcoreNodeError");

var RPCError = createError("RPCError", DashcoreNodeError);

module.exports = {
  Error: DashcoreNodeError,
  RPCError: RPCError,
};
