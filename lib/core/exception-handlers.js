/*
* Copyright (c) AppDynamics, Inc., and its affiliates
* 2016
* All Rights Reserved
*/
'use strict';

var path = require('path');

function ExceptionHandlers() {
  this.agent = undefined;
  this.uncaughtHandler = undefined;
  this.termCallback = undefined;
  this.exceptionCallback = undefined;
}
exports.ExceptionHandlers = ExceptionHandlers;

function defineSignalHandler(eh, sig, callback) {
  if (!eh.signalHandlers) {
    eh.signalHandlers = [];
  }

  eh.signalHandlers[sig] = function () {
    eh.agent.logger.warn('Received Signal ' + sig);
    eh.agent.logger.info("Node Agent Terminated -- " + JSON.stringify(arguments));
    for (var s in eh.signalHandlers) {
      process.removeListener(s, eh.signalHandlers[s]);
    }
    callback();
    process.removeListener('uncaughtException', eh.uncaughtHandler);
    process.kill(process.pid, sig);
  };
  process.on(sig, eh.signalHandlers[sig]);
}

ExceptionHandlers.prototype.init = function (agent, termCallback, exceptionCallback) {
  var self = this;

  self.agent = agent;
  self.termCallback = termCallback;
  self.exceptionCallback = exceptionCallback;

  defineSignalHandler(self, 'SIGINT', termCallback);
  defineSignalHandler(self, 'SIGTERM', termCallback);

  // determine if the exception is from node agent code (in which case
  // we should log it and terminate), or due to a user script error
  // (in which case we should behave the way a process without
  // instrumentation works)
  self.uncaughtHandler = function (e) {
    self.agent.logger.error('Uncaught exception:' + e);
    self.exceptionCallback(e);
    var stackTrace = e.stack;

    if (!stackTrace) {
      // user-created error
      return;
    }
    // remove error information from stack
    stackTrace = stackTrace.split(/\r?\n/g);
    stackTrace.shift();

    var installDir = path.resolve(__dirname, "../..") || "/";

    // find the relative path of the first valid stacktrace entry
    var relativePath = stackTrace.reduce(function(prev, entry) {
      // stack trace lines may display function name with location in
      // parentheses, or just the location name
      if (prev != null)
        return prev;

      var expr = /at ([^ ]*) \(([^:]*):/;
      var match = expr.exec(entry);
      var file;

      if (match && match[2]) {
        file = match[2];
      }
      else {
        expr = /at ([^:]*):/;
        match = expr.exec(entry);
        if (match && match[1]) {
          file = match[1];
        }
      }

      if (file) {
        return path.relative(installDir, path.dirname(file));
      }
      else {
        return prev;
      }
    }, null);

    if (relativePath && relativePath[0] !== '.') {
      // node agent internal exception thrown, needs to be logged
      // before we stop monitoring
      self.agent.logger.info(stackTrace);
      var listeners = process.listeners('uncaughtException');
      if (listeners && listeners.length == 1) {
        process.removeListener('uncaughtException', self.uncaughtHandler);
        self.signalHandlers['SIGTERM']();
      }
    }
  };
  process.on('uncaughtException', self.uncaughtHandler);
};
