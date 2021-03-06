/*
Copyright (c) AppDynamics, Inc., and its affiliates
2015
All Rights Reserved
 */
'use strict';

var EventLoopMetrics = require('./eventloop').EventLoopMetrics;

/*
 * MetricsManager manages metric lifecycle, i.e. keeps list
 * and map of metrics, aggregates and emits every minute, etc.
 * It also emits all possible metrics once the agent start, to make sure
 * the server gets something to start with.
 */

function MetricsManager(agent) {
  this.agent = agent;
  this.metrics = null;
  this.metricMap = null;
  this.eventloopMetrics = null;

  // metric names
  this.NODEJS = "Node.js";
  this.CPU_PERCENT_BUSY = {
    path: "Node.js|CPU|%Busy",
    unit: 'ms',
    op: 'CURRENT',
    rollupType: 'AVG',
    aggregatorType: 'AVG'
  };
  this.GC_FULL = {
    path: "Node.js|Garbage Collection|Number of Full GCs Per Min",
    op: 'TIME_SUM',
    rollupType: 'AVG',
    aggregatorType: 'SUM'
  };
  this.GC_INC = {
    path: "Node.js|Garbage Collection|Number of Inc GCs Per Min",
    op: 'TIME_SUM',
    rollupType: 'AVG',
    aggregatorType: 'SUM'
  };
  this.HEAP_SIZE_CHANGE = {
    path: "Node.js|Memory:Heap|Changed %",
    unit: 'MB',
    op: 'CURRENT',
    rollupType: 'AVG',
    aggregatorType: 'AVG'
  };
  this.HEAP_USAGE = {
    path: "Node.js|Memory:Heap|Current Usage (MB)",
    unit: 'MB',
    op: 'CURRENT',
    rollupType: 'AVG',
    aggregatorType: 'AVG'
  };
  this.HEAP_TOTAL = {
    path: "Node.js|Memory:Heap|Total Usage (MB)",
    unit: 'MB',
    op: 'CURRENT',
    rollupType: 'AVG',
    aggregatorType: 'AVG'
  };
  this.NODE_RSS = {
    path: "Node.js|Memory|rss",
    unit: 'MB',
    op: 'CURRENT',
    rollupType: 'AVG',
    aggregatorType: 'AVG'
  };
  this.DISK_IO_READ = {
    path: "Node.js|Disks|KB read/sec",
    unit: 'KB',
    op: 'TIME_SUM',
    rollupType: 'SUM',
    aggregatorType: 'AVG'
  };
  this.DISK_IO_WRITE = {
    path: "Node.js|Disks|KB written/sec",
    unit: 'KB',
    op: 'TIME_SUM',
    rollupType: 'SUM',
    aggregatorType: 'AVG'
  };
  this.NETWORK_IO_READ = {
    path: "Node.js|Network|Incoming KB/sec",
    unit: 'KB',
    op: 'TIME_SUM',
    rollupType: 'SUM',
    aggregatorType: 'AVG'
  };
  this.NETWORK_IO_WRITE = {
    path: "Node.js|Network|Outgoing KB/sec",
    unit: 'KB',
    op: 'TIME_SUM',
    rollupType: 'SUM',
    aggregatorType: 'AVG'
  };
  this.SOCKETIO_CONNECTIONS = {
    path: "Node.js|Socket.io|Number of Connections",
    unit: 'count',
    op: 'CURRENT',
    rollupType: 'SUM',
    aggregatorType: 'SUM'
  };
  this.SOCKETIO_CONNECTIONS_TOTAL = {
    path: "Node.js|Socket.io|Total Number of Connections",
    unit: 'count',
    op: 'CURRENT',
    rollupType: 'SUM',
    aggregatorType: 'SUM'
  };
  this.SOCKETIO_MESSAGES_SENT = {
    path: "Node.js|Socket.io|Number of Messages Sent",
    unit: 'count',
    op: 'TIME_SUM',
    rollupType: 'SUM',
    aggregatorType: 'SUM'
  };
  this.SOCKETIO_MESSAGES_RECEIVED = {
    path: "Node.js|Socket.io|Number of Messages Received",
    unit: 'count',
    op: 'TIME_SUM',
    rollupType: 'SUM',
    aggregatorType: 'SUM'
  };
  this.SOCKETIO_SENT_MESSAGES_SIZE = {
    path: "Node.js|Socket.io|Size of Messages Sent",
    unit: 'Characters',
    op: 'TIME_AVERAGE',
    rollupType: 'AVG',
    aggregatorType: 'AVG'
  };
  this.SOCKETIO_RECEIVED_MESSAGES_SIZE = {
    path: "Node.js|Socket.io|Size of Messages Received",
    unit: 'Characters',
    op: 'TIME_AVERAGE',
    rollupType: 'AVG',
    aggregatorType: 'AVG'
  };
  this.EVENT_LOOP_TICK_COUNT = {
    path: "Node.js|Event Loop|Tick Count",
    unit: 'count',
    op: 'CURRENT',
    rollupType: 'SUM',
    aggregatorType: 'SUM'
  };
  this.EVENT_LOOP_TICK_LENGTH_MIN = {
    path: "Node.js|Event Loop|Minimum Tick Length",
    unit: 'ms',
    op: 'CURRENT',
    rollupType: 'AVG',// FIXME: this is not the right
                      // rollup/aggregator
    aggregatorType: 'AVG'
  };
  this.EVENT_LOOP_TICK_LENGTH_MAX = {
    path: "Node.js|Event Loop|Maximum Tick Length",
    unit: 'ms',
    op: 'CURRENT',
    rollupType: 'AVG',
    aggregatorType: 'AVG'
  };
  this.EVENT_LOOP_TICK_LENGTH_AVG = {
    path: "Node.js|Event Loop|Average Tick Length",
    unit: 'ms',
    op: 'CURRENT',
    rollupType: 'AVG',
    aggregatorType: 'AVG'
  };
  this.EVENT_LOOP_IO_TIME_AVG = {
    path: "Node.js|Event Loop|Average IO Time",
    unit: 'ms',
    op: 'CURRENT',
    rollupType: 'AVG',
    aggregatorType: 'AVG'
  };
  this.HTTP_INCOMING_COUNT = {
    path: "Node.js|HTTP|Incoming Connection Count",
    unit: 'count',
    op: 'CURRENT',
    rollupType: 'SUM',
    aggregatorType: 'SUM'
  };
  this.HTTP_OUTGOING_COUNT = {
    path: "Node.js|HTTP|Outgoing Connection Count",
    unit: 'count',
    op: 'CURRENT',
    rollupType: 'SUM',
    aggregatorType: 'SUM'
  };

  this.NSOLID_UPTIME = {
    path: "Node.js|NSolid|Process Uptime (ms)",
    unit: 'ms',
    op: 'CURRENT',
    rollupType: 'AVG',
    aggregatorType: 'AVG'
  };
  this.NSOLID_HEAPTOTAL = {
    path: "Node.js|NSolid|Memory:JS Heap|Total Usage (MB)",
    unit: "MB",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG"
  };
  this.NSOLID_ACTIVEREQUESTS = {
    path: "Node.js|NSolid|Event Loop|Active Requests",
    unit: "count",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG"
  };
  this.NSOLID_ACTIVEHANDLES = {
    path: "Node.js|NSolid|Event Loop|Active Handles",
    unit: "count",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG"
  };
  this.NSOLID_TOTALAVAILABLESIZE = {
    path: "Node.js|NSolid|Memory|Total Size (MB)",
    unit: "MB",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG"
  };
  this.NSOLID_HEAPSIZELIMIT = {
    path: "Node.js|NSolid|Memory:V8 Heap|Total Available (MB)",
    unit: "MB",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG"
  };
  this.NSOLID_FREEMEM = {
    path: "Node.js|NSolid|Memory|Total Available (MB)",
    unit: "MB",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG"
  };
  this.NSOLID_SYSTEMUPTIME = {
    path: "Node.js|NSolid|System Uptime (ms)",
    unit: "ms",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG"
  };
  this.NSOLID_LOAD1M = {
    path: "Node.js|NSolid|1m Load Average",
    unit: "ms",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG"
  };
  this.NSOLID_LOAD5M = {
    path: "Node.js|NSolid|5m Load Average",
    unit: "ms",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG"
  };
  this.NSOLID_LOAD15M = {
    path: "Node.js|NSolid|15m Load Average",
    unit: "ms",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG"
  };

  this.NSOLID_IDLEPERCENT = {
    path: "Node.js|NSolid|Event Loop|Idle (%)",
    unit: "%",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_ESTIMATEDLAG = {
    path: "Node.js|NSolid|Event Loop|Estimated Lag (ms)",
    unit: "ms",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_TURNRATE = {
    path: "Node.js|NSolid|Event Loop|Turns (per second)",
    unit: "count",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_AVGTASKS = {
    path: "Node.js|NSolid|Event Loop|Average Tasks (per turn)",
    unit: "count",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_TURNCOUNT = {
    path: "Node.js|NSolid|Event Loop|Total Turns",
    unit: "count",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_CPUSYSTEM = {
    path: "Node.js|NSolid|Process|System CPU Usage (%)",
    unit: "%",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_CPUUSER = {
    path: "Node.js|NSolid|Process|User CPU Usage (%)",
    unit: "%",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_CSINVOLUNTARTY = {
    path: "Node.js|NSolid|Process|Involuntary Context Switches",
    unit: "count",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_CSVOLUNTARTY = {
    path: "Node.js|NSolid|Process|Voluntary Context Switches",
    unit: "count",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_IPCRECEIVED = {
    path: "Node.js|NSolid|Process|IPC Messages Received",
    unit: "count",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_IPCSENT = {
    path: "Node.js|NSolid|Process|IPC Messages Sent",
    unit: "count",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_SIGNALSRECEIVED = {
    path: "Node.js|NSolid|Process|Signals Received",
    unit: "count",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_PAGEFAULTSSOFT = {
    path: "Node.js|NSolid|Process|Soft Page Faults",
    unit: "count",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_PAGEFAULTSHARD = {
    path: "Node.js|NSolid|Process|Hard Page Faults",
    unit: "count",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_SWAPCOUNT = {
    path: "Node.js|NSolid|Process|Process Swaps",
    unit: "count",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_BLOCKINPUTS = {
    path: "Node.js|NSolid|Process|Block Input Operations",
    unit: "count",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_BLOCKOUTPUTS = {
    path: "Node.js|NSolid|Process|Block Output Operations",
    unit: "count",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_GCTOTAL = {
    path: "Node.js|NSolid|GC|Total Collections",
    unit: "count",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_GCFULL = {
    path: "Node.js|NSolid|GC|Full Collections",
    unit: "count",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_GCMAJOR = {
    path: "Node.js|NSolid|GC|Major Collections",
    unit: "count",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_GCFORCED = {
    path: "Node.js|NSolid|GC|Forced Collections",
    unit: "count",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_GCCPU = {
    path: "Node.js|NSolid|GC|GC CPU Usage (%)",
    unit: "%",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_GCTIME99 = {
    path: "Node.js|NSolid|GC|GC Duration (99th Quantile, ms)",
    unit: "%",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
  this.NSOLID_GCTIMEMEDIAN = {
    path: "Node.js|NSolid|GC|GC Duration (Median, ms)",
    unit: "%",
    op: "CURRENT",
    rollupType: "AVG",
    aggregatorType: "AVG",
  };
}
exports.MetricsManager = MetricsManager;


MetricsManager.STRING_REGEX = /^[a-zA-Z0-9 \_\-\+\'\/\.\:\?\[\]\(\)]{1,128}$/;

MetricsManager.prototype.init = function() {
  var self = this;
  this.metrics = [];
  this.metricMap = {};
  this.timestamp = Date.now();
  this.eventloopMetrics = new EventLoopMetrics(this.agent);
  this.eventloopMetrics.init();
  this.agent.once('nodeIndexComputed', function() {
    self.metrics.forEach(function(metric) {
      if (!metric.metricId && metric.registerMetric)
        metric.registerMetric();
    });
  });
};

MetricsManager.prototype.validatePath = function(path) {
  if (!path || typeof(path) !== 'string') {
    return false;
  }
  var segments = path.split('|');
  for (var item in segments) {
    if (!MetricsManager.STRING_REGEX.exec(item)) {
      return false;
    }
  }
  return true;
};

MetricsManager.prototype.createMetric = function(definition, op, clusterRollup, holeHandling, isCustom) {
  var self = this,
    metric;

  if(this.metrics.length == 5000) {
    self.agent.logger.warn('too many metrics, ignoring metric');
    return new self.agent.Metric(self.agent, definition, isCustom);
  }

  var path = definition.path;
  if(!self.validatePath(path)) {
    self.agent.logger.warn('metric parameter(s) missing or invalid, ignoring metric');
    return new self.agent.Metric(self.agent, definition, isCustom); // dummy metric
  }

  metric = new self.agent.Metric(self.agent, definition, isCustom);
  self.metrics.push(metric);
  self.metricMap[definition.path] = metric;

  return metric;
};

MetricsManager.prototype.findMetric = function(path) {
  return this.metricMap[path];
};

MetricsManager.prototype.findOrCreateMetric = function(definition) {
  var metric = this.findMetric(definition.path);
  if(!metric) {
    metric = this.createMetric(definition);
  }

  return metric;
};

MetricsManager.prototype.addMetric = function(definition, value) {
  var metric = this.findOrCreateMetric(definition);

  metric.addValue(value);

  return metric;
};

MetricsManager.prototype.getProcessMetrics = function(scale) {
  var self = this, now = Date.now(), metrics;

  function sampleMetric(definition) {
    var value = 0, metric = self.findMetric(definition.path), now;

    if (metric) {
      value = metric.value;
      metric.reset();

      if (scale) {
        value  = value / ((now - self.timestamp) * 1000);
      }
    }

    return Math.round(value);
  }

  metrics = {
    cpuUsage: sampleMetric(self.CPU_PERCENT_BUSY),
    heapSize: sampleMetric(self.HEAP_USAGE),
    nodeRss: sampleMetric(self.NODE_RSS),
    numOfFullGCs: sampleMetric(self.GC_FULL),
    numOfIncGCs: sampleMetric(self.GC_INC),
    heapSizeChange: sampleMetric(self.HEAP_SIZE_CHANGE),
    diskIOKBReadPerSec: sampleMetric(self.DISK_IO_READ),
    diskIOKBWrittenPerSec: sampleMetric(self.DISK_IO_WRITE),
    netwIOKBReadPerSec: sampleMetric(self.NETWORK_IO_READ),
    netwIOKBWrittenPerSec: sampleMetric(self.NETWORK_IO_WRITE),
    socketIOConnections: sampleMetric(self.SOCKETIO_CONNECTIONS),
    socketIOConnectionsTotal: sampleMetric(self.SOCKETIO_CONNECTIONS_TOTAL),
    socketIOMessagesSent: sampleMetric(self.SOCKETIO_MESSAGES_SENT),
    socketIOMessagesReceived: sampleMetric(self.SOCKETIO_MESSAGES_RECEIVED),
    socketIOSentMessagesSize: sampleMetric(self.SOCKETIO_SENT_MESSAGES_SIZE),
    socketIOReceivedMessagesSize: sampleMetric(self.SOCKETIO_RECEIVED_MESSAGES_SIZE),
    eventLoopTickCount: sampleMetric(self.EVENT_LOOP_TICK_COUNT),
    eventLoopMinTickLength: sampleMetric(self.EVENT_LOOP_TICK_LENGTH_MIN),
    eventLoopMaxTickLength: sampleMetric(self.EVENT_LOOP_TICK_LENGTH_MAX),
    eventLoopAvgTickLength: sampleMetric(self.EVENT_LOOP_TICK_LENGTH_AVG),
    eventLoopAvgIOTime: sampleMetric(self.EVENT_LOOP_IO_TIME_AVG),
    httpIncomingConnectionCount: sampleMetric(self.HTTP_INCOMING_COUNT),
    httpOutgoingConnectionCount: sampleMetric(self.HTTP_OUTGOING_COUNT),
    heapTotal: sampleMetric(self.HEAP_TOTAL),
  };

  if (self.agent.nsolidEnabled) {
    var nsolid = {
      nsolidUptime: sampleMetric(self.NSOLID_UPTIME),
      nsolidHeapTotal: sampleMetric(self.NSOLID_HEAPTOTAL),
      nsolidActiveRequests: sampleMetric(self.NSOLID_ACTIVEREQUESTS),
      nsolidActiveHandles: sampleMetric(self.NSOLID_ACTIVEHANDLES),
      nsolidTotalAvailableSize: sampleMetric(self.NSOLID_TOTALAVAILABLESIZE),
      nsolidHeapSizeLimit: sampleMetric(self.NSOLID_HEAPSIZELIMIT),
      nsolidFreemem: sampleMetric(self.NSOLID_FREEMEM),
      nsolidSystemUptime: sampleMetric(self.NSOLID_SYSTEMUPTIME),
      nsolidLoadAvg1m: sampleMetric(self.NSOLID_LOAD1M),
      nsolidLoadAvg5m: sampleMetric(self.NSOLID_LOAD5M),
      nsolidLoadAvg15m: sampleMetric(self.NSOLID_LOAD15M),
      nsolidIdlePercent: sampleMetric(self.NSOLID_IDLEPERCENT),
      nsolidEstimatedLag: sampleMetric(self.NSOLID_ESTIMATEDLAG),
      nsolidTurnRate: sampleMetric(self.NSOLID_TURNRATE),
      nsolidAvgTasks: sampleMetric(self.NSOLID_AVGTASKS),
      nsolidTurnCount: sampleMetric(self.NSOLID_TURNCOUNT),
      nsolidCpuSystem: sampleMetric(self.NSOLID_CPUSYSTEM),
      nsolidCpuUser: sampleMetric(self.NSOLID_CPUUSER),
      nsolidCSInvoluntary: sampleMetric(self.NSOLID_CSINVOLUNTARTY),
      nsolidCSVoluntary: sampleMetric(self.NSOLID_CSVOLUNTARTY),
      nsolidIPCReceived: sampleMetric(self.NSOLID_IPCRECEIVED),
      nsolidIPCSent: sampleMetric(self.NSOLID_IPCSENT),
      nsolidSignalsReceived: sampleMetric(self.NSOLID_SIGNALSRECEIVED),
      nsolidPageFaultsSoft: sampleMetric(self.NSOLID_PAGEFAULTSSOFT),
      nsolidPageFaultsHard: sampleMetric(self.NSOLID_PAGEFAULTSHARD),
      nsolidSwapCount: sampleMetric(self.NSOLID_SWAPCOUNT),
      nsolidBlockInputs: sampleMetric(self.NSOLID_BLOCKINPUTS),
      nsolidBlockOutputs: sampleMetric(self.NSOLID_BLOCKOUTPUTS),
      nsolidGCTotal: sampleMetric(self.NSOLID_GCTOTAL),
      nsolidGCFull: sampleMetric(self.NSOLID_GCFULL),
      nsolidGCMajor: sampleMetric(self.NSOLID_GCMAJOR),
      nsolidGCForced: sampleMetric(self.NSOLID_GCFORCED),
      nsolidGCCPU: sampleMetric(self.NSOLID_GCCPU),
      nsolidGCTime99: sampleMetric(self.NSOLID_GCTIME99),
      nsolidGCTimeMedian: sampleMetric(self.NSOLID_GCTIMEMEDIAN)
    };

    for (var name in nsolid) {
      if (nsolid.hasOwnProperty(name)) {
        metrics[name] = nsolid[name];
      }
    }
  }

  // explicitly reset natively managed event loop info
  self.eventloopMetrics.reset();

  self.timestamp = now;
  return metrics;
};
