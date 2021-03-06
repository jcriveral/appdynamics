/*
Copyright (c) AppDynamics, Inc., and its affiliates
2015
All Rights Reserved
 */
'use strict';

/*
 * Metric object used for aggregating values and trasfering
 * the aggregated metric to data sender. It can have three states:
 * - created/resetted
 * - initialized, i.e. accumulating values
 * - aggregated
 */


function Metric(agent, definition, isCustom) {
  this.agent = agent;
  this.metricName = definition.path;
  this.isCustom = isCustom;
  this.definition = definition;
  // dynamic value property to support live metrics
  Object.defineProperty(this, 'value', {
    enumerable: true,
    get: function() {
      var val = undefined;
      var self = this;
      if (typeof(self._value) == 'function') {
        val = self._value();
        if (self.metricId)
          self.agent.emit('metricValue', self, val);
      }
      else {
        val = self._value;
      }
      return val;
    }
  });
  if (this.agent.backendConnector.nodeIndexComputed) {
    this.registerMetric();
  }
}

exports.Metric = Metric;


Metric.prototype.reset = function() {};

Metric.prototype.registerMetric = function() {
  var libagentConnector = this.agent.libagentConnector;
  if (this.isCustom) {
    this.metricId = libagentConnector.addCustomMetric(this.definition.path, this.definition.aggregatorType, this.definition.rollupType,
      this.definition.clusterRollup, this.definition.holeHandling);
  } else {
    this.metricId = libagentConnector.addMetric(this.definition.path, this.definition.aggregatorType, this.definition.rollupType);
  }
};

Metric.prototype.addValue = function(v) {
  var self = this;
  self._value = v;
  if (typeof(self._value) == 'number') {
    if (self.metricId)
      self.agent.emit('metricValue', self, self._value);
  }
};

// TODO: why is this function required? The cloned object refers to
// the same metric as the original object
Metric.prototype.clone = function() {
  var cln = new Metric(
    this.agent,
    this.metricName,
    this.unit,
    this.op,
    this.rollupType,
    this.aggregatorType
  );

  cln._value = this._value;
  cln.metricId = this.metricId;

  return cln;
};
