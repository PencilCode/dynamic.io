dynamic.io
==========

dynamic.io is a subclass of the socket.io server that
knows how to deal with multiple hostnames and dynamically
created namespaces that delete themselves when idle.

It also provides an optional socket.io/status page for debugging.

This subclass should also be perfectly usable as a standard.io server,
in the ordinary way.  But it supports a few more options as well
as the "setupNamespace" method for handling namespace callbacks.

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

If you find this useful, please contribute tests and fixes.

A usage example:

<pre>
// Specify mainHost in options if you want to handle virtual hosts.
// Then only connections with a Host header matching mainHost will
// map to "/".  (The default is '*', which maps all hosts to '/').
// All other host namespaces will get a prefix of "//otherhost.com".
// The Namespace method nsp.fullname() gets the fully qualified
// namespace name. nsp.host returns the host, and nsp.name still
// returns just '/' (or '/mynamespace') without the host.

io = require('dynamic.io')({mainHost: 'myhost.com'});

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
