/*
 Copyright (c) AppDynamics, Inc., and its affiliates
 2015
 All Rights Reserved
 */
'use strict';
var utility = require('../utility');

function MongodbProbe(agent) {
  this.agent = agent;

  this.packages = ['mongodb'];
}

exports.MongodbProbe = MongodbProbe;
var collectionCommands = ['createCollection', 'dropCollection'];

MongodbProbe.prototype.attach = function (obj) {
  var self = this;
  var proxy = self.agent.proxy;
  var profiler = self.agent.profiler;
  var mongoObj = obj;

  if (obj.__appdynamicsProbeAttached__) return;
  obj.__appdynamicsProbeAttached__ = true;

  function withoutAPMAfterHandler(obj, args, ret, locals) {
    if (locals.exitCall && locals.exitCall.command === 'find') return;
    if (locals.methodHasCb) return;
    if (!ret || !ret.__appdynamicsIsPromiseResult__)
      self.addExitCall(locals.time, locals.exitCall, args);
    else if (ret.error)
      self.addExitCall(locals.time, locals.exitCall, ret.error);
    else
      self.addExitCall(locals.time, locals.exitCall);
  }

  function withAPMBeforeHandler(obj, args) {
    proxy.callback(args, -1, null, null, self.agent.thread.current());
  }

  self.agent.on('destroy', function () {
    if (obj.__appdynamicsProbeAttached__) {
      delete obj.__appdynamicsProbeAttached__;
    }

    proxy.release(obj.Db.prototype.createCollection);
    proxy.release(obj.Db.prototype.dropCollection);
    proxy.release(obj.Server.prototype.cursor);
    proxy.release(obj.Server.prototype.insert);
    proxy.release(obj.Server.prototype.update);
    proxy.release(obj.Server.prototype.remove);
    proxy.release(obj.ReplSet.prototype.cursor);
    proxy.release(obj.ReplSet.prototype.insert);
    proxy.release(obj.ReplSet.prototype.update);
    proxy.release(obj.ReplSet.prototype.remove);
    proxy.release(obj.Cursor.prototype._next);
  });

  if ('instrument' in obj) {
    // driver 2.x with APM API
    var serverPool;
    var opQueue = {};
    var listener = obj.instrument();
    var apmCollectionEvents = ['create', 'drop'];
    var collectionCommandMap = {
      'create': 'createCollection',
      'drop': 'dropCollection',
      'find': 'find',
      'cursor': 'cursor',
      'insert': 'insert',
      'update': 'update',
      'remove': 'remove'
    };
    var supportedCommands = ['find', 'cursor', 'insert', 'update', 'remove'].concat(apmCollectionEvents);

    // expose opQueue for integration testing
    self.__opQueue = opQueue;

    listener.on('started', function (event) {
      var requestId = event.requestId, request, commandQuery;
      if (supportedCommands.indexOf(event.commandName) < 0) return;
      if (event.connectionId) {
        var cid = event.connectionId;
        if (typeof (cid) === 'string')
          serverPool = [cid];
        else
          serverPool = [cid.host + ':' + cid.port];
      }
      if (serverPool) {
        if (!opQueue[requestId]) {
          opQueue[requestId] = {
            time: profiler.time(),
            serverPool: serverPool
          };
        }
        request = opQueue[requestId];
        commandQuery = event.command.filter;
        if (event.command.filter && Object.prototype.toString.call(event.command.filter) == "[object Object]") {
          commandQuery = utility.filterSensitiveDataFromObject(utility.deepCopy(event.command.filter));
        }
        var commandDetails = {
          command: collectionCommandMap[event.commandName],
          databaseName: event.databaseName,
          collectionName: event.command[event.commandName],
          query: profiler.sanitize(JSON.stringify(commandQuery)),
          numberToSkip: event.command.skip,
          numberToReturn: event.command.limit
        };

        request.exitCall = self.createExitCall(request.time, serverPool,
          commandDetails, event.commandName == 'find' ? 'read' : 'write',
          profiler.stackTrace());
      }
    });

    listener.on('succeeded', function (event) {
      var requestId = event.requestId, request = opQueue[requestId];
      if (request) {
        self.addExitCall(request.time, request.exitCall);
        opQueue[requestId] = undefined;
      }
    });

    listener.on('failed', function (event) {
      var requestId = event.requestId, request = opQueue[requestId];
      if (request) {
        self.addExitCall(event.time, event.exitCall, event.failure);
        opQueue[requestId] = undefined;
      }
    });

    supportedCommands.forEach(function (command) {
      proxy.before(obj.Server.prototype, command, withAPMBeforeHandler);
      proxy.before(obj.ReplSet.prototype, command, withAPMBeforeHandler);
    });

    collectionCommands.forEach(function (command) {
      proxy.before(obj.Db.prototype, command, withAPMBeforeHandler);
    });
  } else if (!('version' in obj)) {
    // driver 2.x w/out APM API
    var commands = ['cursor', 'insert', 'update', 'remove'];

    // queries via a cursor find command must be reported after they complete:
    proxy.around(obj.Cursor.prototype, '_next', function (obj, args, locals) {
      locals.methodHasCb = proxy.callback(args, -1, function (obj_, args) {
        complete(args, obj);
      });
    }, after);

    collectionCommands.forEach(function (command) {
      function withoutAPMBeforeHandler(obj, args, locals) {
        var commandDetails;
        var category;
        var commandName = command == 'cursor' ? 'find' : command;

        if (command == 'cursor' && !args[1].find) return;
        var serverPool = [];
        if (obj.serverConfig instanceof mongoObj.ReplSet)
          serverPool = self.getServerPool(obj.serverConfig.s, true);
        else
          serverPool = self.getServerPool(obj);
        if (serverPool.length) {
          commandDetails = {
            command: commandName,
            databaseName: obj.s.databaseName,
            collectionName: args[0]
          };

          if (obj.auths && obj.auths.length > 0) {
            commandDetails.auth = obj.auths[0];
          }

          category = "write";

          locals.time = profiler.time();

          locals.exitCall = self.createExitCall(locals.time, serverPool,
            commandDetails, category, profiler.stackTrace());
        }

        locals.methodHasCb = proxy.callback(args, -1, function (obj, args) {
          self.addExitCall(locals.time, locals.exitCall, args);
        });
      }

      proxy.around(obj.Db.prototype, command, withoutAPMBeforeHandler, withoutAPMAfterHandler);
    });

    commands.forEach(function (command) {
      var commandName = command == 'cursor' ? 'find' : command;
      function withoutAPMBeforeHandler(obj, args, locals) {
        var commandDetails;
        var category;
        var opts = {};
        var query = '';

        if (command == 'cursor' && !args[1].find) return;

        var serverPool = [];
        if (obj instanceof mongoObj.ReplSet)
          serverPool = self.getServerPool(obj.s, true);
        else
          serverPool = self.getServerPool(obj.s);
        if (serverPool.length) {
          opts = {};
          if (args[1] && args[1].query) {
            query = args[1].query;
            if (Object.prototype.toString.call(query) == "[object Object]") {
              query = utility.filterSensitiveDataFromObject(Object.assign({}, args[1].query));
            }
            query = profiler.sanitize(JSON.stringify(query));
            Object.keys(args[1]).forEach(function (key) {
              if (key !== 'query') {
                opts[key] = args[1][key];
              }
            });
          }

          commandDetails = {
            command: commandName,
            databaseName: args[0].split('.')[0],
            collectionName: args[0].split('.')[1],
            query: query,
            numberToSkip: opts.skip,
            numberToReturn: opts.limit
          };

          if (obj.s.auths && obj.s.auths.length > 0) {
            commandDetails.auth = obj.s.auths[0];
          }

          if (commandName == 'find') {
            category = "read";
          } else {
            category = "write";
          }

          locals.time = profiler.time();

          locals.exitCall = self.createExitCall(locals.time, serverPool,
            commandDetails, category, profiler.stackTrace());
        }

        if (commandName == 'find') {
          // stash exit call for later processing
          args[1].__appd_exitcall_info = {
            time: locals.time,
            exitCall: locals.exitCall
          };
          locals.methodHasCb = true;
        } else {
          locals.methodHasCb = proxy.callback(args, -1, function (obj, args) {
            self.addExitCall(locals.time, locals.exitCall, args);
          }, null, self.agent.thread.current());
        }
      }
      proxy.around(obj.Server.prototype, command, withoutAPMBeforeHandler, withoutAPMAfterHandler);
      proxy.around(obj.ReplSet.prototype, command, withoutAPMBeforeHandler, withoutAPMAfterHandler);
    });
  }

  function complete(err, obj, driver) {
    var exitCallInfoHolder;
    if (driver && driver == '1.x') {
      exitCallInfoHolder = obj;
    } else {
      if (!obj.cursorState.dead && (!obj.cursorState.notified || !(obj.cursorState.documents.length == 0))) return;
      if (!obj.cmd || !obj.cmd.__appd_exitcall_info) return;
      exitCallInfoHolder = obj.cmd.__appd_exitcall_info;
    }

    if (!exitCallInfoHolder.exitCall) return;
    if (!exitCallInfoHolder.time) return;
    self.addExitCall(exitCallInfoHolder.time, exitCallInfoHolder.exitCall, err);
  }

  function after(obj, args, ret, locals) {
    if (locals.methodHasCb) return;
    if (locals.driver == '1.x')
      obj = locals;
    if (!ret || !ret.__appdynamicsIsPromiseResult__)
      complete(null, obj, locals.driver);
    else if (ret.error)
      complete(ret.error, obj, locals.driver);
    else {
      complete(null, obj, locals.driver);
    }
  }
};

MongodbProbe.prototype.getServerPool = function (db, isReplicaSet) {
  var serverPool = [];

  // db.replset keeps server details for MongoDriver 2.x
  // db.coreTopology keeps server details for MongoDriver 3.x
  var serverConfig;
  if (isReplicaSet) {
    serverConfig = db && (db.replset || db.coreTopology || db);
    if (serverConfig && serverConfig.ismaster && serverConfig.ismaster.primary) {
      serverPool.push(serverConfig.ismaster.primary);
    }
  } else {
    serverConfig = db && (db.serverConfig || db.serverDetails || db);

    if (serverConfig) {
      if (serverConfig.s && serverConfig.s.host && serverConfig.s.port) {
        serverPool.push(serverConfig.s.host + ':' + serverConfig.s.port);
      }
      else if (serverConfig.host && serverConfig.port) {
        serverPool.push(serverConfig.host + ':' + serverConfig.port);
      }
      else if (Array.isArray(serverConfig.servers)) {
        serverConfig.servers.forEach(function (server) {
          serverPool.push(server.host + ':' + server.port);
        });
      }
    }
  }

  if (serverPool.length) {
    serverPool.sort();
  }

  return serverPool;
};

MongodbProbe.prototype.createExitCall = function (time, serverPool, commandDetails, category, stackTrace) {
  var address = serverPool[serverPool.length - 1],
    exitCallCommand;
  try {
    exitCallCommand = JSON.stringify(commandDetails);
  } catch (e) {
    return;
  }

  var supportedProperties = {
    'HOST': address.split(':')[0],
    'PORT': address.split(':')[1],
    'DATABASE': commandDetails.databaseName
  };

  return this.agent.profiler.createExitCall(time, {
    exitType: 'EXIT_CUSTOM',
    exitSubType: 'Mongo DB',
    configType: 'Mongodb',
    supportedProperties: supportedProperties,
    category: category,
    command: exitCallCommand,
    stackTrace: stackTrace,
    vendor: "MONGODB"
  });
};

MongodbProbe.prototype.addExitCall = function (time, exitCall, args) {
  var self = this;
  if (!time || !time.done()) return;

  var error = self.agent.proxy.getErrorObject(args);
  var profiler = self.agent.profiler;

  if (exitCall) {
    profiler.addExitCall(time, exitCall, error);
  }
};
