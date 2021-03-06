/*
Copyright (c) AppDynamics, Inc., and its affiliates
2015
All Rights Reserved
 */
'use strict';


function SocketioProbe(agent) {
  this.agent = agent;

  this.packages = ['socket.io'];
  this.attached = false;
}
exports.SocketioProbe = SocketioProbe;



SocketioProbe.prototype.attach = function(obj) {
  var self = this;
  var socketIOServer;

  if(obj.__appdynamicsProbeAttached__) return;
  obj.__appdynamicsProbeAttached__ = true;
  self.agent.on('destroy', function() {
    if(obj.__appdynamicsProbeAttached__) {
      delete obj.__appdynamicsProbeAttached__;
      proxy.release(obj.prototype.listen);
      proxy.release(obj.prototype.attach);
      if (socketIOServer) {
        Object.keys(socketIOServer.nsps).forEach(function(nameSpace) {
          delete socketIOServer.nsps[nameSpace].__appdynamicsProbeAttached__;
        });
      }
    }
  });

  var proxy = self.agent.proxy;

  var connectCount;
  var totalConnectCount;

  var metricsManager = self.agent.metricsManager;
  metricsManager.addMetric(metricsManager.SOCKETIO_CONNECTIONS,function() {
    return connectCount;
  });
  metricsManager.addMetric(metricsManager.SOCKETIO_CONNECTIONS_TOTAL, function() {
    return totalConnectCount;
  });
  var sentCountMetric = metricsManager.createMetric(metricsManager.SOCKETIO_MESSAGES_SENT);
  var receivedCountMetric = metricsManager.createMetric(metricsManager.SOCKETIO_MESSAGES_RECEIVED);
  var sentSizeMetric = metricsManager.createMetric(metricsManager.SOCKETIO_SENT_MESSAGES_SIZE);
  var receivedSizeMetric = metricsManager.createMetric(metricsManager.SOCKETIO_RECEIVED_MESSAGES_SIZE);

  proxy.after(obj.prototype, ['listen','attach'], function(obj, args, ret) {
    if(!ret.sockets) return;
    socketIOServer = ret;

    if(connectCount === undefined) {
      connectCount = totalConnectCount = 0;
    }

    proxy.after(ret, 'of', function(obj, args, ret) {
      if (ret.__appdynamicsProbeAttached__) return;
      attachProbeToNameSpace(ret);
      ret.__appdynamicsProbeAttached__ = true;
    });

    Object.keys(ret.nsps).forEach(function(nameSpace) {
      if (ret.nsps[nameSpace].__appdynamicsProbeAttached__) return;
      attachProbeToNameSpace(ret.nsps[nameSpace]);
      ret.nsps[nameSpace].__appdynamicsProbeAttached__ = true;
    });

    function attachProbeToNameSpace(nameSpaceObj) {
      proxy.before(nameSpaceObj, ['on', 'addListener'], function(obj, args) {
        if(args[0] !== 'connection') return;

        proxy.callback(args, -1, function(obj, args) {
          if(!args[0]) return;

          var socket = args[0];

          // conenctions
          connectCount++;
          totalConnectCount++;
          socket.on('disconnect', function() {
            connectCount--;
          });

          // sent messages
          proxy.before(socket, ['emit', 'send'], function(obj, args) {
            // ignore internal events
            if(args[0] === 'newListener') return;

            try {
              sentCountMetric.addValue(1);
              sentSizeMetric.addValue(typeof(args[1]) == 'string' ?
                args[1].length : JSON.stringify(args[1]).length);
            } catch (e) {
              // ignored; unable to serialize socket.io message
            }
          });

          // received messages
          proxy.before(socket, ['on', 'addListener'], function(obj, args) {
            // ignore internal events
            if(args[0] === 'disconnect') return;

            proxy.callback(args, -1, function(obj, args) {
              try {
                receivedCountMetric.addValue(1);
                receivedSizeMetric.addValue(typeof(args[0]) == 'string' ?
                  args[0].length : JSON.stringify(args[0]).length);
              } catch (e) {
                // ignored; unable to serialize socket.io message
              }
            });
          });
        });
      });
    }

  });
};
