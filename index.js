/* dynamic.io.js, author: David Bau.

DynamicServer is a subclass of the socket.io Server that
knows how to deal with multiple hostnames and dynamically
created namespaces that delete themselves when idle.

It also provides an optional socket.io/status page for debugging.

The key new entrypoint for users is "setupNamespace", which
accepts a namespace name (or '*' for any-namespace) and
a callback that can initialize a (passed) namespace instance
when it is dynamically created.  Return false from this
callback to reject the namespace.

New options include:
 * mainHost (default '*') - set to a hostname if you want
   to differentiate between hosts.
 * publicStatus (default false) - set to true to serve a debugging
   page on socket.io/status
 * retirement (default 10000) - the number of milliseconds
   to wait after a namespace becomes empty until starting
   to consider deleting it.

*/


var util = require('util'),
    Emitter = require('events').EventEmitter,
    IOServer = require('socket.io'),
    IOClient = require('socket.io/lib/client'),
    IOSocket = require('socket.io/lib/socket'),
    IONamespace = require('socket.io/lib/namespace'),
    parser = require('socket.io-parser'),
    Adapter = require('socket.io-adapter'),
    debug = require('debug')('dynamic.io'),
    exports = DynamicServer;

function fullNamespaceName(name, host) {
  return host == null ? name : '//' + host + name;
}

function makePattern(pattern) {
  if (pattern === true) return new RegExp('.^');  // matches nothing.
  if (pattern === '*') return new RegExp('.*');
  if (pattern instanceof RegExp) return pattern;
  return pattern;
}

function matchPattern(pattern, str) {
  if (pattern instanceof RegExp) {
    return pattern.exec(str);
  } else {
    return pattern == str ? {'0': str, index: 0, input: str} : null;
  }
}

// Override constructor, to add new fields and options.
function DynamicServer(srv, opts) {
  if (!(this instanceof DynamicServer)) return new DynamicServer(srv, opts);
  var options = opts;
  if ('object' == typeof srv && !srv.listen) {
    options = srv;
  }
  options = options || {};

  this._cleanupTimer = null;
  this._cleanupTime = null;
  this._namepaceNames = {};
  this._namepacePatterns = [];

  // By default, serve all hosts as if they are the main host.
  this._mainHost = makePattern(options.host || '*');

  // By default, retire automatically created namespaces in 10 seconds.
  this._defaultRetirement = options.retirement || 10000;

  // By default, do not expose public /socket.io/status page.
  this._publicStatus = options.publicStatus || false;

  IOServer.apply(this, arguments);
}
util.inherits(DynamicServer, IOServer)
exports.DynamicServer = DynamicServer;

// This is the setup for initializing dynamic namespaces.
DynamicServer.prototype.setupNamespace = function(name, fn) {
  var pattern = makePattern(name);
  if (pattern instanceof RegExp) {
    this._namepacePatterns.push({pattern: pattern, setup: fn});
  } else {
    this._namepaceNames[name] = fn;
  }
  // If there is a matching namespace already, then set it up.
  for (var j in this.nsps) {
    if (this.nsps.hasOwnProperty(j)) {
      var nsp = this.nsps[j];
      if (!nsp.setupDone && !!(match = matchPattern(pattern, j))) {
        nsp.setupDone = -1;
        if (false === fn.apply(this, [nsp, match])) {
          // If setup is aborted, mark it as not-setup.
          nsp.setupDone = 0;
        } else {
          nsp.setupDone = 1;
        }
      }
    }
  }
};

// Create DynamicClient instead of IOClient when there is a connection.
DynamicServer.prototype.onconnection = function(conn) {
  var host = this.getHost(conn);
  var client = new DynamicClient(this, conn, host);
  client.connect('/');
  return this;
};

// Allow users to override this in order to normalize hostnames.
DynamicServer.prototype.getHost = function(conn) {
  if (matchPattern(this._mainHost, conn.request.headers.host)) {
    // The main host gets nulled out.
    return null;
  }
  return conn.request.headers.host;
};

// Do the work of initializing a namespace when it is needed.
DynamicServer.prototype.initializeNamespace = function(name, host, auto) {
  // First, look up our instructions for this namespace.
  var fullname = fullNamespaceName(name, host);
  var setup, match;
  if (this._namepaceNames.hasOwnProperty(fullname)) {
    // Prefer exact matches over pattern matches.
    setup = this._namepaceNames[fullname];
    match = {'0': fullname, index: 0, input: fullname};
  } else for (var j = this._namepacePatterns.length - 1; j >= 0; --j) {
    // Scan patterns starting with the last one registered.
    match = matchPattern(this._namepacePatterns[j].pattern, fullname);
    if (match) {
      setup = this._namepacePatterns[j].setup;
      break;
    }
  }
  // Automatically created namespaces require setup.
  if (auto && !setup) {
    return null;
  }

  // Create a namespace, register it, and call setup.
  var nsp = new DynamicNamespace(this, name, host);
  // Automatically created namespaces retire automatically.
  if (auto) {
    nsp.retirement = this._defaultRetirement;
  }
  this.nsps[fullname] = nsp;
  if (setup) {
    // During setup, setupDone is -1.
    nsp.setupDone = -1;
    if (false === setup.apply(this, [nsp, match])) {
      // If setup returns false, undo the operation and return null.
      delete this.nsps[fullname];
      return null;
    } else {
      // After setup, setupDone is 1.
      nsp.setupDone = 1;
    }
  }
  return nsp;
};

// When namespaces are emptied, they ask the server to poll
// them back for expiration.
DynamicServer.prototype.requestCleanupAfter = function(delay) {
  delay = Math.max(0, delay || 0);

  // This form check rejects both NaN and Infinity.
  if (!(delay < Infinity)) return;

  // If somebody has requested cleanup earlier, we should
  // redo the timer.
  var cleanupTime = delay + +(new Date);
  if (this._cleanupTimer && cleanupTime < this._cleanupTime) {
    clearTimeout(this._cleanupTimer);
    this._cleanupTimer = null;
  }

  // Don't check directly at the requested time, but up to 5s later.
  // That way, if a lot of namespaces expire around the same
  // time, we process them as a batch.
  delay += Math.max(1, Math.min(delay, 5000));

  if (!this._cleanupTimer) {
    var server = this;
    this._cleanupTime = cleanupTime;
    this._cleanupTimer = setTimeout(function() {
      server._cleanupTimer = null;
      server._cleanupTime = null;
      server.cleanupExpiredNamespaces();
    }, delay);
  }
};

// When doing cleanup, we scan all namespaces for their
// expiration dates.
DynamicServer.prototype.cleanupExpiredNamespaces = function() {
  var earliestUnexpired = Infinity;
  var now = +(new Date);
  for (var j in this.nsps) {
    if (this.nsps.hasOwnProperty(j)) {
      var nsp = this.nsps[j];
      var expiration = nsp._expiration();
      if (expiration <= now) {
        nsp.expire(true);
        delete this.nsps[j];
      } else  {
        earliestUnexpired = Math.min(earliestUnexpired, expiration);
      }
    }
  }
  this.requestCleanupAfter(earliestUnexpired - now);
};

// Override "of" to handle an optional 'host' argument
// an an "fn" of "true", which indicates a request for
// andautomatically created namespace.
DynamicServer.prototype.of = function(name, host, fn) {
  if (fn == null && typeof(host) == 'function') {
    fn = host;
    host = null;
  }
  if (!/^\//.test(name)) {
    // Insert a leading slash if needed.
    name = '/' + name;
  }

  // Add a leading hostname for lookup.
  var fullname = fullNamespaceName(name, host);
  if (!this.nsps[fullname]) {
    debug('initializing namespace %s', fullname);
    var nsp = this.initializeNamespace(name, host, fn === true);
    if (nsp == null) {
      debug('unrecognized namespace', fullname);
      return;
    }
  }
  if (typeof(fn) == 'function') this.nsps[fullname].on('connect', fn);
  return this.nsps[fullname];
};

// Hook in the /socket.io/status URL
DynamicServer.prototype.attachServe = function(srv) {
  debug('attaching web request handler');
  var prefix = this._path;
  var clienturl = prefix + '/socket.io.js';
  var statusurl = prefix + '/status';
  var evs = srv.listeners('request').slice(0);
  var self = this;
  srv.removeAllListeners('request');
  srv.on('request', function(req, res) {
    if (0 == req.url.indexOf(clienturl)) {
      self.serve(req, res);
    } else if (self._publicStatus && 0 == req.url.indexOf(statusurl)) {
      self.serveStatus(req, res);
    } else {
      for (var i = 0; i < evs.length; i++) {
        evs[i].call(srv, req, res);
      }
    }
  });
};

DynamicServer.prototype.serveStatus = function(req, res) {
  debug('serve status');
  var match = '*';
  if (!matchPattern(this._mainHost, req.headers.host)) {
    match = req.headers.host;
  }

  var html = ['<!doctype html>', '<html>', '<body>', '<pre>'];
  html.push('<a href="status">Refresh</a> active namespaces on ' + match, '');
  var sorted = [];
  for (var j in this.nsps) {
    if (this.nsps.hasOwnProperty(j)) {
      var nsp = this.nsps[j];
      if (match != '*' && nsp.host != match) continue;
      sorted.push(j);
    }
  }
  sorted.sort(function(a, b) {
    // Sort slashes last.
    if (a == b) return 0;
    a = a.replace(/\//g, '\uffff');
    b = b.replace(/\//g, '\uffff');
    if (a < b) return -1;
    else return 1;
  });
  var now = +(new Date);
  for (j = 0; j < sorted.length; ++j) {
    var nsp = this.nsps[sorted[j]];
    html.push(match == '*' ? nsp.fullname() : nsp.name);
    if (nsp.rooms && nsp.rooms.length > 1) {
      html.push('  rooms: ' + nsp.rooms.join(' '));
    }
    if (nsp.sockets.length == 0) {
      var remaining = nsp._expiration() - now;
      var expinfo = '';
      if (remaining < Infinity) {
        expinfo = '; expires ' + remaining / 1000 + 's';
      }
      html.push('  (no sockets' + expinfo + ')');
    } else for (var k = 0; k < nsp.sockets.length; ++k) {
      var socket = nsp.sockets[k];
      var clientdesc = '';
      if (socket.request.connection.remoteAddress) {
        clientdesc += ' from ' + socket.request.connection.remoteAddress;
      }
      var roomdesc = '';
      if (socket.rooms.length > 1) {
        for (var m = 0; m < socket.rooms.length; ++m) {
          if (socket.rooms[m] != socket.client.id) {
            roomdesc += ' ' + socket.rooms[m];
          }
        }
      }
      html.push(' socket ' + socket.id + clientdesc + roomdesc);
    }
    html.push('');
  }
  res.setHeader('Content-Type', 'text/html');
  res.writeHead(200);
  res.end(html.join('\n'));
};

// This subclass relies on "of" to make a namespace.
function DynamicClient(server, conn, host) {
  IOClient.apply(this, arguments);
  this.host = host;
}
util.inherits(DynamicClient, IOClient)
exports.DynamicClient = DynamicClient;

// Add hostname to namespace even if it doesn't yet exist.
DynamicClient.prototype.connect = function(name) {
  debug('connecting to namespace %s (%s)', name, this.host);
  var nsp = this.server.of(name, this.host, true);
  if (nsp == null) {
    this.packet({ type: parser.ERROR, nsp: name, data : 'Invalid namespace'});
    return;
  }
  if (name != '/' && !this.nsps['/']) {
    this.connectBuffer.push(name);
    return;
  }
  var self = this;
  var socket = nsp.add(this, function() {
    self.sockets.push(socket);
    debug('client %s adding socket as self.nsps[%s]', self.id, name);
    self.nsps[name] = socket;
    if (name == '/' && self.connectBuffer.length > 0) {
      self.connectBuffer.forEach(self.connect, self);
      self.connectBuffer = [];
    }
  });
};

// Start ids at some big number instead of 0.
// Tell server to delete me after I have no sockets.
function DynamicNamespace(server, name, host) {
  IONamespace.apply(this, arguments);
  // Remember the host name.
  this.host = host;
  // Only call setup once.
  this.setupDone = 0;
  // Default retirement is "Infinity", but will be reduced to 10s
  // for dynamically created namespaces.
  this.retirement = Infinity;
  // Choose one of a billion starting ids to reduce collisions
  // when a namespace restarts.
  this.ids = Math.floor(Math.random() * 1000000000);
  // Set the expiration date to never.
  this._expirationTime = Infinity;
  // No expiration callback by default.
  this._expirationCallbacks = null;
}
util.inherits(DynamicNamespace, IONamespace)
exports.DynamicNamespace = DynamicNamespace;

// At the end of remove, request cleanup if there
// are no sockets.
DynamicNamespace.prototype.remove = function(socket) {
  IONamespace.prototype.remove.apply(this, arguments);
  if (!this.sockets.length) {
    // Once a namespace is empty, it goes into a period of retirement,
    // after which it may be deleted.  Set the expiration for 10
    // seconds from now.
    this._expirationTime = +(new Date) + this.retirement;
    this.server.requestCleanupAfter(this.retirement);
  }
};

// Set up expire callbacks.
DynamicNamespace.prototype.expire = function(callback) {
  if (callback !== true) {
    if (!this._expirationCallbacks) {
      this._expirationCallbacks = [];
    }
    this._expirationCallbacks.push(callback);
  } else {
    // expire(true) is an internal convention for
    // triggering the expiration callbacks.
    var callbacks = this._expirationCallbacks;
    if (callbacks) {
      this._expirationCallbacks = null;
      while (callbacks.length > 0) {
        callbacks.pop().apply(null, [this]);
      }
    }
  }
}

// Concatenate host and name for the full namespace name.
DynamicNamespace.prototype.fullname = function() {
  return fullNamespaceName(this.name, this.host);
};

// After there are no sockets, each namespace has an
// expiration time.
DynamicNamespace.prototype._expiration = function() {
  if (this.sockets.length) return Infinity;
  return this._expirationTime;
};

// When we have a socket added, we are no longer in retirement,
// so reset our expirationTime.  Back in business!
DynamicNamespace.prototype.add = function() {
  this._expirationTime = Infinity;
  return IONamespace.prototype.add.apply(this, arguments);
};

exports.DynamicSocket = IOSocket;

module.exports = exports;
