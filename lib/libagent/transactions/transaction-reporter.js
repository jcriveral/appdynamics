/*
* Copyright (c) AppDynamics, Inc., and its affiliates
* 2016
* All Rights Reserved
*/
'use strict';

function TransactionReporter(agent) {
  this.agent = agent;
  this.enabled = undefined;
}

exports.TransactionReporter = TransactionReporter;

TransactionReporter.prototype.init = function() {
  var self = this;
  self.enabled = true;

  // self.agent.on('configUpdated', function() {});
  // self.agent.on('transactionStarted', function(transaction, req) {});
  // self.agent.on('transactionStopped', function(transaction, req) {});

};
