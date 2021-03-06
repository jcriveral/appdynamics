/*
Copyright (c) AppDynamics, Inc., and its affiliates
2018
All Rights Reserved
 */
'use strict';

var APPD_NAMESPACE = 'appd';

function Context(agent) {
  this.agent = agent;
}

exports.Context = Context;

Context.prototype.init = function () {
  var cls;

  this.enabled = false;
  if (this.agent.opts.clsDisabled) {
    this.agent.logger.info('CLS disabled by configuration');
    return;
  }

  try {
    cls = require('cls-hooked');
    this.enabled = true;
  } catch (e) {
    this.agent.logger.info('CLS not supported for current node version');
  }

  // if we have a CLS solution, create a namespace for our use
  this.ns = cls && cls.createNamespace(APPD_NAMESPACE);
};

// run fn in CLS context if available; otherwise just run it without context
Context.prototype.run = function runInContext(fn, req, res) {
  var ns = this.ns;

  if (ns) {
    ns.run(function() {
      if (req) ns.bindEmitter(req);
      if (res) ns.bindEmitter(res);
      fn(req, res);
    });
  } else {
    fn(req, res);
  }
};

Context.prototype.bind = function(fn) {
  if (this.ns) fn = this.ns.bind(fn);
  return fn;
};

// set a value in CLS context, if available
Context.prototype.set = function set(key, value) {
  if (this.ns) return this.ns.set(key, value);
};

// get a value from CLS, if available
Context.prototype.get = function get(key) {
  return this.ns && this.ns.get(key);
};
