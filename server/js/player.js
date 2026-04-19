
var cls = require("./lib/class"),
    _ = require("underscore"),
    Messages = require("./message"),
    Utils = require("./utils"),
    Properties = require("./properties"),
    Formulas = require("./formulas"),
    check = require("./format").check,
    Types = require("../../shared/js/gametypes");

module.exports = Player = Character.extend({
    init: function(connection, worldServer) {
        var self = this;
        
        this.server = worldServer;
        this.connection = connection;

        this._super(this.connection.id, "player", Types.Entities.WARRIOR, 0, 0, "");

        this.hasEnteredGame = false;
        this.isDead = false;
        this.haters = {};
        this.lastCheckpoint = null;
        this.formatChecker = new FormatChecker();
        this.disconnectTimeout = null;
        
        this.connection.listen(function(message) {
            var action = parseInt(message[0]);
            
            log.debug("Received: "+message);
            if(!check(message)) {
                self.connection.close("Invalid "+Types.getMessageTypeAsString(action)+" message format: "+message);
                return;
            }
            
            if(!self.hasEnteredGame && action !== Types.Messages.HELLO) { // HELLO must be the first message
                self.connection.close("Invalid handshake message: "+message);
                return;
            }
            if(self.hasEnteredGame && !self.isDead && action === Types.Messages.HELLO) { // HELLO can be sent only once
                self.connection.close("Cannot initiate handshake twice: "+message);
                return;
            }
            
            self.resetTimeout();
            
            if(action === Types.Messages.HELLO) {
                var name = Utils.sanitize(message[1]);
                
                // If name was cleared by the sanitizer, give a default name.
                // Always ensure that the name is not longer than a maximum length.
                // (also enforced by the maxlength attribute of the name input element).
                self.name = (name === "") ? "lorem ipsum" : name.substr(0, 15);
                
                self.kind = Types.Entities.WARRIOR;
                self.equipArmor(message[2]);
                self.equipWeapon(message[3]);
                self.orientation = Utils.randomOrientation();
                self.updateHitPoints();
                self.updatePosition();
                
                self.server.addPlayer(self);
                self.server.enter_callback(self);

                self.send([Types.Messages.WELCOME, self.id, self.name, self.x, self.y, self.hitPoints]);
                self.hasEnteredGame = true;
                self.isDead = false;

                // Initialize Wild-zone state so banner toggling on the client
                // starts from the correct position.
                self.inWild = Player.isInWild(self.x, self.y);
                if(self.inWild) {
                    self.server.pushToPlayer(self, new Messages.Chat(self, "[WILD_ENTER]"));
                }
            }
            else if(action === Types.Messages.WHO) {
                message.shift();
                self.server.pushSpawnsToPlayer(self, message);
            }
            else if(action === Types.Messages.ZONE) {
                self.zone_callback();
            }
            else if(action === Types.Messages.CHAT) {
                var rawMsg = message[1];
                if(typeof rawMsg === 'string' && rawMsg.charAt(0) === '/') {
                    // Commands aren't broadcast as chat.
                    var cmd = rawMsg.trim().toLowerCase();
                    if(cmd === '/fish' || cmd === '/cast') {
                        self.tryFish();
                    }
                } else {
                    var msg = Utils.sanitize(rawMsg);

                    // Sanitized messages may become empty. No need to broadcast empty chat messages.
                    if(msg && msg !== "") {
                        msg = msg.substr(0, 60); // Enforce maxlength of chat input
                        self.broadcastToZone(new Messages.Chat(self, msg), false);
                    }
                }
            }
            else if(action === Types.Messages.MOVE) {
                if(self.move_callback) {
                    var x = message[1],
                        y = message[2];

                    if(self.server.isValidPosition(x, y)) {
                        var wasInWild = !!self.inWild;
                        self.setPosition(x, y);
                        self.clearTarget();

                        self.inWild = Player.isInWild(x, y);
                        if(self.inWild && !wasInWild) {
                            self.server.pushToPlayer(self, new Messages.Chat(self, "[WILD_ENTER]"));
                        } else if(!self.inWild && wasInWild) {
                            self.server.pushToPlayer(self, new Messages.Chat(self, "[WILD_LEAVE]"));
                        }

                        self.broadcast(new Messages.Move(self));
                        self.move_callback(self.x, self.y);
                    }
                }
            }
            else if(action === Types.Messages.LOOTMOVE) {
                if(self.lootmove_callback) {
                    self.setPosition(message[1], message[2]);
                    
                    var item = self.server.getEntityById(message[3]);
                    if(item) {
                        self.clearTarget();

                        self.broadcast(new Messages.LootMove(self, item));
                        self.lootmove_callback(self.x, self.y);
                    }
                }
            }
            else if(action === Types.Messages.AGGRO) {
                if(self.move_callback) {
                    self.server.handleMobHate(message[1], self.id, 5);
                }
            }
            else if(action === Types.Messages.ATTACK) {
                var mob = self.server.getEntityById(message[1]);
                
                if(mob) {
                    self.setTarget(mob);
                    self.server.broadcastAttacker(self);
                }
            }
            else if(action === Types.Messages.HIT) {
                var target = self.server.getEntityById(message[1]);
                if(target) {
                    if(target.type === "player") {
                        // Player-vs-player combat is only allowed inside The Wild.
                        if(Player.isInWild(self.x, self.y) && Player.isInWild(target.x, target.y) && target.id !== self.id) {
                            var pvpDmg = Formulas.dmg(self.weaponLevel, target.armorLevel);
                            if(pvpDmg > 0 && target.hitPoints > 0) {
                                target.hitPoints -= pvpDmg;
                                self.server.pushToPlayer(self, new Messages.Damage(target, pvpDmg));
                                self.server.handleHurtEntity(target, self, pvpDmg);
                                if(target.hitPoints <= 0) {
                                    target.isDead = true;
                                }
                            }
                        }
                    } else {
                        var dmg = Formulas.dmg(self.weaponLevel, target.armorLevel);

                        if(dmg > 0) {
                            var wasAlive = target.hitPoints > 0;
                            target.receiveDamage(dmg, self.id);
                            self.server.handleMobHate(target.id, self.id, dmg);
                            self.server.handleHurtEntity(target, self, dmg);
                            if(wasAlive && target.hitPoints <= 0 && self.onKill) {
                                self.onKill(target);
                            }
                        }
                    }
                }
            }
            else if(action === Types.Messages.HURT) {
                var mob = self.server.getEntityById(message[1]);
                if(mob && self.hitPoints > 0) {
                    self.hitPoints -= Formulas.dmg(mob.weaponLevel, self.armorLevel);
                    self.server.handleHurtEntity(self);
                    
                    if(self.hitPoints <= 0) {
                        self.isDead = true;
                        if(self.firepotionTimeout) {
                            clearTimeout(self.firepotionTimeout);
                        }
                    }
                }
            }
            else if(action === Types.Messages.LOOT) {
                var item = self.server.getEntityById(message[1]);
                
                if(item) {
                    var kind = item.kind;
                    
                    if(Types.isItem(kind)) {
                        self.broadcast(item.despawn());
                        self.server.removeEntity(item);
                        
                        if(kind === Types.Entities.FIREPOTION) {
                            self.updateHitPoints();
                            self.broadcast(self.equip(Types.Entities.FIREFOX));
                            self.firepotionTimeout = setTimeout(function() {
                                self.broadcast(self.equip(self.armor)); // return to normal after 15 sec
                                self.firepotionTimeout = null;
                            }, 15000);
                            self.send(new Messages.HitPoints(self.maxHitPoints).serialize());
                        } else if(Types.isHealingItem(kind)) {
                            var amount;
                            
                            switch(kind) {
                                case Types.Entities.FLASK: 
                                    amount = 40;
                                    break;
                                case Types.Entities.BURGER: 
                                    amount = 100;
                                    break;
                            }
                            
                            if(!self.hasFullHealth()) {
                                self.regenHealthBy(amount);
                                self.server.pushToPlayer(self, self.health());
                            }
                        } else if(Types.isArmor(kind) || Types.isWeapon(kind)) {
                            self.equipItem(item);
                            self.broadcast(self.equip(kind));
                        }
                    }
                }
            }
            else if(action === Types.Messages.TELEPORT) {
                var x = message[1],
                    y = message[2];
                
                if(self.server.isValidPosition(x, y)) {
                    self.setPosition(x, y);
                    self.clearTarget();
                    
                    self.broadcast(new Messages.Teleport(self));
                    
                    self.server.handlePlayerVanish(self);
                    self.server.pushRelevantEntityListTo(self);
                }
            }
            else if(action === Types.Messages.OPEN) {
                var chest = self.server.getEntityById(message[1]);
                if(chest && chest instanceof Chest) {
                    self.server.handleOpenedChest(chest, self);
                }
            }
            else if(action === Types.Messages.CHECK) {
                var checkpoint = self.server.map.getCheckpoint(message[1]);
                if(checkpoint) {
                    self.lastCheckpoint = checkpoint;
                }
            }
            else {
                if(self.message_callback) {
                    self.message_callback(message);
                }
            }
        });
        
        this.connection.onClose(function() {
            if(self.firepotionTimeout) {
                clearTimeout(self.firepotionTimeout);
            }
            clearTimeout(self.disconnectTimeout);
            if(self.exit_callback) {
                self.exit_callback();
            }
        });
        
        this.connection.sendUTF8("go"); // Notify client that the HELLO/WELCOME handshake can start
    },
    
    destroy: function() {
        var self = this;
        
        this.forEachAttacker(function(mob) {
            mob.clearTarget();
        });
        this.attackers = {};
        
        this.forEachHater(function(mob) {
            mob.forgetPlayer(self.id);
        });
        this.haters = {};
    },
    
    getState: function() {
        var basestate = this._getBaseState(),
            state = [this.name, this.orientation, this.armor, this.weapon];

        if(this.target) {
            state.push(this.target);
        }
        
        return basestate.concat(state);
    },
    
    send: function(message) {
        this.connection.send(message);
    },
    
    broadcast: function(message, ignoreSelf) {
        if(this.broadcast_callback) {
            this.broadcast_callback(message, ignoreSelf === undefined ? true : ignoreSelf);
        }
    },
    
    broadcastToZone: function(message, ignoreSelf) {
        if(this.broadcastzone_callback) {
            this.broadcastzone_callback(message, ignoreSelf === undefined ? true : ignoreSelf);
        }
    },
    
    onExit: function(callback) {
        this.exit_callback = callback;
    },
    
    onMove: function(callback) {
        this.move_callback = callback;
    },
    
    onLootMove: function(callback) {
        this.lootmove_callback = callback;
    },
    
    onZone: function(callback) {
        this.zone_callback = callback;
    },
    
    onOrient: function(callback) {
        this.orient_callback = callback;
    },
    
    onMessage: function(callback) {
        this.message_callback = callback;
    },
    
    onBroadcast: function(callback) {
        this.broadcast_callback = callback;
    },
    
    onBroadcastToZone: function(callback) {
        this.broadcastzone_callback = callback;
    },
    
    equip: function(item) {
        return new Messages.EquipItem(this, item);
    },
    
    addHater: function(mob) {
        if(mob) {
            if(!(mob.id in this.haters)) {
                this.haters[mob.id] = mob;
            }
        }
    },
    
    removeHater: function(mob) {
        if(mob && mob.id in this.haters) {
            delete this.haters[mob.id];
        }
    },
    
    forEachHater: function(callback) {
        _.each(this.haters, function(mob) {
            callback(mob);
        });
    },
    
    equipArmor: function(kind) {
        this.armor = kind;
        this.armorLevel = Properties.getArmorLevel(kind);
    },
    
    equipWeapon: function(kind) {
        this.weapon = kind;
        this.weaponLevel = Properties.getWeaponLevel(kind);
    },
    
    equipItem: function(item) {
        if(item) {
            log.debug(this.name + " equips " + Types.getKindAsString(item.kind));
            
            if(Types.isArmor(item.kind)) {
                this.equipArmor(item.kind);
                this.updateHitPoints();
                this.send(new Messages.HitPoints(this.maxHitPoints).serialize());
            } else if(Types.isWeapon(item.kind)) {
                this.equipWeapon(item.kind);
            }
        }
    },
    
    updateHitPoints: function() {
        this.resetHitPoints(Formulas.hp(this.armorLevel));
    },
    
    updatePosition: function() {
        if(this.requestpos_callback) {
            var pos = this.requestpos_callback();
            this.setPosition(pos.x, pos.y);
        }
    },
    
    onRequestPosition: function(callback) {
        this.requestpos_callback = callback;
    },
    
    resetTimeout: function() {
        clearTimeout(this.disconnectTimeout);
        this.disconnectTimeout = setTimeout(this.timeout.bind(this), 1000 * 60 * 15); // 15 min.
    },
    
    timeout: function() {
        this.connection.sendUTF8("timeout");
        this.connection.close("Player was idle for too long");
    },

    // Called once on the killing blow against a mob. Maintains a kill counter
    // and, at set thresholds, bumps the player up the weapon ladder and fully
    // heals them. Broadcasts the equip change so nearby players see the new
    // sprite, and pushes a chat message to the killer announcing the level.
    onKill: function(mob) {
        if(!mob || mob.type !== 'mob') { return; }
        this.kills = (this.kills || 0) + 1;

        // Weapon progression: every 3 kills grants the next rung, capping out
        // at BLUESWORD. Starter is SWORD1 (tier 0); after 3 kills -> SWORD2.
        var ladder = Player.WEAPON_LADDER;
        var tier = Math.min(Math.floor(this.kills / 3), ladder.length - 1);
        var desired = ladder[tier];
        if(desired !== this.weapon) {
            this.equipWeapon(desired);
            this.updateHitPoints();
            this.hitPoints = this.maxHitPoints;
            this.broadcast(this.equip(desired));
            this.send(new Messages.HitPoints(this.maxHitPoints).serialize());
            this.server.pushToPlayer(this, this.health());
            this.server.pushToPlayer(this, new Messages.Chat(this,
                "\uD83D\uDDE1 Strength increased! You wield " + Types.getKindAsString(desired).toUpperCase() + "."));
        } else {
            this.server.pushToPlayer(this, new Messages.Chat(this,
                "You've slain " + this.kills + " foes. (" + (3 - (this.kills % 3)) + " more for a stronger weapon)"));
        }
    },

    // Fishing: a small rod-cast action that heals the player on a cooldown.
    // Broadcasts flavor text to the zone so other players see the action.
    tryFish: function() {
        var now = Date.now();
        var cooldownMs = 6000;
        if(this.isDead) { return; }
        if(this.nextFishAt && now < this.nextFishAt) {
            var secs = Math.ceil((this.nextFishAt - now) / 1000);
            this.server.pushToPlayer(this, new Messages.Chat(this, "Your line is still settling (" + secs + "s)."));
            return;
        }
        this.nextFishAt = now + cooldownMs;

        var healAmount = Math.max(20, Math.floor(this.maxHitPoints * 0.35));
        var before = this.hitPoints;
        if(!this.hasFullHealth()) {
            this.regenHealthBy(healAmount);
            this.server.pushToPlayer(this, this.regen());
        }
        var gained = this.hitPoints - before;

        this.broadcastToZone(new Messages.Chat(this, "*casts a line and reels in a silver trout*"), false);
        if(gained > 0) {
            this.server.pushToPlayer(this, new Messages.Chat(this, "The fish restored " + gained + " HP."));
        } else {
            this.server.pushToPlayer(this, new Messages.Chat(this, "You were already at full health."));
        }
    }
});

// Weapon progression ladder — each kill multiple of 3 advances the player.
Player.WEAPON_LADDER = [
    Types.Entities.SWORD1,
    Types.Entities.SWORD2,
    Types.Entities.AXE,
    Types.Entities.MORNINGSTAR,
    Types.Entities.BLUESWORD,
    Types.Entities.REDSWORD,
    Types.Entities.GOLDENSWORD
];

// The Wild: a PvP-enabled biome in the far east of the map, well away from
// the starting checkpoints so new players aren't thrown into PvP on spawn.
Player.WILD = { x1: 110, y1: 1, x2: 171, y2: 313 };
Player.isInWild = function(x, y) {
    var w = Player.WILD;
    return x >= w.x1 && x <= w.x2 && y >= w.y1 && y <= w.y2;
};