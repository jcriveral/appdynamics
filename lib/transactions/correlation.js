/*
Copyright (c) AppDynamics, Inc., and its affiliates
2015
All Rights Reserved
 */
'use strict';

var CorrelationHeader = require('./correlation-header').CorrelationHeader;


function Correlation(agent) {
  this.agent = agent;

  this.cidRegex = undefined;

  this.appId = undefined;
  this.tierId = undefined;
  this.accountGuid = undefined;
  this.controllerGuid = undefined;
  this.namingSchemeType = undefined;

  // constants
  this.HEADER_NAME = "singularityheader";
  this.ACCOUNT_GUID = "acctguid";
  this.CONTROLLER_GUID = "ctrlguid";
  this.APP_ID = "appId";
  this.BT_ID = "btid";
  this.BT_NAME = "btname";
  this.ENTRY_POINT_TYPE = "bttype";
  this.BT_COMPONENT_MAPPING = "btcomp";
  this.EXIT_POINT_GUID = "exitguid";
  this.UNRESOLVED_EXIT_ID = "unresolvedexitid";
  this.COMPONENT_ID_FROM = "cidfrom";
  this.COMPONENT_ID_TO = "cidto";
  this.EXIT_CALL_TYPE_ORDER = "etypeorder";
  this.EXIT_CALL_SUBTYPE_KEY = "esubtype";
  this.SNAPSHOT_ENABLE = "snapenable";
  this.CROSS_APP_SNAPSHOT = "cacsnapshot";
  this.REQUEST_GUID = "guid";
  this.MATCH_CRITERIA_TYPE = "mctype";
  this.MATCH_CRITERIA_VALUE = "mcvalue";
  this.TIMESTAMP = "ts";
  this.DISABLE_TRANSACTION_DETECTION = "notxdetect";
  this.DONOTRESOLVE = "donotresolve";
  this.DEBUG_ENABLED = "debug";
  this.MUST_TAKE_SNAPSHOT = "appdynamicssnapshotenabled";
  this.MATCH_CRITERIA_TYPE_DISCOVERED = "auto";
  this.MATCH_CRITERIA_TYPE_CUSTOM = "custom";
  this.CID_IS_APPID_PREFIX = "A";
  this.cidRegex = /^\{\[UNRESOLVED\]\[(\d+)\]\}$/;
  this.cidResolvedCrossAppRegEx =  /^A(\d+)$/;
  this.cidResolvedRegEx = /^(\d+)$/;

}
exports.Correlation = Correlation;


Correlation.prototype.init = function() {
  var self = this;


  self.agent.on('configUpdated', function() {
    self.appId = self.agent.configManager.getConfigValue("agentIdentity.appID");
    self.tierId = self.agent.configManager.getConfigValue("agentIdentity.tierID");
    self.accountGuid = self.agent.configManager.getConfigValue("agentIdentity.accountGUID");
    self.controllerGuid = self.agent.configManager.getConfigValue("agentIdentity.controllerGUID");
    self.namingSchemeType = self.agent.configManager.getConfigValue('txConfig.nodejsWeb.discoveryConfig.namingScheme.type');
  });
};


Correlation.prototype.newCorrelationHeader = function() {
  var self = this;

  return new CorrelationHeader(self.agent);
};
