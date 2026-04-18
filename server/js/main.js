var fs = require('fs'),
    path = require('path');

// Lightweight stand-in for the old `log` module — exposes .error/.info/.debug.
function makeLog(level) {
    var levels = { error: 0, warning: 1, warn: 1, info: 2, debug: 3 };
    var threshold = levels[level] != null ? levels[level] : levels.info;
    function emit(tag, lvl, args) {
        if (levels[lvl] > threshold) return;
        console.log('[' + new Date().toISOString() + '] [' + tag + ']', Array.prototype.slice.call(args).join(' '));
    }
    return {
        error:   function () { emit('ERROR', 'error', arguments); },
        warning: function () { emit(' WARN', 'warn',  arguments); },
        warn:    function () { emit(' WARN', 'warn',  arguments); },
        info:    function () { emit(' INFO', 'info',  arguments); },
        debug:   function () { emit('DEBUG', 'debug', arguments); }
    };
}

function main(config) {
    var ws = require("./ws"),
        WorldServer = require("./worldserver"),
        _ = require('underscore');

    // Make `log` globally available exactly like the original server expected.
    global.log = makeLog(config.debug_level || 'info');

    log.info("Starting TalonQuest game server...");

    var server = new ws.MultiVersionWebsocketServer(config.port);
    var worlds = [];

    server.onConnect(function (connection) {
        var world = _.detect(worlds, function (world) {
            return world.playerCount < config.nb_players_per_world;
        });
        if (!world) {
            log.warn("All worlds are full; rejecting a connection.");
            connection.close("All worlds are full.");
            return;
        }
        world.updatePopulation();
        world.connect_callback(new Player(connection, world));
    });

    server.onError(function () {
        log.error(Array.prototype.join.call(arguments, ", "));
    });

    _.each(_.range(config.nb_worlds), function (i) {
        var world = new WorldServer('world' + (i + 1), config.nb_players_per_world, server);
        world.run(config.map_filepath);
        worlds.push(world);
    });

    server.onRequestStatus(function () {
        return JSON.stringify(getWorldDistribution(worlds));
    });

    process.on('uncaughtException', function (e) {
        log.error('uncaughtException: ' + (e && e.stack ? e.stack : e));
    });
}

function getWorldDistribution(worlds) {
    return worlds.map(function (w) { return w.playerCount; });
}

function getConfigFile(p, callback) {
    fs.readFile(p, 'utf8', function (err, json) {
        if (err) { callback(null); return; }
        try { callback(JSON.parse(json)); }
        catch (e) { console.error("Malformed config " + p + ": " + e); callback(null); }
    });
}

var defaultConfigPath = path.resolve(__dirname, '..', 'config.json'),
    customConfigPath  = path.resolve(__dirname, '..', 'config_local.json');

process.argv.forEach(function (val, index) {
    if (index === 2) customConfigPath = val;
});

getConfigFile(defaultConfigPath, function (defaultConfig) {
    getConfigFile(customConfigPath, function (localConfig) {
        if (localConfig)       main(localConfig);
        else if (defaultConfig) main(defaultConfig);
        else {
            console.error("Server cannot start without any configuration file.");
            process.exit(1);
        }
    });
});
