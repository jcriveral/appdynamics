/*
Copyright (c) AppDynamics, Inc., and its affiliates
2015
All Rights Reserved
 */
'use strict';

function TimePromise(agent, transactionInfo) {
  this.agent = agent;

  this.info = transactionInfo;
  this.stackTrace = undefined;
  this.time = undefined;

  // optional callbacks:
  this.beforeExitCall = null;
  this.exitCallCompleted = null;
  this.onSnapshotCaptured = null;
  this.onResponseComplete = null;
}

exports.TimePromise = TimePromise;

TimePromise.fromRequest = function (agent, req, txn) {
  if (txn.api)
    return txn.api;

  var tp = new TimePromise(agent, req),
    profiler = agent.profiler;

  tp.time = txn.time;
  tp.stackTrace = profiler.stackTrace();
  tp.transaction = txn;
  txn.api = tp;

  return tp;
};

TimePromise.prototype.start = function () {
  if (!this.info)
    return;
  var self = this;
  var profiler = self.agent.profiler;

  self.time = profiler.time(true);
  self.stackTrace = profiler.stackTrace();
  self.transaction = profiler.startTransaction(
    self.time, self.info, 'NODEJS_API');
  self.transaction.api = this;
};

TimePromise.prototype.resume = function () {
  if (!this.time) {
    throw new Error('transaction not started');
  }
  this.agent.thread.resume(this.time.threadId);
  this.transaction.touched = this.agent.system.millis();
};

TimePromise.prototype.markError = function (err, statusCode) {
  this.transaction.error = err;
  this.transaction.stackTrace = this.agent.profiler.formatStackTrace(err);
  this.transaction.statusCode = statusCode !== undefined ? statusCode :
    err.statusCode !== undefined ? err.statusCode :
      500;
};

TimePromise.prototype.end = function (err, statusCode) {
  var self = this;
  var profiler = self.agent.profiler;

  if (!self.time.done()) return;

  if (err) this.markError(err, statusCode);

  profiler.endTransaction(self.time, self.transaction, self.info);
};

TimePromise.prototype.startExitCall = function (exitCallInfo) {
  var self = this;

  var profiler = self.agent.profiler;
  var callback = self.beforeExitCall;
  var time = profiler.time();

  try {
    self.beforeExitCall = null; // bypass callback for explicit create

    // libagent support
    exitCallInfo.supportedProperties = exitCallInfo.identifyingProperties;
    exitCallInfo.useBackendConfig = false;
    // end libagent support

    var ec = profiler.createExitCall(time, exitCallInfo);
    return ec;
  } finally {
    self.beforeExitCall = callback; // restore any callback
  }
};

TimePromise.prototype.endExitCall = function (exitCall, error) {
  var self = this;

  var time = exitCall.time;
  if (time && !time.done()) return;

  self.agent.profiler.addExitCall(exitCall.time, exitCall, error);
};

TimePromise.prototype.createCorrelationInfo = function (exitCall, doNotResolve) {
  var self = this;
  if (self.agent.backendConnector.libagent && doNotResolve) {
    self.agent.libagentConnector.disableResolutionForExitCall(exitCall);
    exitCall.correlationHeader = self.agent.libagentConnector.getCorrelationHeader(exitCall);
  }
  if (exitCall.correlationHeader) {
    return exitCall.correlationHeader;
  }
  var header = self.agent.correlation.newCorrelationHeader();
  header.build(self.transaction, exitCall, !!doNotResolve, true);
  return header.getStringHeader();
};

TimePromise.prototype.addSnapshotData = function (key, value) {
  this.snapshotData = this.snapshotData || [];
  this.snapshotData.push({ name: key, value: value });
};

TimePromise.prototype.addAnalyticsData = function (key, value) {
  this.analyticsData = this.analyticsData || [];
  /* The bindings layer will corretly preverse the type information on primitive types
   * (bool, int, double, string), but complex types must be converted to their
   * appropriate native representation otherwise the bindings layer will stringify
   * the object through its toString method
   */
  if (value instanceof Date) {
    this.analyticsData.push({ name: key, value: value.toISOString() });
  } else {
    this.analyticsData.push({ name: key, value: value });
  }
};
