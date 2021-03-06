/*
 * Copyright (c) AppDynamics, Inc., and its affiliates
 * 2016
 * All Rights Reserved
 * THIS IS UNPUBLISHED PROPRIETARY CODE OF APPDYNAMICS, INC.
 * The copyright notice above does not evidence any actual or intended publication of such source code
 */

'use strict';

function CouchBaseProbe(agent) {
  this.agent = agent;
  this.packages = ['couchbase'];
}

exports.CouchBaseProbe = CouchBaseProbe;

CouchBaseProbe.prototype.attach = function(obj) {
  var self = this;

  if(obj.__appdynamicsProbeAttached__) return;
  obj.__appdynamicsProbeAttached__ = true;
  self.agent.on('destroy', function() {
    if(obj.__appdynamicsProbeAttached__) {
      delete  obj.__appdynamicsProbeAttached__;
      proxy.release(obj.Cluster.prototype.openBucket);
    }
  });

  var proxy = self.agent.proxy;

  proxy.around(obj.Cluster.prototype, 'openBucket', function(obj, args, locals) {
    locals.time = self.agent.profiler.time();
    locals.methodHasCb = proxy.callback(args, -1, function() {}, null, self.agent.thread.current());
  } ,function(obj, args, ret, locals) {
    var couchBaseBucket = ret,
      addresses = obj.dsnObj.hosts,
      bucketName = obj.dsnObj.bucket;

    addresses = addresses.map(function(hostEntry) {
      return hostEntry[0] + ':' + hostEntry[1];
    });

    var supportedProperties = {
      'SERVER POOL': addresses.join('\n'),
      'VENDOR': 'COUCHBASE',
      'BUCKET NAME': bucketName
    };

    // There are two keys for n1qlReq value. Need this to instrument different versions of
    // couchbase.
    // Node driver < v2.0.8 of couchbase just had '_query' method to represent n1ql query
    // Node driver >= v2.0.8 have a designated method '_n1ql' to represent n1ql query
    var queryCommandsMap = {
      '_view': '_viewReq',
      '_n1ql': '_n1qlReq',
      '_fts': '_ftsReq',
      '_query': '_n1qlReq',
      'get': 'get'};
    Object.keys(queryCommandsMap).forEach(function(command) {
      proxy.around(couchBaseBucket, command, function(obj, args, locals) {
        obj.__appdIsInstrumented = true;
        var commandArgs = args;
        command = queryCommandsMap[command];

        self.createExitCall(supportedProperties, command, commandArgs, locals);
      }, after, false, locals.time.threadId);
    });

    proxy.before(couchBaseBucket, 'disconnect', function(obj){
      obj.__appdIsInstrumented = true;
    });

    proxy.around(couchBaseBucket, '_invoke', function(obj, args, locals) {
      // In the node v2 couchbase driver, the query methods end up calling
      // the _invoke method. Avoid duplication of exit call by checking against
      // '__appdIsInstrumented' property.
      if (!obj.__appdIsInstrumented) {
        // args are going to be [0] -- fn the operation callback to invoke
        //                      [1] --- Array of arguments to pass to the function
        // The last argument to the array of arguments is the callback function

        var command = args[0].toString();
        command = command.substr('function '.length);
        command = command.substr(0, command.indexOf('('));
        var commandArgs = args[1];

        self.createExitCall(supportedProperties, command, commandArgs, locals);
      }
    }, after, false, locals.time.threadId);
  });

  function after(obj, args, ret, locals) {
    if (locals.methodHasCb) {
      return;
    }
    if (!ret || !ret.__appdynamicsIsPromiseResult__) {
      self.complete(null, locals);
    } else if (ret.error) {
      self.complete(ret.error, locals);
    } else {
      self.complete(null, locals);
    }
  }
};

CouchBaseProbe.prototype.createExitCall = function(supportedProperties, command, commandArgs, locals) {
  var self = this, profiler = self.agent.profiler;
  locals.time = profiler.time();
  locals.exitCall = profiler.createExitCall(locals.time, {
    exitType: 'EXIT_CUSTOM',
    exitSubType: 'Couchbase',
    configType: 'CouchBase',
    supportedProperties: supportedProperties,
    command: command,
    commandArgs: commandArgs,
    stackTrace: profiler.stackTrace()
  });

  if (!locals.exitCall) return;

  locals.methodHasCb = self.agent.proxy.callback(commandArgs, -1, function(obj, args) {
    self.complete(args, locals);
  }, null, self.agent.thread.current());
};

CouchBaseProbe.prototype.complete = function(err, locals) {
  if (!locals.exitCall) return;
  if (!locals.time.done()) return;
  var error = this.agent.proxy.getErrorObject(err);
  this.agent.profiler.addExitCall(locals.time, locals.exitCall, error);
};
