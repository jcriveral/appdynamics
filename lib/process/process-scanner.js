/*
Copyright (c) AppDynamics, Inc., and its affiliates
2015
All Rights Reserved
 */
var uuid = require('uuid');

var APPD_INTERNAL_RE = /\/appdynamics\//;

function ProcessScanner(agent) {
  this.agent = agent;
  this.autoSnapshotDurationSeconds = 10;
  this.snapshotCount = 0;
  this.maxSnapshotsPerPeriod = 2;
  this.snapshotCountResetPeriodMS = 1 * 60 * 1000;
  this.snapshotsResetIntervalId = undefined;
  this.currentProcessSnapshot = undefined;
  this.lastProcessRequestId = undefined;
  this.lastSnapshotRequestID = undefined;
  this.btCalls = null;
}

exports.ProcessScanner = ProcessScanner;

ProcessScanner.prototype.init = function () {
  var self = this;

  self.lastSnapshotRequestID = 0;
  self.agent.timers.setInterval(function() {
    self.lastSnapshotRequestID = 0;
  }, 300000);

  var snapshotsPerPeriod =
    self.agent.opts.maxProcessSnapshotsPerPeriod;

  if (snapshotsPerPeriod !== undefined) {
    snapshotsPerPeriod = +snapshotsPerPeriod;
    if (snapshotsPerPeriod >= 0) {
      self.maxSnapshotsPerPeriod = snapshotsPerPeriod;
    }
  }

  self.agent.logger.info("ProcessScanner - maxSnapshotsPerPeriod: " + self.maxSnapshotsPerPeriod);

  var resetPeriod = +(self.agent.opts.processSnapshotCountResetPeriodSeconds);
  if (resetPeriod && (resetPeriod > 0)) {
    self.snapshotCountResetPeriodMS = (+resetPeriod) * 1000;
  }
  self.agent.logger.info("ProcessScanner - snapshotCountResetPeriodMS: " + self.snapshotCountResetPeriodMS);

  var snapshotDuration = +(self.agent.opts.autoSnapshotDurationSeconds);
  if (snapshotDuration && (snapshotDuration > 0) && (snapshotDuration < 300)) {
    self.autoSnapshotDurationSeconds = snapshotDuration;
  }
  self.agent.logger.info("ProcessScanner - autoSnapshotDurationSeconds: " + self.autoSnapshotDurationSeconds);

  self.agent.on('transactionStarted', function(transaction) {
    if (!self.capturingProcessSnapshot) return;
    var threadId = transaction.threadId;
    var btCallInfo = self.btCalls[threadId] || (self.btCalls[threadId] = {});
    btCallInfo.startTime = self.agent.system.hrtime();
    btCallInfo.registrationId = transaction.registrationId;
    transaction.addProcessSnapshotGUID(self.currentProcessSnapshot.guid);
  });

  self.agent.on('transaction', function(transaction) {
    if (!self.capturingProcessSnapshot) return;

    transaction.addProcessSnapshotGUID(self.currentProcessSnapshot.guid);
    var threadId = transaction.threadId;
    var btCallInfo = self.btCalls[threadId] || (self.btCalls[threadId] = { startTime: undefined });
    btCallInfo.registrationId = btCallInfo.registrationId || transaction.registrationId;
    btCallInfo.endTime = self.agent.system.hrtime();
  });
};

Object.defineProperty(ProcessScanner.prototype, 'capturingProcessSnapshot', {
  get: function(){
    return !!this.currentProcessSnapshot;
  }
});

function ensureInterval(self) {
  if (self.snapshotsResetIntervalId)
    return;
  self.snapshotsResetIntervalId = self.agent.timers.setInterval(function () {
    self.snapshotCount = 0;
  }, self.snapshotCountResetPeriodMS);
}

ProcessScanner.prototype.doErrorCallback = function(msg, callback)
{
  if (!callback) {
    return;
  }

  var err = new Error(msg);
  process.nextTick(function() { callback(err, null); });
};

ProcessScanner.prototype.startAutoSnapshotIfPossible = function (callback) {
  var self = this, msg;

  if (self.capturingProcessSnapshot) {
    msg = 'Process snapshot already in progress, not starting another one!';
    self.agent.logger.info(msg);
    self.doErrorCallback(msg, callback);
    return;
  }

  if (self.snapshotCount >= self.maxSnapshotsPerPeriod) {
    msg = 'Already did '
        + self.snapshotCount
        + ' process snapshots in '
        + self.snapshotCountResetPeriodMS
        + 'ms.';
    self.agent.logger.info(msg);
    self.doErrorCallback(msg, callback);
    return;
  }

  self.startSnapshot(true, self.autoSnapshotDurationSeconds, -1, callback);
};

ProcessScanner.prototype.startManualSnapshot = function(processCallGraphReq, callback) {
  var self = this, requestID, msg;

  requestID = +processCallGraphReq.snapshotRequestID;
  if(requestID <= self.lastSnapshotRequestID) {
    msg = 'snapshotRequestID '
            + processCallGraphReq.snapshotRequestID
            + ' was already processed, ignoring.';
    self.agent.logger.info(msg);
    self.doErrorCallback(msg, callback);
    return;
  }

  self.lastSnapshotRequestID = requestID;

  if (self.capturingProcessSnapshot) {
    msg = 'Process snapshot capture already in progress; snapshotRequestID '
            + processCallGraphReq.snapshotRequestID
            + ' ignored.';
    self.agent.logger.info(msg);
    self.doErrorCallback(msg, callback);
    return;
  }

  self.startSnapshot(false, processCallGraphReq.captureTime, requestID, callback);
};

ProcessScanner.prototype.__populatePendingTransactions = function() {
  var self = this;
  var startTime = self.agent.system.hrtime();
  var transactionsMap = self.agent.profiler.transactions;
  self.btCalls = {};
  for(var threadId in transactionsMap) {
    var btCallInfo = self.btCalls[threadId] || ( self.btCalls[threadId] = {} );
    btCallInfo.startTime = startTime;
    btCallInfo.registrationId =
      btCallInfo.registrationId || transactionsMap[threadId].registrationId;
  }
};

ProcessScanner.prototype.__btCallsToProto = function(btCalls) {
  var self = this;
  var result = [];
  var registrationIDToIndex = {};
  var now = self.agent.system.hrtime();
  for (var threadId in btCalls) {
    var btCallInfo = btCalls[threadId];
    if (btCallInfo.startTime === undefined)
      continue;
    if (!btCallInfo.registrationId)
      continue;
    if (btCallInfo.endTime === undefined)
      btCallInfo.endTime = now;

    var index = registrationIDToIndex[btCallInfo.registrationId];
    if (index === undefined) {
      index = result.length;
      registrationIDToIndex[btCallInfo.registrationId] = index;
    }

    var protoBTCallInfo =
      result[index] || ( result[index] = { btID: btCallInfo.registrationId, count: 0, totalTimeTakenMS: 0 } );

    protoBTCallInfo.count++;
    protoBTCallInfo.totalTimeTakenMS +=
    Math.max(0, (btCallInfo.endTime - btCallInfo.startTime) / 1000.0);
  }
  return result;
};

ProcessScanner.prototype.startSnapshot = function (auto,
                                                   durationSeconds,
                                                   requestID,
                                                   callback) {
  var self = this, msg;

  if(process.version.match(/^v0\.12\.[1234]$/) && !self.agent.opts.ignoreV8SamplerBug) {
    msg = "CPU profiling is not supported in Node.js v0.12.x due to V8 bug.";
    self.doErrorCallback(msg, callback);
    return;
  }

  if (self.capturingProcessSnapshot) {
    msg = "Process snapshot already started, not starting another.";
    self.doErrorCallback(msg, callback);
    return;
  }

  self.agent.backendConnector.startProcessSnapshot();

  self.currentProcessSnapshot = {
    snapshotRequestID: requestID,
    guid: uuid.v4(),
    timestamp: undefined,
    processCallGraph: undefined,
    processAllocationGraph: undefined,
    processID: process.pid,
    btCalls: undefined
  };

  self.__populatePendingTransactions();
  self.snapshotCount++;
  ensureInterval(self);

  self.agent.proxy.enableCallContext();

  if (self.agent.nsolidEnabled && self.agent.asyncActivity) {
    self.agent.asyncActivity(function(err, activity) {
      if (err) {
        self.logger.warn("Unable to fetch N|Solid metadata: " + err);
      }
      activity = activity.filter(function(entry) {
        return !APPD_INTERNAL_RE.exec(entry.location.file);
      });
      self.currentProcessSnapshot.asyncActivity = JSON.stringify(activity);
      collect();
    });
  } else {
    process.nextTick(collect);
  }

  function collect() {
    try {
      var threadId = self.agent.thread.nextId - 1;
      self.agent.cpuProfiler.startCpuProfiler(durationSeconds, function(err, processCallGraph) {
        try {
          if(err) {
            callback(err, null);
            return;
          }

          var btCalls = self.__btCallsToProto(self.btCalls);

          var processSnapshot = self.currentProcessSnapshot;
          processSnapshot.timestamp = Date.now();
          processSnapshot.processCallGraph = processCallGraph;
          processSnapshot.btCalls = btCalls;

          self.lastSnapshotRequestID = requestID;

          self.postProcessCallGraph(processSnapshot, self.agent.proxy.getCallContextMap(), durationSeconds);

          callback(null, processSnapshot);
        } finally {
          self.btCalls = null;
          self.currentProcessSnapshot = undefined;
          self.agent.proxy.disableCallContext();
        }
      }, threadId);

      if(!auto) {
        try {
          if(self.agent.heapProfiler.isObjectTrackingSupported()) {
            self.agent.logger.info("ProcessScanner - Starting heap allocation tracking...");

            self.agent.heapProfiler.trackAllocations(durationSeconds - 1, function(err, processAllocationGraph) {
              if(err) {
                return callback(err, null);
              }

              if(self.currentProcessSnapshot) {
                self.currentProcessSnapshot.processAllocationGraph = processAllocationGraph;
                self.postProcessAllocationGraph(self.currentProcessSnapshot, self.agent.proxy.getCallContextMap());
              }
            });
          }
          else {
            self.agent.logger.warn("ProcessScanner - Heap allocation tracking is not supported.");
          }
        }
        catch(err) {
          self.agent.logger.warn("ProcessScanner - Heap allocation tracking failed.");
          self.agent.logger.warn(err);
        }
      }

      self.agent.profiler.processSnapshotStarted(self.currentProcessSnapshot);
    }
    catch(err) {
      self.btCalls = null;
      self.currentProcessSnapshot = undefined;
      self.agent.proxy.disableCallContext();
      callback(err, null);
      return;
    }
  }
};

ProcessScanner.prototype.convertListToTree = function(elements) {
  var nodeQueue = [];
  var rootNode = elements.shift();
  nodeQueue.push(rootNode);

  while(nodeQueue.length > 0) {
    var node = nodeQueue.shift();
    node.children = [];

    for(var i = 0; i < node.numChildren; i++) {
      var childNode = elements.shift();
      node.children.push(childNode);
      nodeQueue.push(childNode);
    }

    delete node.numChildren;
  }

  return rootNode;
};


ProcessScanner.prototype.convertTreeToList = function(rootNode) {
  var elements = [];
  var nodeQueue = [];

  nodeQueue.push(rootNode);

  while(nodeQueue.length > 0) {
    var node = nodeQueue.shift();

    node.children.forEach(function(childNode) {
      nodeQueue.push(childNode);
    });

    node.numChildren = node.children.length;
    delete node.children;
    elements.push(node);
  }

  return elements;
};


ProcessScanner.prototype.calculateCpuTime = function(rootNode) {
  var id = 1;
  var parentNodeMap = {};
  var nodeQueue = [];
  var reverseQueue = [];

  rootNode._id = id++;
  nodeQueue.push(rootNode);

  while(nodeQueue.length > 0) {
    var node = nodeQueue.shift();

    reverseQueue.unshift(node);

    for(var i = node.children.length - 1; i >= 0; i--) {
      node.children[i]._id = id++;

      parentNodeMap[node.children[i]._id] = node;

      nodeQueue.unshift(node.children[i]);
    }
  }

  reverseQueue.forEach(function(node) {
    var parentNode = parentNodeMap[node._id];
    if(parentNode) {
      parentNode.samplesCount += node.samplesCount;
    }
  });

  var samplingRate = 1; //ms
  reverseQueue.forEach(function(node) {
    node.timeTaken = node.samplesCount * samplingRate;
  });

  reverseQueue.forEach(function(node) {
    delete node._id;
    delete node.samplesCount;
  });
};


ProcessScanner.prototype.populateCallContext = function(rootNode, callContextMap) {
  var i;
  var nodeQueue = [rootNode];
  var appdCallbackPrefix = /appd_proxy_/;

  while(nodeQueue.length > 0) {
    var node = nodeQueue.shift();

    if(node.method) {
      var callContext = callContextMap[node.method];
      if(callContext) {
        node.btId = callContext.btId;
        if(callContext.snapshotGuid) {
          node.snapshotGuid = callContext.snapshotGuid;
        }
      }
    }

    if(appdCallbackPrefix.exec(node.method)) {
      // don't need thread specific nodes anymore
      node.method = 'appd_proxy_x';
      node.lineNumber = 1;
    }

    for(i = node.children.length - 1; i >= 0; i--) {
      var childNode = node.children[i];

      if(node.btId) {
        childNode.btId = node.btId;
      }

      if(node.snapshotGuid) {
        childNode.snapshotGuid = node.snapshotGuid;
      }

      nodeQueue.unshift(childNode);
    }
  }
};

ProcessScanner.prototype.addCallBtData = function(firstNode, childNode) {
  var btData;

  if(childNode.btId) {
    if(!firstNode.procCallElemBTData) {
      firstNode.procCallElemBTData = [];
    }
    else {
      firstNode.procCallElemBTData.forEach(function(existingBtData) {
        if(existingBtData.btID === childNode.btId &&
           existingBtData.btSnapGUID === childNode.snapshotGuid) {
          btData = existingBtData;
        }
      });
    }

    if(btData) {
      btData.totalTimeTaken += childNode.timeTaken;
      btData.count++;
    }
    else {
      btData = {
        btID: childNode.btId,
        totalTimeTaken: childNode.timeTaken,
        count: 1
      };

      if(childNode.snapshotGuid) {
        btData.btSnapGUID = childNode.snapshotGuid;
      }

      firstNode.procCallElemBTData.push(btData);
    }

    delete childNode.btId;
    delete childNode.snapshotGuid;
  }
};


ProcessScanner.prototype.addAllocationBtData = function(firstNode, childNode) {
  var btData;

  if(childNode.btId) {
    if(!firstNode.procAllocationElemBTData) {
      firstNode.procAllocationElemBTData = [];
    }
    else {
      firstNode.procAllocationElemBTData.forEach(function(existingBtData) {
        if(existingBtData.btID === childNode.btId &&
           existingBtData.btSnapGUID === childNode.snapshotGuid) {
          btData = existingBtData;
        }
      });
    }

    if(btData) {
      btData.totalSize += childNode.size;
      btData.count += childNode.count;
    }
    else {
      btData = {
        btID: childNode.btId,
        totalSize: childNode.size,
        count: childNode.count
      };

      if(childNode.snapshotGuid) {
        btData.btSnapGUID = childNode.snapshotGuid;
      }

      firstNode.procAllocationElemBTData.push(btData);
    }

    delete childNode.btId;
    delete childNode.snapshotGuid;
  }
};


ProcessScanner.prototype.mergeThreadPaths = function(rootNode, heapMode) {
  var self = this;

  var i;
  var nodeQueue = [];
  nodeQueue.push(rootNode);

  while(nodeQueue.length > 0) {
    var node = nodeQueue.shift();
    var nodeMap = {};

    for(i = node.children.length - 1; i >= 0; i--) {
      var childNode = node.children[i];

      var sig = [
        childNode.klass,
        childNode.method,
        childNode.lineNumber,
        childNode.fileName
      ].join(':');

      var firstNode = nodeMap[sig];
      if(!firstNode) {
        nodeMap[sig] = childNode;

        if(!heapMode) {
          self.addCallBtData(childNode, childNode);
        }
        else {
          self.addAllocationBtData(childNode, childNode);
        }

        nodeQueue.unshift(childNode);
      }
      else {
        node.children.splice(i, 1);

        if(!heapMode) {
          firstNode.timeTaken += childNode.timeTaken;
          self.addCallBtData(firstNode, childNode);
        }
        else {
          firstNode.size += childNode.size;
          firstNode.count += childNode.count;
          self.addAllocationBtData(firstNode, childNode);
        }

        childNode.children.forEach(function(childChildNode) {
          firstNode.children.push(childChildNode);
        });
      }
    }
  }
};


ProcessScanner.prototype.removeIdleNode = function(rootNode) {
  for(var i = 0; i < rootNode.children.length; i++) {
    if(rootNode.children[i].method === '(program)') {
      rootNode.children.splice(i, 1);
      break;
    }
  }
};


ProcessScanner.prototype.removeAgentNodes = function(rootNode) {
  var i;
  var nodeQueue = [];
  nodeQueue.push(rootNode);

  while(nodeQueue.length > 0) {
    var node = nodeQueue.shift();

    var childNodeQueue = node.children;
    node.children = [];

    while(childNodeQueue.length > 0) {
      var childNode = childNodeQueue.shift();

      if(APPD_INTERNAL_RE.exec(childNode.fileName)) {
        for(i = childNode.children.length - 1; i >= 0; i--) {
          childNodeQueue.unshift(childNode.children[i]);
        }
      }
      else {
        node.children.push(childNode);
      }
    }

    for(i = node.children.length - 1; i >= 0; i--) {
      nodeQueue.unshift(node.children[i]);
    }
  }
};


ProcessScanner.prototype.backpropagateCallContext = function(rootNode, heapMode) {
  var procProp;
  if(!heapMode) {
    procProp = 'procCallElemBTData';
  }
  else {
    procProp = 'procAllocationElemBTData';
  }

  function createBtDataUid(btData) {
    var btDataKey = btData.btID;

    if(btData.btSnapGUID) {
      btDataKey += ':' + btData.btSnapGUID;
    }

    return btDataKey;
  }


  function cloneBtData(btData) {
    var btDataCopy = {
      btID: btData.btID,
      count: btData.count,
      totalTimeTaken: btData.totalTimeTaken
    };

    if(!heapMode) {
      btDataCopy.totalTimeTaken = btData.totalTimeTaken;
    }
    else {
      btDataCopy.totalSize = btData.totalSize;
    }

    if(btData.btSnapGUID) {
      btDataCopy.btSnapGUID = btData.btSnapGUID;
    }

    return btDataCopy;
  }


  var i;
  var id = 1;
  var parentNodeMap = {};
  var btDataMap = {};
  var nodeQueue = [];
  var reverseQueue = [];

  rootNode._id = id++;
  nodeQueue.push(rootNode);

  while(nodeQueue.length > 0) {
    var node = nodeQueue.shift();

    reverseQueue.unshift(node);

    if(node[procProp]) {
      node[procProp].forEach(function(btData) {
        btDataMap[node._id + ':' + createBtDataUid(btData)] = btData;
      });
    }

    for(i = node.children.length - 1; i >= 0; i--) {
      var childNode = node.children[i];

      childNode._id = id++;

      parentNodeMap[childNode._id] = node;

      nodeQueue.unshift(childNode);
    }
  }

  reverseQueue.forEach(function(node) {
    var parentNode = parentNodeMap[node._id];

    if(node[procProp] && parentNode) {
      if(!parentNode[procProp]) {
        parentNode[procProp] = [];
      }

      node[procProp].forEach(function(btData) {
        var parentBtDataKey = parentNode._id + ':' + createBtDataUid(btData);

        var parentBtData = btDataMap[parentBtDataKey];
        if(!parentBtData) {
          parentBtData = cloneBtData(btData);
          parentBtData._synthetic = true;
          btDataMap[parentBtDataKey] = parentBtData;
          parentNode[procProp].push(parentBtData);
        }
        else if (parentBtData._synthetic) {
          parentBtData.count += btData.count;
          parentBtData.totalTimeTaken += btData.totalTimeTaken;
        }
      });
    }
  });

  reverseQueue.forEach(function(node) {
    delete node._id;

    if(node[procProp]) {
      node[procProp].forEach(function(btData) {
        delete btData._synthetic;
      });
    }
  });
};

ProcessScanner.prototype.postProcessCallGraph = function(processSnapshot, callContextMap, durationSeconds) {
  var self = this;

  var callElements = processSnapshot.processCallGraph.callElements;

  if(callElements && callElements.length > 0) {
    var rootNode = self.convertListToTree(callElements);

    self.calculateCpuTime(rootNode, durationSeconds);

    self.populateCallContext(rootNode, callContextMap);

    self.mergeThreadPaths(rootNode);

    self.removeIdleNode(rootNode);

    if(self.agent.opts.excludeAgentFromCallGraph) {
      self.removeAgentNodes(rootNode);
    }

    self.backpropagateCallContext(rootNode);

    callElements = self.convertTreeToList(rootNode);

    // remove root node
    var root = callElements[0];
    if (root && root.klass == "(global)" && root.method == "(root)") {
      processSnapshot.processCallGraph.numOfRootElements = root.numChildren;
      callElements.splice(0, 1);
    }

    processSnapshot.processCallGraph.callElements = callElements;
  }
};



ProcessScanner.prototype.postProcessAllocationGraph = function(processSnapshot, callContextMap) {
  var self = this;

  var allocationElements = processSnapshot.processAllocationGraph.allocationElements;

  if(allocationElements && allocationElements.length > 0) {
    var rootNode = self.convertListToTree(allocationElements);

    self.populateCallContext(rootNode, callContextMap);

    self.mergeThreadPaths(rootNode, true);

    if(self.agent.opts.excludeAgentFromCallGraph) {
      self.removeAgentNodes(rootNode);
    }

    self.backpropagateCallContext(rootNode, true);

    allocationElements = self.convertTreeToList(rootNode);

    processSnapshot.processAllocationGraph.allocationElements = allocationElements;
    processSnapshot.processAllocationGraph.numOfRootElements = 1;
  }
};
