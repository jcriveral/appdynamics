/*
Copyright (c) AppDynamics, Inc., and its affiliates
2015
All Rights Reserved
 */
'use strict';

var Time = require('../core/time').Time;
var Transaction = require('../transactions/transaction').Transaction;

/*
 * Trasaction profiler is responsible for managing the sampling process:
 * finding related operations, emitting exitCalls and providing api
 * for probes to create samples.
 */

function Profiler(agent) {
  this.agent = agent;

  this.transactions = {};
  this.stackTraceFilter = /appdynamics/;
}
exports.Profiler = Profiler;


Profiler.prototype.init = function() {
  var self = this;

  // cleanup transactions
  self.agent.timers.setInterval(function() {
    // expire transactions older than 5 minutes, which have not ended
    var now = Date.now();
    for(var threadId in self.transactions) {
      if(self.transactions[threadId].touched + 300000 < now) {
        self.agent.logger.info('transaction ' + self.transactions[threadId].id + ' dropped');
        delete self.transactions[threadId];
      }
    }
  }, 5000);
};

Profiler.prototype.processSnapshotStarted = function(processSnapshot) {
  var self = this;
  var guid = processSnapshot.guid;
  for(var threadId in self.transactions) {
    self.transactions[threadId].addProcessSnapshotGUID(guid);
  }
};

/* istanbul ignore next -- not unit testable, requires integration testing */
Profiler.prototype.time = function(isTransaction) {
  var t =  new Time(this.agent, isTransaction);
  t.start();

  return t;
};

Profiler.prototype.stackTrace = function(exitCall) {
  if(!exitCall || !exitCall.isSnaphotEnabled) {
    return undefined;
  }

  var err = new Error();
  Error.captureStackTrace(err);

  return this.formatStackTrace(err);
};

Profiler.prototype.formatStackTrace = function(err) {
  var self = this;

  if(err && err.stack) {
    var lines = err.stack.split("\n");
    lines.shift();
    lines = lines.filter(function(line) {
      return !self.stackTraceFilter.exec(line);
    });

    return lines;
  }

  return undefined;
};


Profiler.prototype.startTransaction = function(time, req, entryType) {
  var self = this;

  var transaction = new Transaction();
  transaction.time = time;
  transaction.id = time.id;
  transaction.ts = time.begin;
  transaction.touched = time.begin;
  transaction.threadId = time.threadId;
  transaction.entryType = entryType;
  transaction.httpRequestData = {
    url: req.url,
    method: req.method,
    headers: Object.assign({}, req.headers)
  };

  self.transactions[time.threadId] = transaction;

  var delayedCallbackAttached = false;
  transaction.on('delayedCallbackReady', function() {
    delayedCallbackAttached = true;
  });

  transaction.once('transactionIgnored', function() {
    if (delayedCallbackAttached) {
      transaction.emit('ignoreTransactionCbExecute');
    } else {
      transaction.on('delayedCallbackReady', function() {
        transaction.emit('ignoreTransactionCbExecute');
      });
    }
  });

  try {
    self.agent.emit('transactionStarted', transaction, req);
  }
  catch(err) {
    self.agent.logger.warn(err);
  }

  return transaction;
};

Profiler.prototype.asyncEndTransaction = function(exitCallTime, transaction) {
  var self = this;

  if(transaction.isFinished) {
    // ignore finished transactions
    return;
  }

  if(!transaction.isResponseSent) {
    // ignore "synchronous" transactions, which are waiting for their exit calls
    return;
  }

  if(transaction.startedExitCalls) {
    if(!transaction.exitCalls || transaction.startedExitCalls.length !== transaction.exitCalls.length) {
      // waiting for exit calls to end
      // exit calls will call endTransaction
      return;
    }
  }

  self._endTransaction(exitCallTime, transaction);
};

Profiler.prototype.endTransaction = function(time, transaction) {
  var self = this;

  if(transaction.isResponseSent) {
    return;
  }

  transaction.isResponseSent = true;
  transaction.ms = time.ms;

  if(transaction.startedExitCalls) {
    if(!transaction.exitCalls || transaction.startedExitCalls.length !== transaction.exitCalls.length) {
      // waiting for exit calls to end
      // exit calls will call endTransaction

      return;
    }
  }

  self._endTransaction(time, transaction);
};

Profiler.prototype._endTransaction = function(time, transaction) {
  var self = this;

  transaction.isFinished = true;

  try {
    self.agent.emit('transaction', transaction);
  }
  catch(err) {
    self.agent.logger.warn(err);
  }

  delete self.transactions[time.threadId];
};

Profiler.prototype.getTransaction = function(threadId) {
  var self = this;

  return self.transactions[threadId];
};

Profiler.prototype.transactionDropped = function(guid) {
  var self = this;

  for(var threadId in self.transactions) {
    if(self.transactions[threadId].guid === guid) {
      self.agent.logger.info('transaction ' + self.transactions[threadId].id + ' dropped');
      delete self.transactions[threadId];
      break;
    }
  }
};

Profiler.prototype.__getNextSequenceInfo = function(transaction) {
  var self = this;
  transaction.exitCallCounter++;
  var exitCallCount = transaction.exitCallCounter.toString();

  if (transaction.corrHeader && (!transaction.corrHeader.crossAppCorrelation)) {
    var correlation = self.agent.correlation;

    var incomingSequenceInfo =
      transaction.corrHeader.getSubHeader(correlation.EXIT_POINT_GUID, null);
    return incomingSequenceInfo ? (incomingSequenceInfo + "|" + exitCallCount) : exitCallCount;
  }
  return exitCallCount;
};

Profiler.prototype.createExitCall = function(time, exitCallInfo) {
  return this.agent.backendConnector.createExitCall(time, exitCallInfo);
};

Profiler.prototype.addExitCall = function(time, exitCall, error) {
  var self = this;

  exitCall.ms = time.ms;
  exitCall.error = error;

  var transaction = self.transactions[exitCall.threadId];
  self.tryEndingTransactionAfterExitCall(transaction, exitCall, time);
};

Profiler.prototype.tryEndingTransactionAfterExitCall = function(transaction, exitCall, time) {
  var self = this;
  if (transaction && !transaction.ignore) {
    if (!exitCall.sequenceInfo) {
      exitCall.sequenceInfo = self.__getNextSequenceInfo(transaction);
    }

    if (transaction.api && transaction.api.exitCallCompleted) {
      exitCall = transaction.api.exitCallCompleted(exitCall) || exitCall;
    }

    if (!transaction.exitCalls) {
      transaction.exitCalls = [];
    }

    transaction.exitCalls.push(exitCall);

    // try to end transaction
    self.asyncEndTransaction(time, transaction);
  }
};

Profiler.prototype.sanitize = function(args) {
  if(!args) return undefined;

  if(typeof args === 'string') {
    return args;
  }

  if(!args.length) return undefined;

  var arr = [];
  var argsLen = (args.length > 50 ? 50 : args.length);
  for(var i = 0; i < argsLen; i++) {
    if(typeof args[i] === 'string') {
      arr.push(args[i]);
    }
    else if(typeof args[i] === 'number') {
      arr.push(args[i].toString());
    }
    else if(args[i] === undefined) {
      arr.push('[undefined]');
    }
    else if(args[i] === null) {
      arr.push('[null]');
    }
    else if(typeof args[i] === 'object') {
      arr.push('[object]');
    }
    if(typeof args[i] === 'function') {
      arr.push('[function]');
    }
  }

  return arr;
};
