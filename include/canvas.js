/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2010 Joel Martin
 * Licensed under LGPL-3 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 */

"use strict";
/*jslint browser: true, white: false, bitwise: false */
/*global window, Util */

function Canvas(conf) {

conf               = conf || {}; // Configuration
var that           = {},         // Public API interface

    // Pre-declare functions used before definitions (jslint)jslint
    setFillColor, fillRect,

    // Private Canvas namespace variables
    c_forceCanvas = false,

    c_width        = 0,
    c_height       = 0,

    c_prevStyle    = "",

    c_keyPress     = null,
    c_mouseButton  = null,
    c_mouseMove    = null;


// Configuration settings
function cdef(v, type, defval, desc) {
    Util.conf_default(conf, that, v, type, defval, desc); }

// Capability settings, default can be overridden
cdef('target',         'dom',  null, 'Canvas element for VNC viewport');
cdef('focusContainer', 'dom',  document, 'DOM element that traps keyboard input');
cdef('focused',        'bool', true, 'Capture and send key strokes');
cdef('scale',          'float', 1, 'VNC viewport scale factor');

cdef('render_mode',    'str', '', 'Canvas rendering mode (read-only)');

that.set_render_mode = function () { throw("render_mode is read-only"); };

// Add some other getters/setters
that.get_width = function() {
    return c_width;
};
that.get_height = function() {
    return c_height;
};



//
// Private functions
//

// Create the public API interface
function constructor() {
    Util.Debug(">> Canvas.init");

    var c;

    if (! conf.target) { throw("target must be set"); }

    if (typeof conf.target === 'string') {
        conf.target = window.$(conf.target);
    }

    c = conf.target;
    if (! c.getContext) { throw("no getContext method"); }

    conf.ctx = c.getContext('2d');
    if (! conf.ctx.createImageData) { throw("no createImageData method"); }

    that.clear();

    conf.render_mode = "createImageData rendering";

    conf.focused = true;

    Util.Debug("<< Canvas.init");
    return that ;
}

/* Translate DOM key event to keysym value */
function getKeysym(e) {
    var evt, keysym;
    evt = (e ? e : window.event);

    /* Remap modifier and special keys */
    switch ( evt.keyCode ) {
        case 8         : keysym = 0xFF08; break; // BACKSPACE
        case 9         : keysym = 0xFF09; break; // TAB
        case 13        : keysym = 0xFF0D; break; // ENTER
        case 27        : keysym = 0xFF1B; break; // ESCAPE
        case 45        : keysym = 0xFF63; break; // INSERT
        case 46        : keysym = 0xFFFF; break; // DELETE
        case 36        : keysym = 0xFF50; break; // HOME
        case 35        : keysym = 0xFF57; break; // END
        case 33        : keysym = 0xFF55; break; // PAGE_UP
        case 34        : keysym = 0xFF56; break; // PAGE_DOWN
        case 37        : keysym = 0xFF51; break; // LEFT
        case 38        : keysym = 0xFF52; break; // UP
        case 39        : keysym = 0xFF53; break; // RIGHT
        case 40        : keysym = 0xFF54; break; // DOWN
        case 112       : keysym = 0xFFBE; break; // F1
        case 113       : keysym = 0xFFBF; break; // F2
        case 114       : keysym = 0xFFC0; break; // F3
        case 115       : keysym = 0xFFC1; break; // F4
        case 116       : keysym = 0xFFC2; break; // F5
        case 117       : keysym = 0xFFC3; break; // F6
        case 118       : keysym = 0xFFC4; break; // F7
        case 119       : keysym = 0xFFC5; break; // F8
        case 120       : keysym = 0xFFC6; break; // F9
        case 121       : keysym = 0xFFC7; break; // F10
        case 122       : keysym = 0xFFC8; break; // F11
        case 123       : keysym = 0xFFC9; break; // F12
        case 16        : keysym = 0xFFE1; break; // SHIFT
        case 17        : keysym = 0xFFE3; break; // CONTROL
        //case 18        : keysym = 0xFFE7; break; // Left Meta (Mac Option)
        case 18        : keysym = 0xFFE9; break; // Left ALT (Mac Command)
        default        : keysym = evt.keyCode; break;
    }

    /* Remap symbols */
    switch (keysym) {
        case 186       : keysym = 59; break; // ;  (IE)
        case 187       : keysym = 61; break; // =  (IE)
        case 188       : keysym = 44; break; // ,  (Mozilla, IE)
        case 109       :                     // -  (Mozilla)
            if (Util.Engine.gecko) {
                         keysym = 45; }
                                      break;
        case 189       : keysym = 45; break; // -  (IE)
        case 190       : keysym = 46; break; // .  (Mozilla, IE)
        case 191       : keysym = 47; break; // /  (Mozilla, IE)
        case 192       : keysym = 96; break; // `  (Mozilla, IE)
        case 219       : keysym = 91; break; // [  (Mozilla, IE)
        case 220       : keysym = 92; break; // \  (Mozilla, IE)
        case 221       : keysym = 93; break; // ]  (Mozilla, IE)
        case 222       : keysym = 39; break; // '  (Mozilla, IE)
    }
    
    /* Remap shifted and unshifted keys */
    if (!!evt.shiftKey) {
        switch (keysym) {
            case 48        : keysym = 41 ; break; // )  (shifted 0)
            case 49        : keysym = 33 ; break; // !  (shifted 1)
            case 50        : keysym = 64 ; break; // @  (shifted 2)
            case 51        : keysym = 35 ; break; // #  (shifted 3)
            case 52        : keysym = 36 ; break; // $  (shifted 4)
            case 53        : keysym = 37 ; break; // %  (shifted 5)
            case 54        : keysym = 94 ; break; // ^  (shifted 6)
            case 55        : keysym = 38 ; break; // &  (shifted 7)
            case 56        : keysym = 42 ; break; // *  (shifted 8)
            case 57        : keysym = 40 ; break; // (  (shifted 9)

            case 59        : keysym = 58 ; break; // :  (shifted `)
            case 61        : keysym = 43 ; break; // +  (shifted ;)
            case 44        : keysym = 60 ; break; // <  (shifted ,)
            case 45        : keysym = 95 ; break; // _  (shifted -)
            case 46        : keysym = 62 ; break; // >  (shifted .)
            case 47        : keysym = 63 ; break; // ?  (shifted /)
            case 96        : keysym = 126; break; // ~  (shifted `)
            case 91        : keysym = 123; break; // {  (shifted [)
            case 92        : keysym = 124; break; // |  (shifted \)
            case 93        : keysym = 125; break; // }  (shifted ])
            case 39        : keysym = 34 ; break; // "  (shifted ')
        }
    } else if ((keysym >= 65) && (keysym <=90)) {
        /* Remap unshifted A-Z */
        keysym += 32;
    } 

    return keysym;
}

function onMouseButton(e, down) {
    var evt, pos, bmask;
    if (! conf.focused) {
        return true;
    }
    evt = (e ? e : window.event);
    pos = Util.getEventPosition(e, conf.target, conf.scale);
    bmask = 1 << evt.button;
    //Util.Debug('mouse ' + pos.x + "," + pos.y + " down: " + down + " bmask: " + bmask);
    if (c_mouseButton) {
        c_mouseButton(pos.x, pos.y, down, bmask);
    }
    Util.stopEvent(e);
    return false;
}

function onMouseDown(e) {
    onMouseButton(e, 1);
}

function onMouseUp(e) {
    onMouseButton(e, 0);
}

function onMouseWheel(e) {
    var evt, pos, bmask, wheelData;
    evt = (e ? e : window.event);
    pos = Util.getEventPosition(e, conf.target, conf.scale);
    wheelData = evt.detail ? evt.detail * -1 : evt.wheelDelta / 40;
    if (wheelData > 0) {
        bmask = 1 << 3;
    } else {
        bmask = 1 << 4;
    }
    //Util.Debug('mouse scroll by ' + wheelData + ':' + pos.x + "," + pos.y);
    if (c_mouseButton) {
        c_mouseButton(pos.x, pos.y, 1, bmask);
        c_mouseButton(pos.x, pos.y, 0, bmask);
    }
    Util.stopEvent(e);
    return false;
}

function onMouseMove(e) {
    var evt, pos;
    evt = (e ? e : window.event);
    pos = Util.getEventPosition(e, conf.target, conf.scale);
    //Util.Debug('mouse ' + evt.which + '/' + evt.button + ' up:' + pos.x + "," + pos.y);
    if (c_mouseMove) {
        c_mouseMove(pos.x, pos.y);
    }
}

function onKeyDown(e) {
    //Util.Debug("keydown: " + getKeysym(e));
    if (! conf.focused) {
        return true;
    }
    if (c_keyPress) {
        c_keyPress(getKeysym(e), 1);
    }
    Util.stopEvent(e);
    return false;
}

function onKeyUp(e) {
    //Util.Debug("keyup: " + getKeysym(e));
    if (! conf.focused) {
        return true;
    }
    if (c_keyPress) {
        c_keyPress(getKeysym(e), 0);
    }
    Util.stopEvent(e);
    return false;
}

function onMouseDisable(e) {
    var evt, pos;
    if (! conf.focused) {
        return true;
    }
    evt = (e ? e : window.event);
    pos = Util.getEventPosition(e, conf.target, conf.scale);
    /* Stop propagation if inside canvas area */
    if ((pos.x >= 0) && (pos.y >= 0) &&
        (pos.x < c_width) && (pos.y < c_height)) {
        //Util.Debug("mouse event disabled");
        Util.stopEvent(e);
        return false;
    }
    //Util.Debug("mouse event not disabled");
    return true;
}

//
// Public API interface functions
//

that.getContext = function () {
    return conf.ctx;
};

that.start = function(keyPressFunc, mouseButtonFunc, mouseMoveFunc) {
    var c;
    Util.Debug(">> Canvas.start");

    c = conf.target;
    c_keyPress = keyPressFunc || null;
    c_mouseButton = mouseButtonFunc || null;
    c_mouseMove = mouseMoveFunc || null;

    Util.addEvent(conf.focusContainer, 'keydown', onKeyDown);
    Util.addEvent(conf.focusContainer, 'keyup', onKeyUp);
    Util.addEvent(c, 'mousedown', onMouseDown);
    Util.addEvent(c, 'mouseup', onMouseUp);
    Util.addEvent(c, 'mousemove', onMouseMove);
    Util.addEvent(c, (Util.Engine.gecko) ? 'DOMMouseScroll' : 'mousewheel',
            onMouseWheel);

    /* Work around right and middle click browser behaviors */
    Util.addEvent(conf.focusContainer, 'click', onMouseDisable);
    Util.addEvent(conf.focusContainer.body, 'contextmenu', onMouseDisable);

    Util.Debug("<< Canvas.start");
};

that.resize = function(width, height) {
    var c = conf.target;

    c.width = width;
    c.height = height;

    c_width  = c.offsetWidth;
    c_height = c.offsetHeight;
};

that.clear = function() {
    that.resize(640, 20);
    conf.ctx.clearRect(0, 0, c_width, c_height);
};

that.stop = function() {
    var c = conf.target;
    Util.removeEvent(conf.focusContainer, 'keydown', onKeyDown);
    Util.removeEvent(conf.focusContainer, 'keyup', onKeyUp);
    Util.removeEvent(c, 'mousedown', onMouseDown);
    Util.removeEvent(c, 'mouseup', onMouseUp);
    Util.removeEvent(c, 'mousemove', onMouseMove);
    Util.removeEvent(c, (Util.Engine.gecko) ? 'DOMMouseScroll' : 'mousewheel',
            onMouseWheel);

    /* Work around right and middle click browser behaviors */
    Util.removeEvent(conf.focusContainer, 'click', onMouseDisable);
    Util.removeEvent(conf.focusContainer.body, 'contextmenu', onMouseDisable);
};

fillRect = function(x, y, width, height, color) {
    var newStyle, c = color;
    if (newStyle !== c_prevStyle) {
        newStyle = "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
        conf.ctx.fillStyle = newStyle;
        c_prevStyle = newStyle;
    }
    conf.ctx.fillRect(x, y, width, height);
};
that.fillRect = fillRect;

that.copyImage = function(old_x, old_y, new_x, new_y, width, height) {
    conf.ctx.drawImage(conf.target, old_x, old_y, width, height,
                                    new_x, new_y, width, height);
};

/*
 * Tile rendering functions optimized for rendering engines.
 *
 * - In Chrome/webkit, Javascript image data array manipulations are
 *   faster than direct Canvas fillStyle, fillRect rendering. In
 *   gecko, Javascript array handling is much slower.
 */
that.getTile = function(x, y, width, height, color) {
    var img, data, p, red, green, blue, j, i;
    img = {'x': x, 'y': y, 'width': width, 'height': height,
           'data': []};
    data = img.data;
    red = color[0];
    green = color[1];
    blue = color[2];
    for (j = 0; j < height; j += 1) {
        for (i = 0; i < width; i += 1) {
            p = (i + (j * width) ) * 4;
            data[p + 0] = red;
            data[p + 1] = green;
            data[p + 2] = blue;
            //data[p + 3] = 255; // Set Alpha
        }   
    } 
    return img;
};

that.setSubTile = function(img, x, y, w, h, color) {
    var data, p, red, green, blue, width, j, i;
    data = img.data;
    width = img.width;
    red = color[0];
    green = color[1];
    blue = color[2];
    for (j = 0; j < h; j += 1) {
        for (i = 0; i < w; i += 1) {
            p = (x + i + ((y + j) * width) ) * 4;
            data[p + 0] = red;
            data[p + 1] = green;
            data[p + 2] = blue;
            //img.data[p + 3] = 255; // Set Alpha
        }   
    } 
};

that.putTile = function(img) {
    that.blitImage(img.x, img.y, img.width, img.height, img.data, 0);
};

that.imageData = function(width, height) {
    return conf.ctx.createImageData(width, height);
};

that.blitImage = function(x, y, width, height, arr, offset) {
    var img, i, j, data;
    img = that.imageData(width, height);
    data = img.data;
    for (i=0, j=offset; i < (width * height * 4); i=i+4, j=j+4) {
        data[i + 0] = arr[j + 0];
        data[i + 1] = arr[j + 1];
        data[i + 2] = arr[j + 2];
        data[i + 3] = 255; // Set Alpha
    }
    conf.ctx.putImageData(img, x, y);
};

return constructor();  // Return the public API interface

}  // End of Canvas()

