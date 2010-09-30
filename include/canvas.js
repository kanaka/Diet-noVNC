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
that.conf = conf || {}; // Make it public
function cdef(v, defval, desc) {
    if (typeof conf[v] === 'undefined') conf[v] = defval; }
cdef('target',         null,     'Canvas element for VNC viewport');
cdef('focusContainer', document, 'DOM element that traps keyboard input');
cdef('focused',        true,     'Capture and send key strokes');
cdef('render_mode',    '',       'Canvas rendering mode (read-only)');

//
// Private functions
//

// Create the public API interface
function constructor() {
    Util.Debug(">> Canvas.init");

    var c = conf.target;

    if (! c) { throw("target must be set"); }
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
    var evt, keysym, map1, map2, map3
    evt = (e ? e : window.event);

    map1 = {
        8  : 0x08, 9  : 0x09, 13 : 0x0D, 27 : 0x1B, 45 : 0x63, 46 : 0xFF,
        36 : 0x50, 35 : 0x57, 33 : 0x55, 34 : 0x56, 37 : 0x51, 38 : 0x52,
        39 : 0x53, 40 : 0x54, 112: 0xBE, 113: 0xBF, 114: 0xC0, 115: 0xC1,
        116: 0xC2, 117: 0xC3, 118: 0xC4, 119: 0xC5, 120: 0xC6, 121: 0xC7,
        122: 0xC8, 123: 0xC9, 16 : 0xE1, 17 : 0xE3, 18 : 0xE9 };

    map2 = {
        186: 59, 187: 61, 188: 44, 189: 45, 190: 46, 191: 47,
        192: 96, 219: 91, 220: 92, 221: 93, 222: 39 };
    if (Util.Engine.gecko) map2[109] = 45;

    map3 = {
        48: 41, 49: 33, 50: 64, 51: 35, 52: 36, 53: 37, 54: 94,
        55: 38, 56: 42, 57: 40, 59: 58, 61: 43, 44: 60, 45: 95,
        46: 62, 47: 63, 96: 126, 91: 123, 92: 124, 93: 125, 39: 34 }

    keysym = evt.keyCode;

    /* Remap modifier and special keys */
    if (keysym in map1) keysym = 0xFF00 + map1[keysym];

    /* Remap symbols */
    if (keysym in map2) keysym = map2[keysym];
    
    /* Remap shifted and unshifted keys */
    if (!!evt.shiftKey) {
        if (keysym in map3) keysym = map3[keysym];
    } else if ((keysym >= 65) && (keysym <=90)) {
        /* Remap unshifted A-Z */
        keysym += 32;
    } 

    return keysym;
}

// Cross-browser mouse event position within DOM element
function getEventPosition(e, obj) {
    var evt, docX, docY, x = 0, y = 0;
    evt = (e ? e : window.event);
    if (evt.pageX || evt.pageY) {
        docX = evt.pageX;
        docY = evt.pageY;
    } else if (evt.clientX || evt.clientY) {
        docX = evt.clientX + document.body.scrollLeft +
            document.documentElement.scrollLeft;
        docY = evt.clientY + document.body.scrollTop +
            document.documentElement.scrollTop;
    }
    if (obj.offsetParent) {
        do {
            x += obj.offsetLeft;
            y += obj.offsetTop;
            obj = obj.offsetParent;
        } while (obj);
    }
    return {'x': (docX - x), 'y': (docY - y)};
};


// Event registration. Based on: http://www.scottandrew.com/weblog/articles/cbs-events
function addEvent(o, evType, fn){
    var r = true;
    if      (o.attachEvent)      r = o.attachEvent("on"+evType, fn);
    else if (o.addEventListener) o.addEventListener(evType, fn, false);
    else                         throw("Handler could not be attached");
    return r;
};

function removeEvent(o, evType, fn){
    var r = true;
    if (o.detachEvent)              r = o.detachEvent("on"+evType, fn);
    else if (o.removeEventListener) o.removeEventListener(evType, fn, false);
    else                            throw("Handler could not be removed");
    return r;
};

function stopEvent(e) {
    if (e.stopPropagation) { e.stopPropagation(); }
    else                   { e.cancelBubble = true; }

    if (e.preventDefault)  { e.preventDefault(); }
    else                   { e.returnValue = false; }
};


function onMouseButton(e, down) {
    var evt, pos, bmask;
    if (! conf.focused) {
        return true;
    }
    evt = (e ? e : window.event);
    pos = getEventPosition(e, conf.target);
    bmask = 1 << evt.button;
    //Util.Debug('mouse ' + pos.x + "," + pos.y + " down: " + down + " bmask: " + bmask);
    if (c_mouseButton) {
        c_mouseButton(pos.x, pos.y, down, bmask);
    }
    stopEvent(e);
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
    pos = getEventPosition(e, conf.target);
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
    stopEvent(e);
    return false;
}

function onMouseMove(e) {
    var evt, pos;
    evt = (e ? e : window.event);
    pos = getEventPosition(e, conf.target);
    //Util.Debug('mouse ' + evt.which + '/' + evt.button + ' up:' + pos.x + "," + pos.y);
    if (c_mouseMove) {
        c_mouseMove(pos.x, pos.y);
    }
}

function onKeyDown(e) {
    if (! conf.focused) return true;
    if (c_keyPress) c_keyPress(getKeysym(e), 1);
    stopEvent(e);
    return false;
}

function onKeyUp(e) {
    if (! conf.focused) return true;
    if (c_keyPress) c_keyPress(getKeysym(e), 0);
    stopEvent(e);
    return false;
}

function onMouseDisable(e) {
    var evt, pos;
    if (! conf.focused) return true;
    evt = (e ? e : window.event);
    pos = getEventPosition(e, conf.target);
    /* Stop propagation if inside canvas area */
    if ((pos.x >= 0) && (pos.y >= 0) &&
        (pos.x < c_width) && (pos.y < c_height)) {
        //Util.Debug("mouse event disabled");
        stopEvent(e);
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

    addEvent(conf.focusContainer, 'keydown', onKeyDown);
    addEvent(conf.focusContainer, 'keyup', onKeyUp);
    addEvent(c, 'mousedown', onMouseDown);
    addEvent(c, 'mouseup', onMouseUp);
    addEvent(c, 'mousemove', onMouseMove);
    addEvent(c, (Util.Engine.gecko) ? 'DOMMouseScroll' : 'mousewheel',
            onMouseWheel);

    /* Work around right and middle click browser behaviors */
    addEvent(conf.focusContainer, 'click', onMouseDisable);
    addEvent(conf.focusContainer.body, 'contextmenu', onMouseDisable);

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
    removeEvent(conf.focusContainer, 'keydown', onKeyDown);
    removeEvent(conf.focusContainer, 'keyup', onKeyUp);
    removeEvent(c, 'mousedown', onMouseDown);
    removeEvent(c, 'mouseup', onMouseUp);
    removeEvent(c, 'mousemove', onMouseMove);
    removeEvent(c, (Util.Engine.gecko) ? 'DOMMouseScroll' : 'mousewheel',
            onMouseWheel);

    /* Work around right and middle click browser behaviors */
    removeEvent(conf.focusContainer, 'click', onMouseDisable);
    removeEvent(conf.focusContainer.body, 'contextmenu', onMouseDisable);
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

