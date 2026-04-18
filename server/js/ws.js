// TalonQuest: drop-in replacement for the original BrowserQuest ws.js adapter.
// Uses the modern `ws` package and also serves the client static files so a
// single `npm start` boots the whole game.

var cls = require("./lib/class"),
    http = require('http'),
    fs = require('fs'),
    path = require('path'),
    url = require('url'),
    _ = require('underscore'),
    WebSocket = require('ws'),
    WS = {};

module.exports = WS;

var CLIENT_ROOT = path.resolve(__dirname, '..', '..', 'client');
var SHARED_ROOT = path.resolve(__dirname, '..', '..', 'shared');

var MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.ttf':  'font/ttf',
    '.otf':  'font/otf',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.json': 'application/json; charset=utf-8',
    '.mp3':  'audio/mpeg',
    '.ogg':  'audio/ogg',
    '.map':  'application/json; charset=utf-8'
};

function safeResolve(root, requested) {
    var resolved = path.resolve(root, '.' + requested);
    if (resolved.indexOf(root) !== 0) return null;
    return resolved;
}

function serveStatic(req, res, statusCallback) {
    var parsed = url.parse(req.url).pathname || '/';

    if (parsed === '/status' && statusCallback) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(statusCallback());
        return;
    }

    var root = CLIENT_ROOT;
    var requested = parsed;
    if (requested.indexOf('/shared/') === 0) {
        root = SHARED_ROOT;
        requested = requested.slice('/shared'.length);
    }
    if (requested === '/' || requested === '') requested = '/index.html';

    var filePath = safeResolve(root, requested);
    if (!filePath) { res.writeHead(403); res.end('Forbidden'); return; }

    fs.stat(filePath, function (err, stat) {
        if (err || !stat.isFile()) { res.writeHead(404); res.end('Not Found'); return; }
        var ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
    });
}

var Server = cls.Class.extend({
    init: function (port) { this.port = port; },
    onConnect: function (cb) { this.connection_callback = cb; },
    onError: function (cb) { this.error_callback = cb; },
    broadcast: function () { throw "Not implemented"; },
    forEachConnection: function (cb) { _.each(this._connections, cb); },
    addConnection: function (c) { this._connections[c.id] = c; },
    removeConnection: function (id) { delete this._connections[id]; },
    getConnection: function (id) { return this._connections[id]; }
});

var Connection = cls.Class.extend({
    init: function (id, socket, server) {
        this._socket = socket;
        this._server = server;
        this.id = id;
    },
    onClose: function (cb) { this.close_callback = cb; },
    listen: function (cb) { this.listen_callback = cb; },
    send: function (message) { this.sendUTF8(JSON.stringify(message)); },
    sendUTF8: function (data) {
        if (this._socket.readyState === WebSocket.OPEN) this._socket.send(data);
    },
    close: function (reason) {
        if (typeof log !== 'undefined' && log && log.info) {
            log.info("Closing connection. Reason: " + reason);
        }
        try { this._socket.close(); } catch (e) {}
    }
});

WS.MultiVersionWebsocketServer = Server.extend({
    _connections: {},
    _counter: 0,

    init: function (port) {
        var self = this;
        this._super(port);

        this._httpServer = http.createServer(function (req, res) {
            serveStatic(req, res, self.status_callback);
        });

        this._wss = new WebSocket.Server({
            server: this._httpServer,
            // perMessageDeflate cuts game-state bandwidth ~60–80% at the cost
            // of some CPU. The thresholds/levels below are tuned to skip tiny
            // messages (cheaper to send uncompressed) and avoid pathological
            // memory use on a shared-vCPU VM.
            perMessageDeflate: {
                zlibDeflateOptions: { level: 3, memLevel: 7 },
                zlibInflateOptions: { chunkSize: 10 * 1024 },
                clientNoContextTakeover: true,
                serverNoContextTakeover: true,
                threshold: 512
            }
        });

        this._wss.on('connection', function (socket, req) {
            socket.remoteAddress = (req && req.socket && req.socket.remoteAddress) || '';
            var conn = new WS.ModernWebSocketConnection(self._createId(), socket, self);
            if (self.connection_callback) self.connection_callback(conn);
            self.addConnection(conn);
        });

        this._httpServer.listen(port, function () {
            if (typeof log !== 'undefined' && log && log.info) {
                log.info("TalonQuest listening on http://localhost:" + port);
            } else {
                console.log("TalonQuest listening on http://localhost:" + port);
            }
        });
    },

    _createId: function () {
        return '5' + Math.floor(Math.random() * 100) + '' + (this._counter++);
    },

    broadcast: function (message) {
        this.forEachConnection(function (c) { c.send(message); });
    },

    onRequestStatus: function (cb) { this.status_callback = cb; }
});

WS.ModernWebSocketConnection = Connection.extend({
    init: function (id, socket, server) {
        var self = this;
        this._super(id, socket, server);

        this._socket.on('message', function (raw) {
            if (!self.listen_callback) return;
            var text = raw && raw.toString ? raw.toString() : String(raw);
            try {
                self.listen_callback(JSON.parse(text));
            } catch (e) {
                if (e instanceof SyntaxError) {
                    self.close("Received message was not valid JSON.");
                } else {
                    throw e;
                }
            }
        });

        this._socket.on('close', function () {
            if (self.close_callback) self.close_callback();
            self._server.removeConnection(self.id);
        });

        this._socket.on('error', function () {});
    }
});
