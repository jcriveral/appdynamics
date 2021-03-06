/*

TODO:
report errors similar to exit calls
data collectors
eum
*/

/* eslint-disable no-console */

var util = require('util');
var EventEmitter = require('events').EventEmitter;
var ProtobufModel = require('../proxy/protobuf-model').ProtobufModel;
var ExceptionHandlers = require('../core/exception-handlers.js').ExceptionHandlers;
var MessageSender = require('./message-sender').MessageSender;
var Constants = require('./libagent-constants.js');

function toTimeRollup(str) {
  if (str === 'AVG') {
    return Constants.TIME_ROLLUP_AVERAGE;
  }
  else if (str === 'SUM') {
    return Constants.TIME_ROLLUP_SUM;
  }
  else if (str === 'SET') {
    return Constants.TIME_ROLLUP_CURRENT;
  }
  return str;
}

function toClusterRollup(str) {
  if (str === 'INDIVIDUAL') {
    return Constants.CLUSTER_ROLLUP_INDIVIDUAL;
  }
  else if (str === 'COLLECTIVE') {
    return Constants.CLUSTER_ROLLUP_COLLECTIVE;
  }
  return str;
}

function toHoleHandling(str) {
  if (str === 'RATECOUNTER') {
    return Constants.HOLE_HANDLING_RATE_COUNTER;
  }
  else if (str === 'REGULARCOUNTER') {
    return Constants.HOLE_HANDLING_REGULAR_COUNTER;
  }
  return str;
}

function toAggregator(str) {
  if (str === 'AVG') {
    return Constants.AGGREGATOR_AVERAGE;
  }
  else if (str === 'ADVANCED_AVG') {
    return Constants.AGGREGATOR_ADVANCED_AVERAGE;
  }
  else if (str === 'SUM') {
    return Constants.AGGREGATOR_SUM;
  }
  return str;
}

function LibagentConnector(agent) {
  this.agent = agent;
  this.libagent = undefined;
  this.exceptionHandlers = undefined;
  this.isEnabled = false;
  this.minuteTimerId = undefined;
  this.updateConfigTimerId = undefined;
  this.registerMetricsTimerId = undefined;
  this.rollupAndSendMetricsTimerId = undefined;
  this.processAndSendEventDataTimerId = undefined;
  this.registerObjectsTimerId = undefined;
  this.updatePeriodicSnapshotTimersTimerId = undefined;
  this.reportOverflowsTimerId = undefined;
  this.processAndSendSnapshotsTimerId = undefined;
  this.processAndSendTopSummaryStatsTimerId = undefined;
  this.sendAnalyticsDataTimerId = undefined;
  this.aggregateRuntimeStatisticsTimerId = undefined;
  this.summaryStatsTimerId = undefined;
  this.snapshotTimerId = undefined;
  this.initializationTimerId = undefined;
  this.logUploadTimerId = undefined;
  this.manualProcessSnapshotInProgress = undefined;
  this.instanceTrackingTimerId = undefined;
  this.timersInitialized = false;
  EventEmitter.call(this);
}
util.inherits(LibagentConnector, EventEmitter);
exports.LibagentConnector = LibagentConnector;

LibagentConnector.prototype.initLogger = function() {
  var self = this;
  var AppdynamicsLibAgent = require('appdynamics-libagent-napi');
  var LibAgent = AppdynamicsLibAgent.LibAgent;
  self.libagent = new LibAgent(self.agent);
};

LibagentConnector.prototype.init = function() {
  var self = this;

  // override libagent-specific definitions in core agent
  self.overrideFunctionDefinitions(self.agent);
  // initialize protobuf
  self.protobufModel = new ProtobufModel(self.agent);
  self.protobufModel.init();

  self.manualProcessSnapshotInProgress = false;

  self.libagent.init(self.agent);
  self.exceptionHandlers = new ExceptionHandlers();
  self.exceptionHandlers.init(
    self.agent,
    function() {
      if (self.agent.opts.reuseNode)
        self.libagent.shutDown();
    },
    function() {
      // exception handler: libagent needs no teardown
    });
  self.libagent.delegate.on('initialConfigUpdateDone', function() {
    self.isEnabled = true; // should be API call
    self.initializeTimers();
  });
  self.libagent.delegate.on('agentDisabled', function() {
    self.isEnabled = false;
  });
  self.libagent.delegate.on('agentReset', function() {
    self.agent.metricsManager.init();
    self.agent.processStats.init();
    self.agent.gcStats.init();
  });

  self.agent.on('agentStarted', function(meta, filters) {
    self.libagent.start(meta, filters);
    self.updateConfigTimerId = new MessageSender(self.agent, 30, 60 * 1000, function() {
      self.libagent.updateConfig();
    });
    self.setupEum(self.agent);
    self.emit("connected");

    self.agent.transactionSender.isEnabled = true;
  });
  self.libagent.delegate.on('transactionDropped', function(guid) {
    var profiler = self.agent.profiler;
    profiler.transactionDropped(guid);
  });
};

LibagentConnector.prototype.startBusinessTransaction = function(entryPointType, optionalName, corrHeader, callback, isHttpRequest) {
  var self = this;
  return self.libagent.startBusinessTransaction(entryPointType, optionalName, corrHeader, callback, isHttpRequest);
};

LibagentConnector.prototype.stopBusinessTransaction = function(transaction) {
  var self = this;

  if (transaction.error) {
    var name = self.protobufModel.extractErrorName(transaction.error);
    if (!name) {
      name = "";
    }
    var message = self.protobufModel.extractErrorMessage(transaction.error);
    if (!message) {
      message = "";
    }

    var stackTraceData = null;
    if (transaction.error.stack) {
      stackTraceData = self.protobufModel.constructStackTrace(transaction.error.stack);
    }

    self.libagent.addErrorToTransaction(transaction.btGuid, name, message, transaction.statusCode, stackTraceData);
  }

  var btId = self.libagent.getBusinessTransactionId(transaction.btGuid);
  if (btId > 0) {
    self.agent.emit('updateCallContextMap', transaction, btId);
  }
  var psGuids = transaction.processSnapshots;
  if (psGuids) {
    for (var key in psGuids) {
      self.libagent.addProcessSnapshotGuid(transaction.btGuid, key);
    }
  }

  if (transaction.api && transaction.api.analyticsData) {
    var userData = transaction.api.analyticsData;
    self.libagent.addAnalyticsUserData(transaction.btGuid, userData);
  }

  self.libagent.stopBusinessTransaction(transaction.btGuid);
};


LibagentConnector.prototype.startExitCall = function(transaction, exitCall) {
  var self = this;

  var propertiesArray = [];
  for(var propName in exitCall.properties) {
    propertiesArray.push({
      property: propName,
      value: exitCall.properties[propName]
    });
  }

  var backendName = "";
  if (exitCall.backendName) {
    backendName = exitCall.backendName;
  }

  var category = "";
  if (exitCall.category) {
    category = exitCall.category;
  }

  var command = "";
  if (exitCall.command) {
    command = exitCall.command;
  }

  var useBackendConfig = true;
  if (exitCall.useBackendConfig !== undefined) {
    useBackendConfig = exitCall.useBackendConfig;
  }

  exitCall.exitCallGuid = self.libagent.startExitCall(
    transaction.btGuid,
    exitCall.exitPointType,
    exitCall.exitPointSubType,
    backendName,
    category,
    command,
    propertiesArray,
    useBackendConfig);
  if (exitCall.exitCallGuid !== undefined) {
    exitCall.correlationHeader = self.libagent.getCorrelationHeader(exitCall.exitCallGuid);
  }
};

LibagentConnector.prototype.disableResolutionForExitCall = function(exitCall) {
  var self = this;

  if (exitCall.exitCallGuid !== undefined) {
    self.libagent.disableResolutionForExitCall(exitCall.exitCallGuid);
  }
};

LibagentConnector.prototype.getCorrelationHeader = function(exitCall) {
  var self = this;

  if (exitCall.exitCallGuid !== undefined) {
    return self.libagent.getCorrelationHeader(exitCall.exitCallGuid);
  }
};

LibagentConnector.prototype.stopExitCall = function(exitCall, error) {
  var self = this;

  if (exitCall.exitCallGuid == undefined) {
    return;
  }

  if (error) {
    var errorMessage = self.protobufModel.extractErrorMessage(error);

    if (error && error.stack) {
      var stackTraceData = self.protobufModel.constructStackTrace(error.stack);
      if (exitCall.exitPointType === 'HTTP') {
        self.libagent.addErrorWithStackTraceToExitCall(exitCall.exitCallGuid, errorMessage,
                                                       stackTraceData, exitCall.statusCode);
      } else {
        self.libagent.addErrorWithStackTraceToExitCall(exitCall.exitCallGuid, errorMessage,
                                                       stackTraceData);
      }
    } else {
      if (exitCall.exitPointType === 'HTTP') {
        self.libagent.addHttpErrorToExitCall(exitCall.exitCallGuid, errorMessage,
                                             errorMessage, exitCall.statusCode);
      } else {
        self.libagent.addErrorToExitCall(exitCall.exitCallGuid, errorMessage,
                                         errorMessage);
      }
    }
  }

  self.libagent.stopExitCall(exitCall.exitCallGuid);
};

LibagentConnector.prototype.updateInstanceTracking = function() {
  var config = this.libagent.getInstanceTrackingConfig();
  this.emit("instanceTrackerConfig", config);
};

LibagentConnector.prototype.sendInstanceTrackerInfo = function(instanceCounts) {
  this.libagent.addInstanceData(instanceCounts);
};

LibagentConnector.prototype.isSnapshotRequired = function(transaction) {
  var self = this;
  return self.libagent.isSnapshotRequired(transaction.btGuid);
};

LibagentConnector.prototype.sendTransactionSnapshot = function(transaction, transactionSnapshot) {
  var self = this;

  // fixup exit calls: set all required fields so that the protobuf message remains valid
  if (transactionSnapshot.snapshot.exitCalls) {
    transactionSnapshot.snapshot.exitCalls.forEach(function (item) {
      if (!item.backendIdentifier) {
        item.backendIdentifier = { type: "UNREGISTERED" };
      }
      if (!item.timeTaken) {
        item.timeTaken = 0;
      }
      if (!item.sequenceInfo) {
        item.sequenceInfo = '';
      }
      if (!item.count) {
        item.count = 1;
      }
    });
  }

  var snapshotData = {};
  if (transaction.api && transaction.api.snapshotData) {
    snapshotData.userData = transaction.api.snapshotData;
  }
  self.libagent.addTransactionSnapshot(transaction.btGuid, transactionSnapshot.snapshot, snapshotData);
};

LibagentConnector.prototype.startProcessSnapshot = function() {
  var self = this;
  self.libagent.startProcessSnapshot();
};

LibagentConnector.prototype.sendProcessSnapshot = function(processSnapshot) {
  var self = this;
  self.libagent.addProcessSnapshot(processSnapshot);
};

LibagentConnector.prototype.addMetric = function(name, aggregator, timeRollup) {
  var self = this;
  // All agent-defined metrics use these cluster rollup and hole handling types.
  return self.libagent.addMetric(name, toAggregator(aggregator), toTimeRollup(timeRollup),
                                 Constants.CLUSTER_ROLLUP_INDIVIDUAL,
                                 Constants.HOLE_HANDLING_REGULAR_COUNTER);
};

LibagentConnector.prototype.addCustomMetric = function(name, aggregator, timeRollup, clusterRollup, holeHandling) {
  var self = this;
  return self.libagent.addCustomMetric(name, toAggregator(aggregator), toTimeRollup(timeRollup),
                                       toClusterRollup(clusterRollup), toHoleHandling(holeHandling));
};

LibagentConnector.prototype.reportMetric = function(metricId, value) {
  var self = this;
  return self.libagent.reportMetric(metricId, value);
};

LibagentConnector.prototype.logFatal = function(message) {
  var self = this;
  self.libagent ? self.libagent.logFatal(message) : console.error(message);
};

LibagentConnector.prototype.logError = function(message) {
  var self = this;
  self.libagent ? self.libagent.logError(message) : console.error(message);
};

LibagentConnector.prototype.logWarn = function(message) {
  var self = this;
  self.libagent ? self.libagent.logWarn(message) : console.warn(message);
};

LibagentConnector.prototype.logInfo = function(message) {
  var self = this;
  self.libagent ? self.libagent.logInfo(message) : console.info(message);
};

LibagentConnector.prototype.logDebug = function(message) {
  var self = this;
  self.libagent ? self.libagent.logDebug(message) : console.debug(message);
};

LibagentConnector.prototype.logTrace = function(message) {
  var self = this;
  self.libagent ? self.libagent.logTrace(message) : console.debug(message);
};

LibagentConnector.prototype.logEnv = function(message) {
  var self = this;
  self.libagent.logEnv(message);
};

LibagentConnector.prototype.getBusinessTransactionId = function (txnGuid) {
  var self = this;
  return self.libagent.getBusinessTransactionId(txnGuid);
};

LibagentConnector.prototype.setHttpParamsInTransactionSnapshot = function (transaction) {
  var self = this;
  // url, methis and statusCode should be present for all http requests
  if (transaction.url && transaction.method && transaction.statusCode) {
    return self.libagent.setHttpParamsInTransactionSnapshot(
        transaction.btGuid, transaction.url, transaction.method, transaction.statusCode);
  }
};

LibagentConnector.prototype.addHttpDataToTransactionSnapshot = function (transaction, request) {
  var self = this;
  return self.libagent.addHttpDataToTransactionSnapshot(transaction.btGuid, request);
};

LibagentConnector.prototype.setSnapshotRequired = function (transaction) {
  var self = this;
  self.libagent.setSnapshotRequired(transaction.btGuid);
};

LibagentConnector.prototype.addEvent = function(severity, type, summary, details) {
  var self = this;

  return self.libagent.addEvent(severity, type, summary, details);
};

LibagentConnector.prototype.handleProcessSnapshotRequest = function () {
  var self = this;

  if (self.manualProcessSnapshotInProgress)
    return;

  var req = self.libagent.getUserProcessSnapshotRequest();
  if (req && req.snapshotRequestID) {
    self.agent.logger.info('process snapshot request', req.snapshotRequestID, 'for duration', req.captureTime);
    self.manualProcessSnapshotInProgress = true;
    self.agent.processScanner.startManualSnapshot(req, function(err, processSnapshot) {
      self.manualProcessSnapshotInProgress = false;
      if (err) {
        self.agent.logger.error(err);
        return;
      }
      self.sendProcessSnapshot(processSnapshot);
    });
  }
};

LibagentConnector.prototype.initializeTimers = function() {
  var self = this;

  if (self.timersInitialized) {
    return;
  }
  self.timersInitialized = true;

  self.registerMetricsTimerId = new MessageSender(self.agent, 10 * 1000, 60 * 1000, function() {
    self.libagent.registerMetrics();
  });

  var metricDataReqInitialDelay = self.libagent.getInitialMetricDataRequestDelay();
  self.rollupAndSendMetricsTimerId = new MessageSender(self.agent, metricDataReqInitialDelay, 60 * 1000, function() {
    self.libagent.rollupAndSendMetrics();
  });

  self.processAndSendEventDataTimerId = new MessageSender(self.agent, 60 * 1000, 60 * 1000, function() {
    self.libagent.processAndSendEventData();
  });

  self.registerObjectsTimerId = new MessageSender(self.agent, 5 * 1000, 10 * 1000, function() {
    self.libagent.registerObjects();
  });

  self.updatePeriodicSnapshotTimersTimerId = new MessageSender(self.agent, 0, 60 * 1000, function() {
    self.libagent.updatePeriodicSnapshotTimers();
  });

  self.reportOverflowsTimerId = new MessageSender(self.agent, 60 * 1000, 60 * 1000, function() {
    self.libagent.reportOverflows();
  });

  self.processAndSendSnapshotsTimerId = new MessageSender(self.agent, 0, 5 * 1000, function() {
    self.libagent.processAndSendSnapshots();
  });

  self.processAndSendTopSummaryStatsTimerId = new MessageSender(self.agent, 0, 5 * 60 * 1000, function() {
    self.libagent.processAndSendTopSummaryStats();
  });

  self.sendAnalyticsDataTimerId = new MessageSender(self.agent, 30 * 1000, 30 * 1000, function() {
    self.libagent.sendAnalyticsData();
  });

  self.aggregateRuntimeStatisticsTimerId = new MessageSender(self.agent, 60 * 1000, 60 * 1000, function() {
    self.libagent.aggregateRuntimeStatistics();
  });

  self.processMetricTimer = new MessageSender(self.agent, 0, 60 * 1000, function() {
    self.agent.metricsManager.getProcessMetrics();
  });

  self.userProcessSnapshotTimerId = new MessageSender(self.agent, 0, 60 * 1000, function() {
    self.handleProcessSnapshotRequest();
  });

  self.logUploadTimerId = new MessageSender(self.agent, 0, 60 * 1000, function() {
    self.libagent.uploadLogfiles();
  });

  self.btPurgeTimerId = new MessageSender(self.agent, 10 * 1000, 5 * 1000, function() {
    self.libagent.btPurgeChecker();
  });

  self.instanceTrackingTimerId = new MessageSender(self.agent, 0, 60 * 1000, function() {
    self.updateInstanceTracking();
  });

  self.logDebug("Initialized libagent timers");
};

LibagentConnector.prototype.getEumCookieFields = function(transaction, shortForm) {
  var self = this;
  if (!transaction.ignore)
    return self.libagent.getEumCookieFields(transaction.btGuid, shortForm);
  else
    return {};
};

LibagentConnector.prototype.overrideFunctionDefinitions = function(agent) {
  agent.parseCorrelationInfo = function(source) {
    var self = agent;
    if (typeof(source) === 'object') {
      source = source.headers && source.headers[self.correlation.HEADER_NAME];
    }
    return {
      businessTransactionName: 'NodeJS API Business Transaction',
      headers: {
        'singularityheader': source
      }
    };
  };

  agent.profiler.addExitCall = function(time, exitCall, error) {
    var self = agent.profiler;
    exitCall.error = error;
    var transaction = self.transactions[exitCall.threadId];
    agent.backendConnector.stopExitCall(exitCall, error);
    self.tryEndingTransactionAfterExitCall(transaction, exitCall, time);
  };

  agent.eum.init = function() {
    var self = agent.eum;
    self.registerEumCookieType();
  };

  agent.eum.enabledForTransaction = function(transaction) {
    return !transaction.skip && transaction.eumEnabled;
  };

  /* always pass url property for libagent */
  agent.backendConfig.isParsedUrlRequired = function() {
    return true;
  };

};

LibagentConnector.prototype.setupEum = function(agent) {
  var libAgentConnector = this;
  agent.eum.eumCookie.prototype.setFieldValues = function() {
    var self = this;
    var shortForm = self.keyForm == 'short';
    var fields = libAgentConnector.getEumCookieFields(self.transaction, shortForm);
    if (fields) {
      for(var key in fields) {
        self.addSubCookie(key, fields[key]);
      }
      self.transaction.eumGuid = fields.g || fields.clientRequestGuid;
      self.guid = self.transaction.eumGuid;
      self.setCookie();
    }
    return true;
  };
};
