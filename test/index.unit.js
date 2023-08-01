"use strict";

var should = require("chai").should();

describe("Index Exports", function () {
  it("will export dashcore-lib", function () {
    var dashcore = require("../");
    should.exist(dashcore.lib);
    should.exist(dashcore.lib.Transaction);
    should.exist(dashcore.lib.Block);
  });
});
