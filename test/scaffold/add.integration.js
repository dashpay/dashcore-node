'use strict';

var should = require('chai').should();
var sinon = require('sinon');
var path = require('path');
var fs = require('fs');
var proxyquire = require('proxyquire');
var rimraf = require('rimraf');
var add = require('../../lib/scaffold/add');

describe('#add', function() {

  var basePath = path.resolve(__dirname, '..');
  var testDir = path.resolve(basePath, 'temporary-test-data');
  var startConfig = {
    name: 'My Node',
    services: []
  };
  var startPackage = {};

  before(function(done) {
    fs.mkdir(testDir + '/s0/s1', { recursive: true }, function(err) {
      if (err) {
        throw err;
      }
      fs.writeFile(
        testDir + '/s0/s1/dashcore-node.json',
        JSON.stringify(startConfig),
        function(err) {
          if (err) {
            throw err;
          }
          fs.writeFile(
            testDir + '/s0/s1/package.json',
            JSON.stringify(startPackage),
            done
          );
        }
      );
    });
  });

  after(function(done) {
    // cleanup testing directories
    rimraf(testDir, function(err) {
      if (err) {
        throw err;
      }
      done();
    });
  });

  describe('will modify scaffold files', function() {

    it('will give an error if expected files do not exist', function(done) {
      add({
        path: path.resolve(testDir, 's0'),
        services: ['a', 'b', 'c']
      }, function(err) {
        should.exist(err);
        err.message.match(/^Invalid state/);
        done();
      });
    });

    it('will receive error from `npm install`', function(done) {
      var spawn = sinon.stub().returns({
        stdout: {
          on: sinon.stub()
        },
        stderr: {
          on: sinon.stub()
        },
        on: sinon.stub().callsArgWith(1, 1)
      });
      var addtest = proxyquire('../../lib/scaffold/add', {
        'child_process': {
          spawn: spawn
        }
      });

      addtest({
        path: path.resolve(testDir, 's0/s1/'),
        services: ['a', 'b', 'c']
      }, function(err) {
        should.exist(err);
        err.message.should.equal('There was an error installing service: a');
        done();
      });
    });

    it('will update dashcore-node.json services', function(done) {
      var callCount = 0;
      var oldPackage = {
        dependencies: {
          '@dashevo/dashcore-lib': '^v0.15.4',
          '@dashevo/dashcore-node': '^v3.0.7'
        }
      };
      var spawn = sinon.stub().returns({
        stdout: {
          on: sinon.stub()
        },
        stderr: {
          on: sinon.stub()
        },
        on: sinon.stub().callsArgWith(1, 0)
      });
      var addtest = proxyquire('../../lib/scaffold/add', {
        'child_process': {
          spawn: spawn
        },
        'fs': {
          readFileSync: function() {
            if (callCount === 1){
              oldPackage.dependencies.a = '^v0.1';
            } else if (callCount === 2){
              oldPackage.dependencies.b = '^v0.1';
            } else if (callCount === 3){
              oldPackage.dependencies.c = '^v0.1';
            }
            callCount++;
            return JSON.stringify(oldPackage);
          }
        }
      });
      addtest({
        path: path.resolve(testDir, 's0/s1/'),
        services: ['a', 'b', 'c']
      }, function(err) {
        should.not.exist(err);
        var configPath = path.resolve(testDir, 's0/s1/dashcore-node.json');
        var config = JSON.parse(fs.readFileSync(configPath));
        config.services.should.deep.equal(['a','b','c']);
        done();
      });
    });

  });

});
