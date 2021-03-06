/*
Copyright (c) AppDynamics, Inc., and its affiliates
2015
All Rights Reserved
 */
'use strict';

var Http2EntryProbe = require('./http2-entry-probe').Http2EntryProbe;
var Http2ExitProbe = require('./http2-exit-probe').Http2ExitProbe;

function Http2Probe(agent) {
  this.agent = agent;
  this.packages = ['http2'];
  this.entryProbe = new Http2EntryProbe(agent);
  this.exitProbe = new Http2ExitProbe(agent);
  this.init();
}
exports.Http2Probe = Http2Probe;

Http2Probe.prototype.init = function() {
  this.entryProbe.init();
  this.exitProbe.init();
};

Http2Probe.prototype.attach = function(obj, moduleName) {
  var self = this;

  if(!self.agent.opts.http2interceptorenabled) return;

  var proxy = this.agent.proxy;

  if(obj.__appdynamicsProbeAttached__) return;
  obj.__appdynamicsProbeAttached__ = true;
  self.agent.on('destroy', function() {
    if(obj.__appdynamicsProbeAttached__) {
      delete obj.__appdynamicsProbeAttached__;
      proxy.release(obj.createSecureServer);
      proxy.release(obj.createServer);
    }
  });

  this.entryProbe.attach(obj, moduleName);
  this.exitProbe.attach(obj, moduleName);
};
