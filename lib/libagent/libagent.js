/*
Copyright (c) AppDynamics, Inc., and its affiliates
2015
All Rights Reserved
 */

'use strict';
var Metric = require('./metrics/metric').Metric;
var LibagentTransactionReporter = require('./transactions/transaction-reporter').TransactionReporter;
var cluster = require('cluster');
var fs = require('fs');
var os = require('os');

function LibAgent(agent) {
  this.agent = agent;
  this.transactionReporter = new LibagentTransactionReporter(this);
  var self = this;
  this.agent.on('nodeIndexComputed', function() {
    self.agent.libagentConnector.init();
  });
  this.nodeIndexComputed = false;
  // For unit-testing
  this.libagent = true;
  agent.Metric = Metric;
}

exports.LibAgent = LibAgent;

LibAgent.prototype.init = function() {
  this.transactionReporter.init();
};

LibAgent.prototype.addNodeIndexToNodeName = function() {
  var self = this;
  self.indexDir = self.agent.tmpDir + '/index';
  // disable waiting for BT info response
  self.agent.opts.btEntryPointDelayDisabled = true;
  // emit start agent event along with node index
  self.identifyNodeIndex(function(err, nodeIndex) {
    if (err) {
      self.agent.logger.error(err);
      return;
    }

    process.nextTick(function() {
      if (cluster.isMaster && !self.agent.opts.monitorClusterMaster) {
        // trying to identify cluster master
        var isClusterMaster = false;
        if (cluster.workers) {
          if ((Object.keys(cluster.workers)).length > 0)
            isClusterMaster = true;
        }

        if(isClusterMaster) {
          // do not monitor cluster master node
          return;
        }
      }
      // create or update node name
      var computedNodeName = (self.agent.opts.nodeName || os.hostname());
      if (!self.agent.opts.noNodeNameSuffix) {
        computedNodeName += '-' + nodeIndex;
      }
      self.agent.opts.nodeName = computedNodeName;
      self.nodeIndexComputed = true;
      self.agent.emit('nodeIndexComputed');
    });
  });
};

LibAgent.prototype.identifyNodeIndex = function(callback) {
  var self = this;

  if (cluster.isMaster) {
    var nodeIndex = self.agent.opts.nodeIndex || 0;
    callback(null, nodeIndex);
  }
  else if ('pm_id' in process.env && !isNaN(process.env.pm_id)) {
    callback(null, Number(process.env.pm_id));
  }
  else {
    self.agent.timers.setTimeout(function() {
      self.readNodeIndex(function(nodeIndex) {
        if (nodeIndex !== null) {
          callback(null, nodeIndex);
        }
        else {
          self.agent.timers.setTimeout(function() {
            self.readNodeIndex(function(nodeIndex) {
              if (nodeIndex !== null) {
                callback(null, nodeIndex);
              }
              else {
                // return pid instead of index if indexing is not available,
                // e.g. this process is forked from a worker
                callback(null, process.pid);
              }
            });
          }, 4000);
        }
      });
    }, 1000);
  }
};

/* istanbul ignore next */
LibAgent.prototype.readNodeIndex = function(callback) {
  var self = this;

  var callbackCalled = false;
  function callbackOnce(ret) {
    if(!callbackCalled) {
      callbackCalled = true;
      callback(ret);
    }
  }

  fs.exists(self.indexDir, function(exists) {
    if (!exists) return;

    fs.readdir(self.indexDir, function(err, indexFiles) {
      if (err) return self.agent.logger.error(err);

      indexFiles.forEach(function(indexFile) {
        var nodeIndex = parseInt(indexFile.split('.')[0]);
        if (!isNaN(nodeIndex)) {
          fs.readFile(self.indexDir + '/' + indexFile, function(err, pid) {
            if (err) return self.agent.logger.error(err);

            if (pid == process.pid) {
              callbackOnce(nodeIndex);
            }
          });
        }
      });
    });
  });

  self.agent.timers.setTimeout(function() {
    callbackOnce(null);
  }, 2000);
};

LibAgent.prototype.initializeLogger = function() {
  var self = this;
  self.agent.logger.setLibAgentConnector(self.agent.libagentConnector);
  self.agent.logger.init(self.agent.opts.logging, false);
};

LibAgent.prototype.createCLRDirectories = function() {
  // This function is not needed for libagent.
  // It is added only to match the libproxy ProxyCustom object.
};

LibAgent.prototype.intializeAgentHelpers = function() {
  this.agent.transactionSender.init();
  this.agent.processSnapshotSender.init();
  this.agent.metricSender.init();
  this.agent.instanceInfoSender.init();
};

LibAgent.prototype.startAgent = function(metadata, filters) {
  var self = this;
  if (self.nodeIndexComputed) {
    self.agent.emit('agentStarted', metadata, filters);
  } else {
    // Wait for the nodeAgent to be initialized
    self.agent.on('nodeIndexComputed', function() {
      self.agent.emit('agentStarted', metadata, filters);
    });
  }
};

LibAgent.prototype.createExitCall = function(time, exitCallInfo) {
  var self = this;
  var exitType = exitCallInfo.exitType.replace(/^EXIT_/, '');
  var exitCallObj = {
    threadId: time.threadId,
    exitPointType: exitType,
    exitPointSubType: exitCallInfo.exitSubType,
    backendName: exitCallInfo.backendName,
    category: exitCallInfo.category || '',
    command: exitCallInfo.command || '',
    properties: exitCallInfo.supportedProperties,
    useBackendConfig: exitCallInfo.useBackendConfig
  };

  var transaction = self.agent.profiler.transactions[exitCallObj.threadId];
  if (transaction && !transaction.skip) {
    if (transaction.api && transaction.api.beforeExitCall) {
      exitCallObj = transaction.api.beforeExitCall(exitCallObj);
      if (!exitCallObj) {
        return;
      }
    }

    self.agent.emit('exitCallStarted', transaction, exitCallObj);
    if (!transaction.startedExitCalls) {
      transaction.startedExitCalls = [];
    }
    if (exitCallObj.exitCallGuid !== undefined) {
      transaction.startedExitCalls.push(exitCallObj);
    }
  }
  return exitCallObj;
};

LibAgent.prototype.stopExitCall = function(exitCall, error) {
  var self = this;

  var transaction = self.agent.profiler.transactions[exitCall.threadId];

  if (transaction) {
    self.agent.emit('exitCallStopped', transaction, exitCall, error);
  }
};

LibAgent.prototype.createSnapshotTrigger = function() {
  return {
    attachSnapshot: true,
    snapshotTrigger: 'REQUIRED' // FIXME: override this within NodeAgent
  };
};

LibAgent.prototype.getCorrelationHeader = function(exitCall) {
  if ('correlationHeader' in exitCall) {
    return exitCall.correlationHeader;
  }
};

LibAgent.prototype.startProcessSnapshot = function() {
  var self = this;
  self.agent.libagentConnector.startProcessSnapshot();
};
