
var url = require('url');
var HttpCommon = require('./http-common');

function Http2ExitProbe(agent) {
  this.agent = agent;
}

exports.Http2ExitProbe = Http2ExitProbe;

Http2ExitProbe.prototype.init = function() {};

Http2ExitProbe.prototype.attach = function(obj) {
  var self = this;
  var profiler = self.agent.profiler;
  self.agent.proxy.after(obj, 'connect', function (obj, args, ret) {
    var urlString = args[0];
    self.agent.proxy.around(ret, 'request', function (obj, args, locals) {
      self.parseUrl(locals, urlString);
      var headers = args[0] || {};
      locals.opts.path = args[0] && args[0].path || '/'; 
      locals.time = self.agent.profiler.time();
      locals.headers = headers;

      self.agent.metricsManager.addMetric(self.agent.metricsManager.HTTP_OUTGOING_COUNT, 1);
      var host = locals.opts.hostname;
      var port = locals.opts.port;
      var path = locals.opts.path;

      var supportedProperties = {
        'HOST': host,
        'PORT': port
      };

      if (self.agent.backendConfig.isParsedUrlRequired()) {
        var parsedUrl = url.parse(path);
        supportedProperties.URL = parsedUrl.pathname;
        if (parsedUrl.query) {
          supportedProperties['QUERY STRING'] = parsedUrl.query;
        }
      }

      locals.exitCall = profiler.createExitCall(locals.time, {
        exitType: 'EXIT_HTTP',
        supportedProperties: supportedProperties,
        stackTrace: profiler.stackTrace(),
        group: (locals.opts.method || 'GET'),
        command: host + ':' + port + path,
        requestHeaders: locals.opts.headers
      });

      if (!locals.exitCall) return;

      Error.captureStackTrace(locals.exitCall);
      if(headers && locals.exitCall) {
        var correlationHeaderValue = self.agent.backendConnector.getCorrelationHeader(locals.exitCall);
        if(correlationHeaderValue) headers[self.agent.correlation.HEADER_NAME] = correlationHeaderValue;
      }
      if (args.length) {
        return args;
      } else {
        return [headers];
      }
    },
    function (obj, args, ret, locals) {
      ret.on('close', function() {
        self.endExitCall(locals);
      });

      ret.on('error', function (error) {
        locals.error = error;
        self.endExitCall(locals);
      });

      ret.on('response', function (headers) {
        locals.responseHeaders = headers;
      });
    });
  });
};

Http2ExitProbe.prototype.endExitCall = function(locals) {
  var self = this;
  if(!locals.time.done()) return;

  var exitCall = locals.exitCall;
  var error = locals.error;

  if(exitCall) {
    if(locals.responseHeaders) {
      exitCall.responseHeaders = locals.responseHeaders;
      exitCall.statusCode = locals.responseHeaders[':status'];
      if((!error) && ((exitCall.statusCode < 200) || (exitCall.statusCode >= 400))) {
        error = HttpCommon.getHttpExitCallError(exitCall.statusCode, exitCall.stack, locals);
      }
    }
  }

  self.agent.profiler.addExitCall(locals.time, exitCall, error);
};

Http2ExitProbe.prototype.parseUrl = function(locals, spec) {
  if(typeof(spec) === 'string') {
    locals.opts = url.parse(spec);
  }
  else {
    locals.opts = spec;
  }

  locals.opts.hostname = locals.opts.hostname || locals.opts.host || 'localhost';
  locals.opts.port = locals.opts.port || (locals.opts.protocol && (locals.opts.protocol == 'https:') ? 443  : 80);
  locals.opts.path = locals.opts.path || '/';
};