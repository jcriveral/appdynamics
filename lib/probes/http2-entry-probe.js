/*
Copyright (c) AppDynamics, Inc., and its affiliates
2015
All Rights Reserved
 */
'use strict';
var HttpCommon = require('./http-common');

function Http2EntryProbe(agent) {
  this.agent = agent;
  this.statusCodesConfig = undefined;
  this.delayedCallbackQueue = [];
}

exports.Http2EntryProbe = Http2EntryProbe;

Http2EntryProbe.prototype.init = function () {
  var self = this;

  self.agent.on('configUpdated', function () {
    self.statusCodesConfig = self.agent.configManager.getConfigValue('errorConfig.httpStatusCodes');
  });
};

Http2EntryProbe.prototype.attach = function (obj) {
  var self = this;

  self.agent.timers.startTimer(100, true, function () {
    var now = Date.now();

    while (self.delayedCallbackQueue.length > 0) {
      if (self.delayedCallbackQueue[0].ts < now - 10) {
        var delayedCallbackInfo = self.delayedCallbackQueue.shift();
        delayedCallbackInfo.func.call(this);
      } else {
        break;
      }
    }
  });

  self.agent.proxy.after(obj, ['createSecureServer', 'createServer'], function (obj, args, ret) {
    self.agent.proxy.before(ret, ['on', 'addListener'], function(obj, args) {  
      if (args[0] !== 'stream') return;

      var cbIndex = args.length - 1;
      args[cbIndex] = self.__createRequestHandler(args[cbIndex]);
    });
  });
};

function createBTCallback(agent, profiler, time, transaction, thread, callback, self, origSelf, req, stream, headers) {
  var didRun = false;
  var threadId = thread.current();

  return self.agent.context.bind(function () {
    if (didRun) return;
    didRun = true;

    var oldThreadId = thread.current();
    thread.resume(threadId);
    try {
      callback = agent.proxy.wrapWithThreadProxyIfEnabled(callback);
      callback.call(origSelf, stream, headers);
    } catch (e) {
      self.finalizeTransaction(e, profiler, time, transaction, req, stream);
      throw e;
    } finally {
      thread.resume(oldThreadId);
    }
  });
}

function buildEumCookie(agent, transaction, responseHeaders, request)
{
  var response = {headers: responseHeaders,
                  setHeader: function(key, value) { this.headers[key] = value; },
                  getHeader: function(key) { this.headers[key]; }};
  var eumCookie = agent.eum.newEumCookie(transaction, request, response, request.headers[":scheme"] == 'https');
  eumCookie.build();
}

Http2EntryProbe.prototype.__createRequestHandler = function (callback) {
  var self = this;

  return function (stream, headers) {
    self.agent.context.run(requestHandler, stream);

    function requestHandler(stream) {
      var proxy = self.agent.proxy;
      var profiler = self.agent.profiler;
      var time = profiler.time(true);

      self.agent.metricsManager.addMetric(self.agent.metricsManager.HTTP_INCOMING_COUNT, 1);

      var req = {url: headers[":path"], method: headers[":method"], headers: headers};
      var transaction = profiler.startTransaction(time, req, 'NODEJS_WEB');
      self.agent.context.set('threadId', transaction.threadId);
      req.__appdThreadId = transaction.threadId;

      transaction.url = req.url;
      transaction.method = req.method;
      transaction.requestHeaders = req.headers;

      var eumEnabled = (transaction.eumEnabled && !transaction.skip) || (self.agent.eum.enabled && self.agent.eum.enabledForTransaction(req));
      if (!transaction.corrHeader && eumEnabled) {
        proxy.before(stream, ['respond'], function (obj, args) {
          if(!transaction.isFinished) {
            if (!args.length || !args[0] || stream.headersSent) { return; }

            var responseHeaders = args[0];
            req["EumHeadersSet"] = true;

            buildEumCookie(self.agent, transaction, responseHeaders, req);
          }
        });

        proxy.before(stream, ['respondWithFile', 'respondWithFD'], function (obj, args) {
          if(!transaction.isFinished) {
            if (args.length < 2 || !args[1] || stream.headersSent) { return; }

            var responseHeaders = args[1];
            req["EumHeadersSet"] = true;
            buildEumCookie(self.agent, transaction, responseHeaders, req);
          }
        });

        var handle = proxy.getSymbolProperty(stream, 'handle');
        if (handle) {
          proxy.before(handle, 'respond', function(obj, args) {
            if (!args[0] || args[0].length != 2 || req["EumHeadersSet"]) { return; }
            var headersList = args[0];
            var headers = headersList[0];
            var count = headersList[1];
            var responseHeaders = {};
            buildEumCookie(self.agent, transaction, responseHeaders, req);

            // we need to perform the same conversion that the http2 module does
            // the following conversion is based on lib/http2/util.js mapToHeaders()
            const keys = Object.keys(responseHeaders);
            for (var i = 0; i < keys.length; ++i) {
              var key = keys[i];
              var value = responseHeaders[key];
              headers += `${key}\0${value}\0`;
              count++;
            }
            headersList[0] = headers;
            headersList[1] = count;
          });
        }
      }

      proxy.after(stream, 'end', function (obj, args, ret) {
        self.finalizeTransaction(null, profiler, time, transaction, req, ret);
      });

      if (self.agent.opts.btEntryPointDelayDisabled) {
        try {
          return callback.call(this, stream, headers);
        } catch (e) {
          self.finalizeTransaction(e, profiler, time, transaction, req, null);
          throw e;
        }
      }

      var delayedCallback = createBTCallback(self.agent,
        profiler,
        time,
        transaction,
        self.agent.thread,
        callback,
        self,
        this,
        req,
        stream,
        headers);

      transaction.once('ignoreTransactionCbExecute', delayedCallback);
      transaction.emit('delayedCallbackReady');
      transaction.once('btInfoResponse', delayedCallback);
      self.delayedCallbackQueue.push({ ts: Date.now(), func: delayedCallback });
    }
  };
};

Http2EntryProbe.prototype.finalizeTransaction = function (err, profiler, time, transaction, req, stream) {
  if (req['done'] || !time.done()) return;

  req['done'] = true;
  transaction.error = transaction.error || err;
  transaction.statusCode = transaction.statusCode ||
    transaction.error && transaction.error.statusCode ||
    stream && stream.sentHeaders && stream.sentHeaders[":status"] || 200;
  transaction.stackTrace = transaction.stackTrace || profiler.formatStackTrace(transaction.error);

  var error = HttpCommon.generateError(transaction.error, transaction.statusCode, this.statusCodesConfig);
  if (error) {
    transaction.error = error;
  }

  if (transaction.api && transaction.api.onResponseComplete) {
    transaction.api.onResponseComplete.apply(transaction.api, [stream]);
  }
  profiler.endTransaction(time, transaction);
};
