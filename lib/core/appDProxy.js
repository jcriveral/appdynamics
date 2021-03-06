/*
Copyright (c) AppDynamics, Inc., and its affiliates
2015
All Rights Reserved
 */
'use strict';


// uncomment to generate proxy-funcs.js file

/*
var proxyFuncsContent = 'module.exports = {\n';
for(var i = 0; i < 250; i++) {
proxyFuncsContent += '  ' + i + ': function(func) { return function appd_proxy_' + i + '() { return func.apply(this, arguments); }},\n';
}
proxyFuncsContent += '};\n';

var fs = require('fs');
require('fs').writeFile("proxy-funcs.js", proxyFuncsContent, function(err) {
if(err) return console.error(err);

console.log('done.');
});
return;
 */


var EventEmitter = require('events').EventEmitter;
var proxyFuncs = require('./proxy-funcs');

function AppDProxy(agent) {
  this.agent = agent;

  this.threadProxyMap = undefined;
  this.threadProxyIndex = undefined;

  this.callContextMap = undefined;
  this.callContextEnabled = undefined;
}
exports.AppDProxy = AppDProxy;


AppDProxy.prototype.init = function() {
  var self = this;

  // removeListener compairs objects, so the original callback
  // should be passed instead of the proxy
  self.before(EventEmitter.prototype, 'removeListener', function(obj, args) {
    if(args.length > 1 && args[1] && args[1].__appdynamicsProxy__) {
      args[1] = args[1].__appdynamicsProxy__;
    } else {
      // Try to match the callback function intended to be removed for
      // the event with all the probed callbacks attached for that event
      // on the object
      var eventCbList = obj._events[args[0]];
      if ((typeof eventCbList === 'function') && eventCbList.__appdynamicsProxy__ && eventCbList.__appdynamicsProxy__ === args[1]) {
        eventCbList = eventCbList.__appdynamicsProxy__;
        obj._events[args[0]] = eventCbList;
      }
      if (eventCbList && eventCbList.length) {
        for(var i = 0; i < eventCbList.length; i++) {
          if (eventCbList[i] && eventCbList[i].__appdynamicsProxy__ && (eventCbList[i].__appdynamicsProxy__ === args[1]))
            eventCbList[i] = eventCbList[i].__appdynamicsProxy__;
        }
      }
    }
  });


  self.agent.on('btDetails', function(btDetails, transaction) {
    if(!self.callContextEnabled) return;

    var proxyId = self.threadProxyMap[transaction.threadId];
    if (proxyId >= 0) {

      if(btDetails.btInfoRequest &&
         btDetails.btInfoRequest.btIdentifier &&
         btDetails.btInfoRequest.btIdentifier.btID) {
        var callContext = {'btId': btDetails.btInfoRequest.btIdentifier.btID};

        if(btDetails.snapshotInfo &&
           btDetails.snapshotInfo.snapshot.snapshotGUID) {
          callContext.snapshotGuid = btDetails.snapshotInfo.snapshot.snapshotGUID;
        }

        self.callContextMap['appd_proxy_' + proxyId] = callContext;
      }
    }
  });

  self.agent.on('updateCallContextMap', function(transaction, btId) {
    if (!self.callContextEnabled || btId <= 0) return;
    var proxyId = self.threadProxyMap[transaction.threadId];

    if (proxyId >= 0) {
      var callContext = {
        'btId': btId,
        'snapshotGuid': transaction.guid
      };
      self.callContextMap['appd_proxy_' + proxyId] = callContext;
    }
  });

  self.disableCallContext();
};

AppDProxy.prototype.enableCallContext = function() {
  var self = this;

  self.disableCallContext();
  self.callContextEnabled = true;
};

AppDProxy.prototype.disableCallContext = function() {
  var self = this;

  self.callContextEnabled = false;
  self.callContextMap = {};

  self.threadProxyMap = {};
  self.threadProxyIndex = -1;
};

AppDProxy.prototype.getCallContextMap = function() {
  var self = this;

  return self.callContextMap;
};

/* istanbul ignore next */
AppDProxy.prototype.generateThreadProxy = function(func, index) {
  var proxyFuncGen = proxyFuncs[index];
  if(proxyFuncGen) {
    return proxyFuncGen(func);
  }

  return undefined;
};

AppDProxy.prototype.getThreadProxy = function(func) {
  var self = this;

  var threadId = self.agent.thread.current();

  if (threadId !== undefined) {
    // check if already mapped
    var threadProxyId = self.threadProxyMap[threadId];
    if (threadProxyId >= 0 ) {
      return self.generateThreadProxy(func, threadProxyId);
    }
    else {
      // try to get a free wrapper
      if (self.threadProxyIndex++ < 250) {
        // map wrapper id to thread id
        self.threadProxyMap[threadId] = self.threadProxyIndex;

        return self.generateThreadProxy(func, self.threadProxyIndex);
      }
    }
  }

  return undefined;
};

AppDProxy.prototype.wrapWithThreadProxyIfEnabled = function (realCallback) {
  if (!this.callContextEnabled) {
    return realCallback;
  }
  var result = this.getThreadProxy(realCallback);
  if (!result) {
    return realCallback;
  }
  return result;
};

var Locals = function() {
  this.time = undefined;
  this.stackTrace = undefined;
  this.params = undefined;
  this.opts = undefined;
  this.group = undefined;
  this.req = undefined;
  this.res = undefined;
  this.error = undefined;
  this.transaction = undefined;
  this.exitCall = undefined;
};

AppDProxy.prototype.release = function(proxied) {
  var info = proxied.__appdynamicsProxyInfo__;

  if (!info) return;
  info.obj[info.meth] = info.orig;
};

AppDProxy.prototype.getSymbolProperty = function(obj, symbolDesc) {
  for (const s of Object.getOwnPropertySymbols(obj)) {
    const desc = s.toString().replace(/Symbol\((.*)\)$/, '$1');
    if (desc === symbolDesc) {
      return obj[s];
    }
  }
};

AppDProxy.prototype.before = function(obj, meths, hook, isCallbackHook, copyAllProps, methsInvocationCtxt) {
  var self = this;

  if(!obj) return false;

  if(!Array.isArray(meths)) meths = [meths];

  meths.forEach(function(meth) {
    var orig = obj[meth];
    if(!orig) return;

    var beforeExecLogic = function() {
      var currentCtxt = self.agent.thread.current();
      try {
        var args = arguments;
        var methsInvocationCtxtLocal = methsInvocationCtxt;
        if (methsInvocationCtxtLocal)
          self.agent.thread.resume(methsInvocationCtxtLocal);
        if(isCallbackHook) {
          var selfProxy = this;

          // the hook code should contain try/catch
          args = hook(this, arguments, function() {
            return orig.apply(selfProxy, args || arguments);
          });
        }
        else {
          try {
            args = hook(this, arguments);
          }
          catch (e) {
            self.logError(e);
          }

          var retValue = orig.apply(this, args || arguments);
          return retValue;
        }
      } finally {
        self.agent.thread.resume(currentCtxt);
      }
    };

    obj[meth] = self.getArityFunction(orig.length, beforeExecLogic);

    if(copyAllProps) copyObjectProps(orig, obj[meth]);

    obj[meth].__appdynamicsProxyInfo__ = {
      obj: obj,
      meth: meth,
      orig: orig
    };
  });
};

AppDProxy.prototype.after = function(obj, meths, hook, copyAllProps, methsInvocationCtxt) {
  var self = this;

  if(!obj) return false;

  if(!Array.isArray(meths)) meths = [meths];

  meths.forEach(function(meth) {
    var orig = obj[meth];
    if(!orig) return;
    var afterExecLogic = function() {
      var currentCtxt = self.agent.thread.current();
      try {
        var methsInvocationCtxtLocal = methsInvocationCtxt;
        if (methsInvocationCtxtLocal)
          self.agent.thread.resume(methsInvocationCtxtLocal);
        var ret = orig.apply(this, arguments);

        var hookRet;
        try {
          hookRet = hook(this, arguments, ret);
        }
        catch (e) {
          self.logError(e);
        }
        return hookRet || ret;
      } finally {
        self.agent.thread.resume(currentCtxt);
      }
    };
    obj[meth] = self.getArityFunction(orig.length, afterExecLogic);

    if(copyAllProps) copyObjectProps(orig, obj[meth]);

    obj[meth].__appdynamicsProxyInfo__ = {
      obj: obj,
      meth: meth,
      orig: orig
    };
  });
};

AppDProxy.prototype.isPromiseSupported = function() {
  // Promises are supported in Node v0.12 and above.
  if (parseInt(process.versions.node.split('.')[0], 10) === 0 && parseInt(process.versions.node.split('.')[1], 10) < 12)
    return false;
  return true;
};

AppDProxy.prototype.promise = function(returnVal, promiseHook, obj, methodArgs, locals) {
  // For unsupported node versions return.
  if (!this.isPromiseSupported())
    return;
  // A Promise is always 'thenable'.
  // "thenable" is an object or function that defines a then method.
  // Here is thread, with a discussion on how to determine if an Object is a Promise
  // https://stackoverflow.com/questions/27746304/how-do-i-tell-if-an-object-is-a-promise
  if (!returnVal || typeof (returnVal.then) !== 'function' || returnVal instanceof EventEmitter)
    return;

  // For Promises
  return returnVal.then(function resolve(data) {
    promiseHook(obj, methodArgs, {
      __appdynamicsIsPromiseResult__: true,
      error: null,
      data: data
    }, locals);
    return data;
  }).catch(function(err) {
    promiseHook(obj, methodArgs, {
      __appdynamicsIsPromiseResult__: true,
      error: err,
      data: null
    }, locals);
    return Promise.reject(err);
  });
};


AppDProxy.prototype.around = function(obj, meths, hookBefore, hookAfter, copyAllProps, methsInvocationCtxt) {
  var self = this;

  if(!obj) return false;

  if(!Array.isArray(meths)) meths = [meths];

  meths.forEach(function(meth) {
    var orig = obj[meth];
    if(!orig) return;

    obj[meth] = function() {
      var currentCtxt = self.agent.thread.current();
      try {
        var args = arguments;
        var methsInvocationCtxtLocal = methsInvocationCtxt;
        if (methsInvocationCtxtLocal)
          self.agent.thread.resume(methsInvocationCtxtLocal);
        var locals = new Locals();

        try {
          args = hookBefore(this, arguments, locals);
        }
        catch (e) {
          self.logError(e);
        }
        finally {
          // If methsInvocationCtxtLocal is undefined, preserve the thread context in which the
          // interceptor function is called.
          // Make sure the original function and after function is executed in the same context.
          if (!methsInvocationCtxtLocal && locals.time && locals.time.threadId) {
            methsInvocationCtxtLocal = locals.time.threadId;
            self.agent.thread.resume(methsInvocationCtxtLocal);
          }
        }

        var ret = orig.apply(this, args || arguments);
        var promiseRet = self.promise(ret, hookAfter, this, arguments, locals, methsInvocationCtxtLocal);
        if (promiseRet) {
          self.agent.thread.resume(currentCtxt);
          return promiseRet;
        }

        var hookRet;
        try {
          hookRet = hookAfter(this, arguments, ret, locals);
        }
        catch (e) {
          self.logError(e);
        }

        return hookRet || ret;
      }
      finally {
        self.agent.thread.resume(currentCtxt);
      }
    };

    if(copyAllProps) copyObjectProps(orig, obj[meth]);

    obj[meth].__appdynamicsProxyInfo__ = {
      obj: obj,
      meth: meth,
      orig: orig
    };
  });
};

AppDProxy.prototype.callback = function(args, pos, hookBefore, hookAfter, methsInvocationCtxt) {
  var self = this;

  if(!args) return false;

  if(args.length <= pos) return false;
  if(pos === -1) pos = args.length - 1;

  var orig = (typeof args[pos] === 'function') ? args[pos] : undefined;
  if(!orig) return false;

  args[pos] = function appd_proxy() {
    var currentCtxt = self.agent.thread.current();
    try {
      if (methsInvocationCtxt)
        self.agent.thread.resume(methsInvocationCtxt);
      if(hookBefore) {
        try {
          hookBefore(this, arguments);
        }
        catch(e) {
          self.logError(e);
        }
      }

      var ret = orig.apply(this, arguments);

      if(hookAfter) {
        try {
          hookAfter(this, arguments, ret);
        }
        catch(e) {
          self.logError(e);
        }
      }
      return ret;
    }
    finally {
      self.agent.thread.resume(currentCtxt);
    }

  };

  if(self.callContextEnabled) {
    var threadProxy = self.getThreadProxy(args[pos]);
    if(threadProxy) {
      args[pos] = threadProxy;
    }
  }

  // this is needed for removeListener
  args[pos].__appdynamicsProxy__ = orig;

  return true;
};

AppDProxy.prototype.getter = function(obj, props, hook) {
  var self = this;

  if(!Array.isArray(props)) props = [props];

  props.forEach(function(prop) {
    var orig = obj.__lookupGetter__(prop);
    if(!orig) return;

    obj.__defineGetter__(prop, function() {
      var ret = orig.apply(this, arguments);

      try {
        hook(this, ret);
      }
      catch(e) {
        self.logError(e);
      }

      return ret;
    });
  });
};

AppDProxy.prototype.getErrorObject = function(args) {
  if(args && args.length > 0 && args[0]) {
    if(typeof(args[0]) === 'object' || typeof(args[0]) === 'string') {
      return args[0];
    }
    else {
      return 'unspecified';
    }
  }

  return undefined;
};

AppDProxy.prototype.logError = function(err) {
  this.agent.logger.error(err);
};

/*eslint-disable */
AppDProxy.prototype.getArityFunction = function(arity, functionLogic) {
  var returnFunc;
  switch(arity) {
    case 0:
      returnFunc = function () {
        return functionLogic.apply(this, arguments);
      };
      break;
    case 1:
      returnFunc = function (a) {
        return functionLogic.apply(this, arguments);
      };
      break;
    case 2:
      returnFunc = function (a, b) {
        return functionLogic.apply(this, arguments);
      };
      break;
    case 3:
      returnFunc = function (a, b, c) {
        return functionLogic.apply(this, arguments);
      };
      break;
    case 4:
      returnFunc = function (a, b, c, d) {
        return functionLogic.apply(this, arguments);
      };
      break;
    case 5:
      returnFunc = function (a, b, c, d, e) {
        return functionLogic.apply(this, arguments);
      };
      break;
    case 6:
      returnFunc = function (a, b, c, d, e, f) {
        return functionLogic.apply(this, arguments);
      };
      break;
    case 7:
      returnFunc = function (a, b, c, d, e, f, g) {
        return functionLogic.apply(this, arguments);
      };
      break;
    case 8:
      returnFunc = function (a, b, c, d, e, f, g, h) {
        return functionLogic.apply(this, arguments);
      };
      break;
    case 9:
      returnFunc = function (a, b, c, d, e, f, g, h, i) {
        return functionLogic.apply(this, arguments);
      };
      break;
    case 10:
      returnFunc = function (a, b, c, d, e, f, g, h, i, j) {
        return functionLogic.apply(this, arguments);
      };
      break;
    default:
      this.agent.logger.warn('Experienced a high arity function with arity of ', arity);
      returnFunc = function () {
        return functionLogic.apply(this, arguments);
      };
      break;
  }
  return returnFunc;
};
/*eslint-enable */

function copyObjectProps(source, destination) {
  var methodProps = Object.getOwnPropertyNames(source);

  for(var i = 0; i < methodProps.length; i++) {
    if(Object.getOwnPropertyDescriptor(source, methodProps[i]).writable) {
      destination[methodProps[i]] = source[methodProps[i]];
    }
  }
}