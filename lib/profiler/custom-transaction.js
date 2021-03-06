/*
Copyright (c) AppDynamics, Inc., and its affiliates
2015
All Rights Reserved
 */
'use strict';


var TimePromise = require('./time-promise').TimePromise;


function CustomTransaction(agent) {
  this.agent = agent;

  this.exitTypeMap = {
    "EXIT_DB": "DB",
    "EXIT_CACHE": "CACHE",
    "EXIT_HTTP": "HTTP"
  };
}
exports.CustomTransaction = CustomTransaction;


CustomTransaction.prototype.init = function() {
};


CustomTransaction.prototype.start = function(transactionInfo) {
  var tp = new TimePromise(this.agent, transactionInfo);
  tp.start();
  return tp;
};

CustomTransaction.prototype.join = function(request, transaction) {
  return TimePromise.fromRequest(this.agent, request, transaction);
};
