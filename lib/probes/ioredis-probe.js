/*
Copyright (c) AppDynamics, Inc., and its affiliates
2015
All Rights Reserved
 */
'use strict';

var uuid = require('uuid');

function IoredisProbe(agent) {
  this.agent = agent;

  this.packages = ['ioredis'];
  this.callbackQueue = {};
}
exports.IoredisProbe = IoredisProbe;


/*
 * The 'sendCommand' function is probed for all the redis command calls.
 * In v3+ of the redis driver, the callback passed to the redis command
 * calls are wrapped in a promise. The callback used for wrapping is 'pass
 * by value'. Hence, the 'callback' function received as part of arguments
 * to the 'sendCommand' is different.
 * Over here, capture the callback function passed to the redis command calls and place
 * the probes around it. Now this probed callback function is wrapped in
 * promise by redis utilities. Also attach a unique id to this probed callback
 * function which can be used by 'sendCommand' probes to put exit call details
 * for the redis call in 'callbackQueue'. In the callback invocation, the exit
 * call details can be fetched form the 'callbackQueue' and used for completing
 * the exit call.
 */
IoredisProbe.prototype.attach = function(obj) {
  var self = this;

  if(obj.__appdynamicsProbeAttached__) return;
  obj.__appdynamicsProbeAttached__ = true;
  self.agent.on('destroy', function() {
    if(obj.__appdynamicsProbeAttached__) {
      delete obj.__appdynamicsProbeAttached__;
      proxy.release(obj.Cluster.prototype.sendCommand);
      proxy.release(obj.prototype.sendCommand);
    }
  });

  var proxy = self.agent.proxy;
  var profiler = self.agent.profiler;
  var clusters = {};

  proxy.before(obj.Cluster.prototype, "sendCommand", function(obj) {
    var serverPool = [];
    if(Array.isArray(obj.startupNodes)) {
      obj.startupNodes.forEach(function(node) {
        var address = node.host + ':' + node.port;
        serverPool.push(address);
        clusters[address] = serverPool;
      });
    }
  });


  var builtInCommandsList = obj.prototype.getBuiltinCommands();
  builtInCommandsList.forEach(function(command) {
    proxy.before(obj.prototype, command, function(obj, args) {
      var uniqueIdForCb = uuid.v4();
      var callbackHooked = proxy.callback(args, -1, function(obj, args) {
        if (self.callbackQueue[uniqueIdForCb]) {
          complete(args[0], self.callbackQueue[uniqueIdForCb].locals);
          delete self.callbackQueue[uniqueIdForCb];
        }
      }, null, self.agent.thread.current());
      if (callbackHooked)
        args[args.length - 1].__appdCbId = uniqueIdForCb;
    });
  });

  proxy.around(obj.prototype, "sendCommand", function(obj, args, locals) {
    var redis = obj;
    var command = args[0];
    var commandName = command.name;
    var commandArgs = command.args;
    var address = redis.options.host + ':' + redis.options.port;

    locals.time = profiler.time();

    var serverPool = clusters[address];
    if(serverPool) {
      address = serverPool.join('\n');
    }

    var supportedProperties = {
      'SERVER POOL': address,
      'VENDOR': 'REDIS'
    };

    locals.exitCall = profiler.createExitCall(locals.time, {
      exitType: 'EXIT_CACHE',
      supportedProperties: supportedProperties,
      command: commandName,
      commandArgs: profiler.sanitize(commandArgs),
      stackTrace: profiler.stackTrace()
    });

    if (!locals.exitCall) return;

    if(command.callback && typeof(command.callback) === 'function') {
      locals.methodHasCb = true;
      if (command.callback.__appdCbId) {
        self.callbackQueue[command.callback.__appdCbId] = {
          args: args,
          locals: locals
        };
        if (process.env.NODE_ENV === 'appd_test')
          locals.exitCall.__appdCbId = command.callback.__appdCbId;
      }
    }
  }, after, false, self.agent.thread.current());

  function after(obj,args, ret, locals) {
    if (locals.methodHasCb)
      return;
    if (!ret || !ret.__appdynamicsIsPromiseResult__)
      complete(null, locals);
    else if (ret.error)
      complete(ret.error, locals);
    else
      complete(null, locals);
  }

  function complete(err, locals) {
    if (!locals.exitCall) return;
    if (!locals.time.done()) return;

    var error = self.agent.proxy.getErrorObject(err);
    profiler.addExitCall(locals.time, locals.exitCall, error);
  }
};
