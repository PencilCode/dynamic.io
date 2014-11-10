dynamic.io
==========
[![Build Status](https://travis-ci.org/PencilCode/dynamic.io.svg?branch=master)](https://travis-ci.org/PencilCode/dynamic.io)
[![NPM version](https://badge.fury.io/js/dynamic.io.svg)](http://badge.fury.io/js/dynamic.io)

dynamic.io is a subclass of the socket.io server that
knows how to deal with multiple hostnames and dynamically
created namespaces that delete themselves when idle.
It works with the standard socket.io client.

It also provides an optional socket.io/status page for debugging.

This subclass is perfectly usable as a standard socket.io server,
in the ordinary way (it passes socket.io unit tests, for example).
But it supports a few more options as well as the "setupNamespace"
method for handling namespace callbacks.

Dynamic namespaces can be set up using "setupNamespace", which
accepts a namespace name (or /.*/ for any-namespace, or any other
regexp to match regexps) and a callback that can initialize
a (passed) namespace instance when it is dynamically created.
(Or, if it's pre-existing at setupNamespace time.)  Return
false from this callback to reject the namespace.

New options include:
 * host (default /.*/) - set to the host name (or regexp) to direct
   to "/"; all other hosts will direct to namespaces "//host/namespace".
   To send all connections to fully qualified namespaces, set host:true.
 * publicStatus (default false) - set to true to serve a debugging
   page on socket.io/status
 * retirement (default 10000) - the number of milliseconds
   to wait after a namespace becomes empty until starting
   to consider deleting it.

If you find this useful, please contribute test, documentation, and fixes.

A usage example:

<pre>
// Specify host in options if you want to handle virtual hosts.
// Then only connections with a Host header matching host will
// map to "/".  (The default is /.*/, which maps all hosts to '/';
// host can be a string or a RegExp).  All other host namespaces
// will get a prefix of "//otherhost.com".  The Namespace method
// nsp.fullname() gets the fully qualified namespace name, while
// and nsp.name still // returns just '/' (or '/mynamespace')
// without the host; nsp.host returns the host.

io = require('dynamic.io')({host: 'myhost.com'});

// By the way, you can override gethost if you need to normalize.
io.getHost = function(conn) {
  return conn.request.headers.host.replace(/^www\./, '');
}

// Namespaces other than '/' are created and deleted dynamically.
// You can register namespaces with specific names, or with
// the '*' wildcard, and your setup function will be called whenever
// that namespace is created (or re-created after expiration).
io.setupNamespace('*', function(nsp) {
  // Set retirement to set up the number of milliseconds this
  // namespace should hang around after its last socket disconnects.
  // Default is 10 seconds.
  nsp.retirement = Math.max(nsp.retirement, 30 * 1000);
  // Set up the namespace as normal in socket.io.
  nsp.on('connect', function(socket) {
    console.log('got a socket connect on', nsp.fullname());
    socket.on('disconnect', function() {
      console.log('somebody disconnected from', nsp.fullname());
    });
  });
  // Return false from the setupNamespace callback if
  // you want to ignore this namespace.
  return true;
});

// Just use the server as normal.
io.listen(process.env.PORT);
</pre>
