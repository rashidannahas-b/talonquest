
define(function() {

    var Camera = Class.extend({
        init: function(renderer) {
            this.renderer = renderer;
            this.x = 0;
            this.y = 0;
            this.gridX = 0;
            this.gridY = 0;
            this.offset = 0.5;
            this.rescale();
        },
    
        rescale: function() {
            // TalonQuest: size the viewport to the actual browser window
            // instead of the hard-coded 15x7 tile grid.
            var renderer = this.renderer,
                scale = (renderer && renderer.scale) ? renderer.scale
                      : (renderer && renderer.getScaleFactor ? renderer.getScaleFactor() : 2),
                ts = 16 * scale,
                w = (typeof window !== 'undefined') ? window.innerWidth  : 960,
                h = (typeof window !== 'undefined') ? window.innerHeight : 540;

            this.gridW = Math.max(15, Math.ceil(w / ts));
            this.gridH = Math.max(10, Math.ceil(h / ts));

            log.debug("Camera " + this.gridW + "x" + this.gridH + " tiles (scale " + scale + ")");
        },

        setPosition: function(x, y) {
            this.x = x;
            this.y = y;
    
            this.gridX = Math.floor( x / 16 );
            this.gridY = Math.floor( y / 16 );
        },

        setGridPosition: function(x, y) {
            this.gridX = x;
            this.gridY = y;
        
            this.x = this.gridX * 16;
            this.y = this.gridY * 16;
        },

        lookAt: function(entity) {
            var r = this.renderer,
                x = Math.round( entity.x - (Math.floor(this.gridW / 2) * r.tilesize) ),
                y = Math.round( entity.y - (Math.floor(this.gridH / 2) * r.tilesize) );
    
            this.setPosition(x, y);
        },

        forEachVisiblePosition: function(callback, extra) {
            var extra = extra || 0;
            for(var y=this.gridY-extra, maxY=this.gridY+this.gridH+(extra*2); y < maxY; y += 1) {
                for(var x=this.gridX-extra, maxX=this.gridX+this.gridW+(extra*2); x < maxX; x += 1) {
                    callback(x, y);
                }
            }
        },
        
        isVisible: function(entity) {
            return this.isVisiblePosition(entity.gridX, entity.gridY);
        },
        
        isVisiblePosition: function(x, y) {
            if(y >= this.gridY && y < this.gridY + this.gridH
            && x >= this.gridX && x < this.gridX + this.gridW) {
                return true;
            } else {
                return false;
            }
        },
    
        focusEntity: function(entity) {
            var w = this.gridW - 2,
                h = this.gridH - 2,
                x = Math.floor((entity.gridX - 1) / w) * w,
                y = Math.floor((entity.gridY - 1) / h) * h;

            this.setGridPosition(x, y);
        }
    });

    return Camera;
});
