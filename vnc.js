/*
 * Diet noVNC: noVNC (HTML5 VNC client) but without the sugar.
 * Copyright (C) 2010 Joel Martin
 * Licensed under LGPL-3 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 */

"use strict";
/*jslint browser: true, bitwise: false, white: false, plusplus: false */
/*global window, console, document, navigator, WebSocket, ActiveXObject, DES */

// Globals defined here
var log_level, debug, info, warn, error, stub, Features, Engine;

// -------------------------------------------------------------------
// Utilities
// -------------------------------------------------------------------

// Make arrays quack
Array.prototype.push8 = function (n) {
    this.push(n&0xFF);
};
Array.prototype.push16 = function (n) {
    this.push((n>>8)&0xFF, (n)&0xFF);
};
Array.prototype.push32 = function (n) {
    this.push((n>>24)&0xFF, (n>>16)&0xFF, (n>>8)&0xFF, (n)&0xFF);
};

// Logging/debug routines
debug = info = warn = error = stub = function(m) {};
log_level =  (document.location.href.match(
                    /logging=([A-Za-z0-9\._\-]*)/) ||
                    ['', 'warn'])[1];
if (typeof window.console === "undefined") {
    window.console = {'log': stub, 'warn': stub, 'error': stub};
}

switch (log_level) {
    case 'debug': debug = function (msg) { console.log(msg); };
    case 'info':  info  = function (msg) { console.log(msg); };
    case 'warn':  warn  = function (msg) { console.warn(msg); };
    case 'error': error = function (msg) { console.error(msg); };
    case 'none':  break;
    default:      throw("invalid logging type '" + log_level + "'");
}

// Set browser engine versions. Based on mootools.
Features = {xpath: !!(document.evaluate),
            air: !!(window.runtime),
            query: !!(document.querySelector)};

Engine = {
    'presto': (function() {
            return (!window.opera) ? false : ((arguments.callee.caller) ? 960 : ((document.getElementsByClassName) ? 950 : 925)); }()),
    'trident': (function() {
            return (!window.ActiveXObject) ? false : ((window.XMLHttpRequest) ? ((document.querySelectorAll) ? 6 : 5) : 4); }()),
    'webkit': (function() {
            try { return (navigator.taintEnabled) ? false : ((Features.xpath) ? ((Features.query) ? 525 : 420) : 419); } catch (e) { return false; } }()),
    'gecko': (function() {
            return (!document.getBoxObjectFor && window.mozInnerScreenX == null) ? false : ((document.getElementsByClassName) ? 19 : 18); }())
};


// VNC Canvas drawing area
function Canvas(conf) {

var that           = {},         // Public API interface

    // Private Canvas namespace variables
    c_width        = 0, c_height       = 0,
    c_prevStyle    = "",
    c_keyPress = null, c_mouseButton = null, c_mouseMove = null;

// Configuration settings
that.conf = conf || {}; // Make it public
function cdef(v, defval, desc) {
    if (typeof conf[v] === 'undefined') { conf[v] = defval; } }
cdef('target',         null,     'Canvas element for VNC viewport');
cdef('focusContainer', document, 'DOM element that traps keyboard input');
cdef('focused',        true,     'Capture and send key strokes');
cdef('render_mode',    '',       'Canvas rendering mode (read-only)');

//
// Private functions
//

// Translate DOM key event to keysym value
function getKeysym(e) {
    var evt = (e ? e : window.event), keysym, map1, map2, map3;

    map1 = {
        8  : 0x08, 9  : 0x09, 13 : 0x0D, 27 : 0x1B, 45 : 0x63, 46 : 0xFF,
        36 : 0x50, 35 : 0x57, 33 : 0x55, 34 : 0x56, 37 : 0x51, 38 : 0x52,
        39 : 0x53, 40 : 0x54, 112: 0xBE, 113: 0xBF, 114: 0xC0, 115: 0xC1,
        116: 0xC2, 117: 0xC3, 118: 0xC4, 119: 0xC5, 120: 0xC6, 121: 0xC7,
        122: 0xC8, 123: 0xC9, 16 : 0xE1, 17 : 0xE3, 18 : 0xE9 };

    map2 = {
        186: 59, 187: 61, 188: 44, 189: 45, 190: 46, 191: 47,
        192: 96, 219: 91, 220: 92, 221: 93, 222: 39 };
    if (Engine.gecko) { map2[109] = 45; }

    map3 = {
        48: 41, 49: 33, 50: 64, 51: 35, 52: 36, 53: 37, 54: 94,
        55: 38, 56: 42, 57: 40, 59: 58, 61: 43, 44: 60, 45: 95,
        46: 62, 47: 63, 96: 126, 91: 123, 92: 124, 93: 125, 39: 34 };

    keysym = evt.keyCode;

    // Remap modifier and special keys
    if (keysym in map1) { keysym = 0xFF00 + map1[keysym]; }

    // Remap symbols
    if (keysym in map2) { keysym = map2[keysym]; }
    
    // Remap shifted and unshifted keys
    if (!!evt.shiftKey) {
        if (keysym in map3) { keysym = map3[keysym]; }
    } else if ((keysym >= 65) && (keysym <=90)) {
        // Remap unshifted A-Z
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
}


// Event registration. Based on: http://www.scottandrew.com/weblog/articles/cbs-events
function addEvent(o, e, fn){
    var r = true;
    if      (o.attachEvent)     { r = o.attachEvent("on"+e, fn);     }
    else if (o.addEventListener){ o.addEventListener(e, fn, false);  }
    else                        { throw("Handler could not be attached"); }
    return r;
}

function removeEvent(o, e, fn){
    var r = true;
    if (o.detachEvent)              { r = o.detachEvent("on"+e, fn); }
    else if (o.removeEventListener) { o.removeEventListener(e, fn, false); }
    else                            { throw("Handler could not be removed"); }
    return r;
}

function stopEvent(e) {
    if (e.stopPropagation) { e.stopPropagation(); }
    else                   { e.cancelBubble = true; }

    if (e.preventDefault)  { e.preventDefault(); }
    else                   { e.returnValue = false; }
}


function onMouseButton(e, down) {
    var evt, pos, bmask;
    if (! conf.focused) {
        return true;
    }
    evt = (e ? e : window.event);
    pos = getEventPosition(e, conf.target);
    bmask = 1 << evt.button;
    //debug('mouse ' + pos.x + "," + pos.y + " down: " + down + " bmask: " + bmask);
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
    //debug('mouse scroll by ' + wheelData + ':' + pos.x + "," + pos.y);
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
    //debug('mouse ' + evt.which + '/' + evt.button + ' up:' + pos.x + "," + pos.y);
    if (c_mouseMove) {
        c_mouseMove(pos.x, pos.y);
    }
}

function onKeyDown(e) {
    if (! conf.focused) { return true; }
    if (c_keyPress)     { c_keyPress(getKeysym(e), 1); }
    stopEvent(e);
    return false;
}

function onKeyUp(e) {
    if (! conf.focused) { return true; }
    if (c_keyPress)     { c_keyPress(getKeysym(e), 0); }
    stopEvent(e);
    return false;
}

function onMouseDisable(e) {
    var evt, pos;
    if (! conf.focused) { return true; }
    evt = (e ? e : window.event);
    pos = getEventPosition(e, conf.target);
    // Stop propagation if inside canvas area
    if ((pos.x >= 0) && (pos.y >= 0) &&
        (pos.x < c_width) && (pos.y < c_height)) {
        //debug("mouse event disabled");
        stopEvent(e);
        return false;
    }
    //debug("mouse event not disabled");
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
    debug(">> Canvas.start");

    c = conf.target;
    c_keyPress = keyPressFunc || null;
    c_mouseButton = mouseButtonFunc || null;
    c_mouseMove = mouseMoveFunc || null;

    addEvent(conf.focusContainer, 'keydown', onKeyDown);
    addEvent(conf.focusContainer, 'keyup', onKeyUp);
    addEvent(c, 'mousedown', onMouseDown);
    addEvent(c, 'mouseup', onMouseUp);
    addEvent(c, 'mousemove', onMouseMove);
    addEvent(c, (Engine.gecko) ? 'DOMMouseScroll' : 'mousewheel',
            onMouseWheel);

    // Work around right and middle click browser behaviors
    addEvent(conf.focusContainer, 'click', onMouseDisable);
    addEvent(conf.focusContainer.body, 'contextmenu', onMouseDisable);

    debug("<< Canvas.start");
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
    removeEvent(c, (Engine.gecko) ? 'DOMMouseScroll' : 'mousewheel',
            onMouseWheel);

    // Work around right and middle click browser behaviors
    removeEvent(conf.focusContainer, 'click', onMouseDisable);
    removeEvent(conf.focusContainer.body, 'contextmenu', onMouseDisable);
};

that.fillRect = function(x, y, width, height, c) {
    var newStyle = "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
    if (newStyle !== c_prevStyle) {
        conf.ctx.fillStyle = c_prevStyle = newStyle;
    }
    conf.ctx.fillRect(x, y, width, height);
};

that.copyImage = function(x1, y1, x2, y2, w, h) {
    conf.ctx.drawImage(conf.target, x1, y1, w, h, x2, y2, w, h);
};

// Tile rendering functions
that.getTile = function(x, y, width, height, color) {
    var img, data = [], p, r, g, b, j, i;
    img = {'x': x, 'y': y, 'width': width, 'height': height,
           'data': data};
    r = color[0]; g = color[1]; b = color[2];
    for (i = 0; i < (width * height * 4); i+=4) {
        data[i] = r; data[i+1] = g; data[i+2] = b;
    }
    return img;
};

that.setSubTile = function(img, x, y, w, h, color) {
    var data, p, r, g, b, width, j, i, xend, yend;
    data = img.data;
    width = img.width;
    r = color[0]; g = color[1]; b = color[2];
    xend = x + w; yend = y + h;
    for (j = y; j < yend; j++) {
        for (i = x; i < xend; i++) {
            p = (i + (j * width) ) * 4;
            data[p+0] = r; data[p+1] = g; data[p+2] = b;
        }   
    } 
};

that.putTile = function(img) {
    that.blitImage(img.x, img.y, img.width, img.height, img.data, 0);
};

that.blitImage = function(x, y, width, height, arr, offset) {
    var img, i, j, data;
    img = conf.ctx.createImageData(width, height);
    data = img.data;
    for (i=0, j=offset; i < (width * height * 4); i=i+4, j=j+4) {
        data[i + 0] = arr[j + 0];
        data[i + 1] = arr[j + 1];
        data[i + 2] = arr[j + 2];
        data[i + 3] = 255; // Set Alpha
    }
    conf.ctx.putImageData(img, x, y);
};

// Sanity checks, and initialization
var c = conf.target;
if (! c) { throw("target must be set"); }
if (! c.getContext) { throw("no getContext method"); }
conf.ctx = c.getContext('2d');
if (! conf.ctx.createImageData) { throw("no createImageData method"); }

that.clear();
conf.render_mode = "createImageData rendering";
conf.focused = true;
return that;  // Return the public API interface

}  // End of Canvas()


// -------------------------------------------------------------------
// VNC/RFB core code
// -------------------------------------------------------------------
function RFB(conf) {

var that           = {},         // Public API interface

    // Pre-declare private functions used before definitions (jslint)
    updateState, init_msg, normal_msg, recv_message, framebufferUpdate,

    //
    // Private RFB namespace variables
    //
    rfb_host       = '',
    rfb_port       = 5900,
    rfb_password   = '',

    rfb_state      = 'disconnected',
    rfb_version    = 0,
    rfb_max_version= 3.8,
    rfb_auth_scheme= '',
    rfb_shared     = 1,


    // In preference order
    encList = [1, 5, 0, -223],
    encHandlers    = {},
    encNames       = {
        '1': 'COPYRECT',
        '5': 'HEXTILE',
        '0': 'RAW',
        '-223': 'DesktopSize' },

    ws             = null,   // Web Socket object
    canvas         = null,   // Canvas object
    sendTimer      = null,   // Send Queue check timer
    connTimer      = null,   // connection timer
    disconnTimer   = null,   // disconnection timer
    msgTimer       = null,   // queued handle_message timer

    // Receive and send queues
    rQ             = [],     // Receive Queue
    rQi            = 0,      // Receive Queue Index
    rQmax          = 100000, // Max size before compacting
    sQ             = "",     // Send Queue

    // Frame buffer update state
    FBU            = {
        x : 0, y : 0,
        w : 0, h : 0,
        rects          : 0,
        lines          : 0,  // RAW
        tiles          : 0,  // HEXTILE
        bytes          : 0,
        encoding       : 0,
        subencoding    : -1,
        background     : null
    },

    fb_Bpp         = 4,
    fb_depth       = 3,
    fb_width       = 0,
    fb_height      = 0,
    fb_name        = "",

    last_req_time  = 0,

    test_mode        = false,

    /* Mouse state */
    mouse_buttonMask = 0,
    mouse_arr        = [];


// Configuration settings
that.conf = conf || {}; // Make it public
function cdef(v, defval, desc) { 
    if (typeof conf[v] === 'undefined') { conf[v] = defval; } }

cdef('target',            null, 'VNC viewport rendering Canvas');
cdef('focusContainer',    document, 'Area that traps keyboard input');
cdef('encrypt',           false, 'Use TLS/SSL/wss encryption');
cdef('connectTimeout',    2,    'Time (s) to wait for connection');
cdef('disconnectTimeout', 3,    'Time (s) to wait for disconnection');
cdef('check_rate',        217,  'Timing (ms) of send/receive check');
cdef('fbu_req_rate',      1413, 'Timing (ms) of frameBufferUpdate requests');

cdef('updateState', function() {}, 'callback: state update');

//
// Private functions
//

// Receive Queue functions
function rQlen() {
    return rQ.length - rQi;
}

function rQshift16() {
    return (rQ[rQi++] <<  8) +
           (rQ[rQi++]      );
}
function rQshift32() {
    return (rQ[rQi++] << 24) +
           (rQ[rQi++] << 16) +
           (rQ[rQi++] <<  8) +
           (rQ[rQi++]      );
}
function rQshiftStr(len) {
    var arr = rQ.slice(rQi, rQi + len);
    rQi += len;
    return arr.map(function (num) {
            return String.fromCharCode(num); } ).join('');

}
function rQshiftBytes(len) {
    rQi += len;
    return rQ.slice(rQi-len, rQi);
}

// Check to see if we must wait for 'num' bytes (default to FBU.bytes)
// to be available in the receive queue. Return true if we need to
// wait (and possibly print a debug message), otherwise false.
function rQwait(msg, num, goback) {
    if (typeof num !== 'number') { num = FBU.bytes; }
    var rQlen = rQ.length - rQi; // Skip rQlen() function call
    if (rQlen < num) {
        if (goback) {
            if (rQi < goback) {
                throw("rQwait cannot backup " + goback + " bytes");
            }
            rQi -= goback;
        }
        //debug("   waiting for " + (num-rQlen) +
        //           " " + msg + " byte(s)");
        return true;  // true means need more data
    }
    return false;
}


// Setup routines

function init_ws() {
    var uri = "";
    if (conf.encrypt) {
        uri = "wss://";
    } else {
        uri = "ws://";
    }
    uri += rfb_host + ":" + rfb_port + "/";
    info("connecting to " + uri);
    ws = new WebSocket(uri);

    ws.onmessage = recv_message;
    ws.onopen = function(e) {
        debug(">> WebSocket.onopen");
        if (rfb_state === "connect") {
            updateState('ProtocolVersion', "Starting VNC handshake");
        } else {
            updateState('failed', "Got unexpected WebSockets connection");
        }
        debug("<< WebSocket.onopen");
    };
    ws.onclose = function(e) {
        debug(">> WebSocket.onclose");
        if (rfb_state === 'disconnect') {
            updateState('disconnected', 'VNC disconnected');
        } else if (rfb_state === 'ProtocolVersion') {
            updateState('failed', 'Failed to connect to server');
        } else if (rfb_state in {'failed':1, 'disconnected':1}) {
            error("Received onclose while disconnected");
        } else  {
            updateState('failed', 'Server disconnected');
        }
        debug("<< WebSocket.onclose");
    };
    ws.onerror = function(e) {
        debug(">> WebSocket.onerror");
        updateState('failed', "WebSocket error");
        debug("<< WebSocket.onerror");
    };
}

init_vars = function() {
    /* Reset state */
    rQ               = [];
    rQi              = 0;
    sQ               = "";
    FBU.rects        = 0;
    FBU.lines        = 0;  // RAW
    FBU.tiles        = 0;  // HEXTILE
    mouse_buttonMask = 0;
    mouse_arr        = [];
};

//
// Utility routines
//


/*
 * Running states:
 *   disconnected - idle state
 *   normal       - connected
 *
 * Page states:
 *   loaded       - page load, equivalent to disconnected
 *   connect      - starting initialization
 *   disconnect   - starting disconnect
 *   failed       - abnormal transition to disconnected
 *   fatal        - failed to load page, or fatal error
 *
 * VNC initialization states:
 *   ProtocolVersion
 *   Security
 *   Authentication
 *   password     - waiting for password, not part of RFB
 *   SecurityResult
 *   ServerInitialization
 */
updateState = function(state, statusMsg) {
    var func, cmsg, oldstate = rfb_state;

    if (state === oldstate) {
        /* Already here, ignore */
        debug("Already in state '" + state + "', ignoring.");
        return;
    }

    /* 
     * These are disconnected states. A previous connect may
     * asynchronously cause a connection so make sure we are closed.
     */
    if (state in {'disconnected':1, 'loaded':1, 'connect':1,
                  'disconnect':1, 'failed':1, 'fatal':1}) {
        if (sendTimer) {
            clearInterval(sendTimer);
            sendTimer = null;
        }

        if (msgTimer) {
            clearInterval(msgTimer);
            msgTimer = null;
        }

        if (canvas && canvas.getContext()) {
            canvas.stop();
            if (log_level !== 'debug') {
                canvas.clear();
            }
        }

        if (ws) {
            if ((ws.readyState === WebSocket.OPEN) || 
               (ws.readyState === WebSocket.CONNECTING)) {
                info("Closing WebSocket connection");
                ws.close();
            }
            ws.onmessage = function (e) { return; };
        }
    }

    if (oldstate === 'fatal') {
        error("Fatal error, cannot continue");
    }

    if ((state === 'failed') || (state === 'fatal')) {
        func = Error;
    } else {
        func = warn;
    }

    if ((oldstate === 'failed') && (state === 'disconnected')) {
        // Do disconnect action, but stay in failed state.
        rfb_state = 'failed';
    } else {
        rfb_state = state;
    }

    cmsg = typeof(statusMsg) !== 'undefined' ? (" Msg: " + statusMsg) : "";
    func("New state '" + rfb_state + "', was '" + oldstate + "'." + cmsg);

    if (connTimer && (rfb_state !== 'connect')) {
        debug("Clearing connect timer");
        clearInterval(connTimer);
        connTimer = null;
    }

    if (disconnTimer && (rfb_state !== 'disconnect')) {
        debug("Clearing disconnect timer");
        clearInterval(disconnTimer);
        disconnTimer = null;
    }

    switch (state) {
    case 'normal':
        if ((oldstate === 'disconnected') || (oldstate === 'failed')) {
            error("Invalid transition from 'disconnected' or 'failed' to 'normal'");
        }

        break;


    case 'connect':
        
        connTimer = setTimeout(function () {
                updateState('failed', "Connect timeout");
            }, conf.connectTimeout * 1000);

        init_vars();
        init_ws();

        // WebSocket.onopen transitions to 'ProtocolVersion'
        break;


    case 'disconnect':

        if (! test_mode) {
            disconnTimer = setTimeout(function () {
                    updateState('failed', "Disconnect timeout");
                }, conf.disconnectTimeout * 1000);
        }

        // WebSocket.onclose transitions to 'disconnected'
        break;


    case 'failed':
        if (oldstate === 'disconnected') {
            error("Invalid transition from 'disconnected' to 'failed'");
        }
        if (oldstate === 'normal') {
            error("Error while connected.");
        }
        if (oldstate === 'init') {
            error("Error while initializing.");
        }

        // Make sure we transition to disconnected
        setTimeout(function() { updateState('disconnected'); }, 50);

        break;


    default:
        // No state change action to take

    }

    if ((oldstate === 'failed') && (state === 'disconnected')) {
        // Leave the failed message
        conf.updateState(that, state, oldstate);
    } else {
        conf.updateState(that, state, oldstate, statusMsg);
    }
};

/* base64 encode */
function encode_message(arr) {
    var i, encStr = "";
    for (i=0; i < arr.length; i++) {
        encStr += String.fromCharCode(arr[i]);
    }
    sQ += window.btoa(encStr);
}

/* base64 decode */
function decode_message(data) {
    var decStr, i, j;

    decStr = window.atob(data);
    i = rQ.length;
    for (j=0; j < decStr.length; i++, j++) {
        rQ[i] = decStr.charCodeAt(j);
    }
}

function handle_message() {
    if (rQlen() === 0) {
        warn("handle_message called on empty receive queue");
        return;
    }
    switch (rfb_state) {
    case 'disconnected':
    case 'failed':
        error("Got data while disconnected");
        break;
    case 'normal':
        if (normal_msg() && rQlen() > 0) {
            // true means we can continue processing
            // Give other events a chance to run
            if (msgTimer === null) {
                debug("More data to process, creating timer");
                msgTimer = setTimeout(function () {
                            msgTimer = null;
                            handle_message();
                        }, 10);
            } else {
                debug("More data to process, existing timer");
            }
        }
        // Compact the queue
        if (rQ.length > rQmax) {
            //debug("Compacting receive queue");
            rQ = rQ.slice(rQi);
            rQi = 0;
        }
        break;
    default:
        init_msg();
        break;
    }
}

recv_message = function(e) {
    try {
        decode_message(e.data);
        if (rQlen() > 0) {
            handle_message();
        } else {
            debug("Ignoring empty message");
        }
    } catch (exc) {
        if (typeof exc.stack !== 'undefined') {
            warn("recv_message, caught exception: " + exc.stack);
        } else if (typeof exc.description !== 'undefined') {
            warn("recv_message, caught exception: " + exc.description);
        } else {
            warn("recv_message, caught exception:" + exc);
        }
        if (typeof exc.name !== 'undefined') {
            updateState('failed', exc.name + ": " + exc.message);
        } else {
            updateState('failed', exc);
        }
    }
};

// overridable for testing
send_array = function(arr) {
    encode_message(arr);
    if (ws.bufferedAmount === 0) {
        ws.send(sQ);
        sQ = "";
    } else {
        debug("Delaying send");
    }
};

function send_string(str) {
    send_array(str.split('').map(
        function (chr) { return chr.charCodeAt(0); } ) );
}

function genDES(password, challenge) {
    var i, passwd = [], des;
    for (i=0; i < password.length; i++) {
        passwd.push(password.charCodeAt(i));
    }
    return (new DES(passwd)).encrypt(challenge);
}

function flushClient() {
    if (mouse_arr.length > 0) {
        //send_array(mouse_arr.concat(fbUpdateRequest(1)));
        send_array(mouse_arr);
        setTimeout(function() {
                send_array(fbUpdateRequest(1));
            }, 50);

        mouse_arr = [];
        return true;
    } else {
        return false;
    }
}

// overridable for testing
checkEvents = function() {
    var now;
    if (rfb_state === 'normal') {
        if (! flushClient()) {
            now = new Date().getTime();
            if (now > last_req_time + conf.fbu_req_rate) {
                last_req_time = now;
                send_array(fbUpdateRequest(1));
            }
        }
    }
    setTimeout(checkEvents, conf.check_rate);
};

function keyPress(keysym, down) {
    var arr;
    arr = keyEvent(keysym, down);
    arr = arr.concat(fbUpdateRequest(1));
    send_array(arr);
}

function mouseButton(x, y, down, bmask) {
    if (down) {
        mouse_buttonMask |= bmask;
    } else {
        mouse_buttonMask ^= bmask;
    }
    mouse_arr = mouse_arr.concat( pointerEvent(x, y) );
    flushClient();
}

function mouseMove(x, y) {
    mouse_arr = mouse_arr.concat( pointerEvent(x, y) );
}

/*
 * Client message routines
 */

pixelFormat = function() {
    var arr = [0, 0, 0, 0]; // msg-type, padding

    arr = arr.concat(fb_Bpp*8, fb_depth*8); // bpp, depth
    arr = arr.concat(0, 1); // little-endian, true-color

    arr.push16(255);  // red-max
    arr.push16(255);  // green-max
    arr.push16(255);  // blue-max
    arr = arr.concat(0, 8, 16); // red-shift, green-shift, blue-shift

    arr = arr.concat(0, 0, 0);     // padding
    return arr;
};

clientEncodings = function() {
    var arr = [2, 0], e;

    arr.push16(encList.length); // encoding count
    for (i=0; i<encList.length; i++) { arr.push32(encList[i]); }
    debug("here3: arr: " + arr + " (" + arr.length + ")");
    return arr;
};

fbUpdateRequest = function(incremental, x, y, xw, yw) {
    var arr = [3, incremental];
    if (!x) { x = 0; }
    if (!y) { y = 0; }
    if (!xw) { xw = fb_width; }
    if (!yw) { yw = fb_height; }
    arr.push16(x);
    arr.push16(y);
    arr.push16(xw);
    arr.push16(yw);
    return arr;
};

keyEvent = function(keysym, down) {
    var arr = [4, down, 0, 0];
    arr.push32(keysym);
    return arr;
};

pointerEvent = function(x, y) {
    var arr = [5, mouse_buttonMask];
    arr.push16(x);
    arr.push16(y);
    return arr;
};


//
// Server message handlers
//

// RFB/VNC initialisation message handler
init_msg = function() {
    var strlen, reason, reason_len, sversion, cversion,
        i, types, num_types, challenge, response, bpp, true_color,
        depth, big_endian, name_length;

    switch (rfb_state) {

    case 'ProtocolVersion' :
        if (rQlen() < 12) {
            updateState('failed',
                    "Disconnected: incomplete protocol version");
            return;
        }
        sversion = rQshiftStr(12).substr(4,7);
        info("Server ProtocolVersion: " + sversion);
        switch (sversion) {
            case "003.003": rfb_version = 3.3; break;
            case "003.006": rfb_version = 3.3; break;  // UltraVNC
            case "003.007": rfb_version = 3.7; break;
            case "003.008": rfb_version = 3.8; break;
            default:
                updateState('failed',
                        "Invalid server version " + sversion);
                return;
        }
        if (rfb_version > rfb_max_version) { 
            rfb_version = rfb_max_version;
        }

        if (! test_mode) {
            sendTimer = setInterval(function() {
                    // Send updates either at a rate of one update
                    // every 50ms, or whatever slower rate the network
                    // can handle.
                    if (ws.bufferedAmount === 0) {
                        if (sQ) {
                            ws.send(sQ);
                            sQ = "";
                        }
                    } else {
                        debug("Delaying send");
                    }
                }, 50);
        }

        cversion = "00" + parseInt(rfb_version,10) +
                   ".00" + ((rfb_version * 10) % 10);
        send_string("RFB " + cversion + "\n");
        updateState('Security', "Sent ProtocolVersion: " + sversion);
        break;

    case 'Security' :
        if (rfb_version >= 3.7) {
            num_types = rQ[rQi++];
            if (rQwait("security type", num_types, 1)) { return false; }
            if (num_types === 0) {
                strlen = rQshift32();
                reason = rQshiftStr(strlen);
                updateState('failed',
                        "Disconnected: security failure: " + reason);
                return;
            }
            rfb_auth_scheme = 0;
            types = rQshiftBytes(num_types);
            debug("Server security types: " + types);
            for (i=0; i < types.length; i+=1) {
                if ((types[i] > rfb_auth_scheme) && (types[i] < 3)) {
                    rfb_auth_scheme = types[i];
                }
            }
            if (rfb_auth_scheme === 0) {
                updateState('failed',
                        "Disconnected: unsupported security types: " + types);
                return;
            }
            
            send_array([rfb_auth_scheme]);
        } else {
            if (rQwait("security scheme", 4)) { return false; }
            rfb_auth_scheme = rQshift32();
        }
        updateState('Authentication',
                "Authenticating using scheme: " + rfb_auth_scheme);
        init_msg();  // Recursive fallthrough (workaround JSLint complaint)
        break;

    case 'Authentication' :
        //debug("Security auth scheme: " + rfb_auth_scheme);
        switch (rfb_auth_scheme) {
            case 0:  // connection failed
                if (rQwait("auth reason", 4)) { return false; }
                strlen = rQshift32();
                reason = rQshiftStr(strlen);
                updateState('failed',
                        "Disconnected: auth failure: " + reason);
                return;
            case 1:  // no authentication
                updateState('SecurityResult');
                break;
            case 2:  // VNC authentication
                if (rfb_password.length === 0) {
                    updateState('password', "Password Required");
                    return;
                }
                if (rQwait("auth challenge", 16)) { return false; }
                challenge = rQshiftBytes(16);
                //debug("Password: " + rfb_password);
                //debug("Challenge: " + challenge +
                //           " (" + challenge.length + ")");
                response = genDES(rfb_password, challenge);
                //debug("Response: " + response +
                //           " (" + response.length + ")");
                
                //debug("Sending DES encrypted auth response");
                send_array(response);
                updateState('SecurityResult');
                break;
            default:
                updateState('failed',
                        "Disconnected: unsupported auth scheme: " +
                        rfb_auth_scheme);
                return;
        }
        break;

    case 'SecurityResult' :
        if (rQlen() < 4) {
            updateState('failed', "Invalid VNC auth response");
            return;
        }
        switch (rQshift32()) {
            case 0:  // OK
                updateState('ServerInitialisation', "Authentication OK");
                break;
            case 1:  // failed
                if (rfb_version >= 3.8) {
                    length = rQshift32();
                    if (rQwait("SecurityResult reason", length, 8)) {
                        return false;
                    }
                    reason = rQshiftStr(reason_len);
                    updateState('failed', reason);
                } else {
                    updateState('failed', "Authentication failed");
                }
                return;
            case 2:  // too-many
                updateState('failed',
                        "Disconnected: too many auth attempts");
                return;
        }
        send_array([rfb_shared]); // ClientInitialisation
        break;

    case 'ServerInitialisation' :
        if (rQlen() < 24) {
            updateState('failed', "Invalid server initialisation");
            return;
        }

        /* Screen size */
        fb_width  = rQshift16();
        fb_height = rQshift16();

        /* PIXEL_FORMAT */
        bpp            = rQ[rQi++];
        depth          = rQ[rQi++];
        big_endian     = rQ[rQi++];
        true_color     = rQ[rQi++];

        info("Screen: " + fb_width + "x" + fb_height + 
                  ", bpp: " + bpp + ", depth: " + depth +
                  ", big_endian: " + big_endian +
                  ", true_color: " + true_color);

        /* Connection name/title */
        rQshiftStr(12);
        name_length   = rQshift32();
        fb_name = rQshiftStr(name_length);

        canvas.resize(fb_width, fb_height);
        canvas.start(keyPress, mouseButton, mouseMove);

        response = pixelFormat();
        response = response.concat(clientEncodings());
        response = response.concat(fbUpdateRequest(0));
        send_array(response);
        
        /* Start pushing/polling */
        setTimeout(checkEvents, conf.check_rate);

        if (conf.encrypt) {
            updateState('normal', "Connected (encrypted) to: " + fb_name);
        } else {
            updateState('normal', "Connected (unencrypted) to: " + fb_name);
        }
        break;
    }
};


/* Normal RFB/VNC server message handler */
normal_msg = function() {
    var ret = true, msg_type,
        c, length;

    if (FBU.rects > 0) {
        msg_type = 0;
    } else {
        msg_type = rQ[rQi++];
    }
    switch (msg_type) {
    case 0:  // FramebufferUpdate
        ret = framebufferUpdate(); // false means need more data
        break;
    case 1:  // SetColourMapEntries
        updateState('failed', "Error: got SetColourMapEntries");
        break;
    case 2:  // Bell
        warn("Bell (unsupported)");
        break;
    case 3:  // ServerCutText
        debug("ServerCutText");
        if (rQwait("ServerCutText header", 7, 1)) { return false; }
        rQshiftBytes(3);  // Padding
        length = rQshift32();
        if (rQwait("ServerCutText", length, 8)) { return false; }
        rQshiftStr(length); // Ignore it
        break;
    default:
        updateState('failed',
                "Disconnected: illegal server message type " + msg_type);
        debug("rQ.slice(0,30):" + rQ.slice(0,30));
        break;
    }
    return ret;
};

framebufferUpdate = function() {
    var now, h, fbu_rt_diff;

    if (FBU.rects === 0) {
        if (rQwait("FBU header", 3)) {
            if (rQi === 0) {
                rQ.unshift(0);  // FBU msg_type
            } else {
                rQi -= 1;
            }
            return false;
        }
        rQi++;
        FBU.rects = rQshift16();
        FBU.bytes = 0;
    }

    while (FBU.rects > 0) {
        if (rfb_state !== "normal") {
            return false;
        }
        if (rQwait("FBU")) { return false; }
        if (FBU.bytes === 0) {
            if (rQwait("rect header", 12)) { return false; }
            /* New FramebufferUpdate */

            h = rQshiftBytes(12); // header
            FBU.x      = (h[0]<<8)+h[1];
            FBU.y      = (h[2]<<8)+h[3];
            FBU.w      = (h[4]<<8)+h[5];
            FBU.h      = (h[6]<<8)+h[7];
            FBU.encoding = (h[8]<<24)+(h[9]<<16)+(h[10]<<8)+h[11];

            if (FBU.encoding in encHandlers) {
                // Debug:
                /*
                var msg =  "FramebufferUpdate rects:" + FBU.rects;
                msg += " x: " + FBU.x + " y: " + FBU.y;
                msg += " width: " + FBU.w     + " height: " + FBU.h     ;
                msg += " encoding:" + FBU.encoding;
                msg += "(" + encNames[FBU.encoding.toString()] + ")";
                msg += ", rQlen(): " + rQlen();
                debug(msg);
                */
            } else {
                updateState('failed',
                        "Disconnected: unsupported encoding " +
                        FBU.encoding);
                return false;
            }
        }

        if (! encHandlers[FBU.encoding]()) { return false; }
    }
    return true; // FBU finished
};

//
// FramebufferUpdate encodings
//

encHandlers[0] = function display_raw() {
    var cur_y, cur_height; 

    if (FBU.lines === 0) {
        FBU.lines = FBU.h;
    }
    FBU.bytes = FBU.w * fb_Bpp; // At least a line
    if (rQwait("RAW")) { return false; }
    cur_y = FBU.y + (FBU.h - FBU.lines);
    cur_height = Math.min(FBU.lines,
                          Math.floor(rQlen()/(FBU.w * fb_Bpp)));
    canvas.blitImage(FBU.x, cur_y, FBU.w, cur_height, rQ, rQi);
    rQshiftBytes(FBU.w * cur_height * fb_Bpp);
    FBU.lines -= cur_height;

    if (FBU.lines > 0) {
        FBU.bytes = FBU.w * fb_Bpp; // At least another line
    } else {
        FBU.rects -= 1;
        FBU.bytes = 0;
    }
    return true;
};

encHandlers[1] = function display_copy_rect() {
    var old_x, old_y;

    if (rQwait("COPYRECT", 4)) { return false; }
    old_x = rQshift16();
    old_y = rQshift16();
    canvas.copyImage(old_x, old_y, FBU.x, FBU.y, FBU.w, FBU.h);
    FBU.rects -= 1;
    FBU.bytes = 0;
    return true;
};

encHandlers[5] = function display_hextile() {
    var subencoding, subrects, tile, color, cur_tile,
        tile_x, x, w, tile_y, y, h, xy, s, sx, sy, wh, sw, sh;

    if (FBU.tiles === 0) {
        FBU.tiles_x = Math.ceil(FBU.w/16);
        FBU.tiles_y = Math.ceil(FBU.h/16);
        FBU.total_tiles = FBU.tiles_x * FBU.tiles_y;
        FBU.tiles = FBU.total_tiles;
    }

    /* FBU.bytes comes in as 1, rQlen() at least 1 */
    while (FBU.tiles > 0) {
        FBU.bytes = 1;
        if (rQwait("HEXTILE subencoding")) { return false; }
        subencoding = rQ[rQi];  // Peek
        if (subencoding > 30) { // Raw
            updateState('failed',
                    "Disconnected: illegal hextile subencoding " + subencoding);
            return false;
        }
        subrects = 0;
        cur_tile = FBU.total_tiles - FBU.tiles;
        tile_x = cur_tile % FBU.tiles_x;
        tile_y = Math.floor(cur_tile / FBU.tiles_x);
        x = FBU.x + tile_x * 16;
        y = FBU.y + tile_y * 16;
        w = Math.min(16, (FBU.x + FBU.w) - x);
        h = Math.min(16, (FBU.y + FBU.h) - y);

        /* Figure out how much we are expecting */
        if (subencoding & 0x01) { // Raw
            FBU.bytes += w * h * fb_Bpp;
        } else {
            if (subencoding & 0x02) { // Background
                FBU.bytes += fb_Bpp;
            }
            if (subencoding & 0x04) { // Foreground
                FBU.bytes += fb_Bpp;
            }
            if (subencoding & 0x08) { // AnySubrects
                FBU.bytes++;   // Since we aren't shifting it off
                if (rQwait("hextile subrects header")) { return false; }
                subrects = rQ[rQi + FBU.bytes-1]; // Peek
                if (subencoding & 0x10) { // SubrectsColoured
                    FBU.bytes += subrects * (fb_Bpp + 2);
                } else {
                    FBU.bytes += subrects * 2;
                }
            }
        }

        if (rQwait("hextile")) { return false; }

        /* We know the encoding and have a whole tile */
        FBU.subencoding = rQ[rQi++];
        if (FBU.subencoding === 0) {
            if (FBU.lastsubencoding & 0x01) {
                debug("     Ignoring blank after RAW");
            } else {
                canvas.fillRect(x, y, w, h, FBU.background);
            }
        } else if (FBU.subencoding & 0x01) { // Raw
            canvas.blitImage(x, y, w, h, rQ, rQi);
            rQi += FBU.bytes - 1;
        } else {
            if (FBU.subencoding & 0x02) { // Background
                FBU.background = rQ.slice(rQi, rQi + fb_Bpp);
                rQi += fb_Bpp;
            }
            if (FBU.subencoding & 0x04) { // Foreground
                FBU.foreground = rQ.slice(rQi, rQi + fb_Bpp);
                rQi += fb_Bpp;
            }

            tile = canvas.getTile(x, y, w, h, FBU.background);
            if (FBU.subencoding & 0x08) { // AnySubrects
                subrects = rQ[rQi++];
                for (s = 0; s < subrects; s++) {
                    if (FBU.subencoding & 0x10) { // SubrectsColoured
                        color = rQ.slice(rQi, rQi + fb_Bpp);
                        rQi += fb_Bpp;
                    } else {
                        color = FBU.foreground;
                    }

                    xy = rQ[rQi++]; sx = (xy>>4);   sy = (xy&0xf);
                    wh = rQ[rQi++]; sw = (wh>>4)+1; sh = (wh&0xf)+1;
                    canvas.setSubTile(tile, sx, sy, sw, sh, color);
                }
            }
            canvas.putTile(tile);
        }
        FBU.lastsubencoding = FBU.subencoding;
        FBU.bytes = 0;
        FBU.tiles -= 1;
    }

    if (FBU.tiles === 0) {
        FBU.rects -= 1;
    }
    return true;
};

encHandlers[-223] = function set_desktopsize() {
    debug(">> set_desktopsize");
    fb_width = FBU.w;
    fb_height = FBU.h;
    canvas.clear();
    canvas.resize(fb_width, fb_height);
    send_array(fbUpdateRequest(0)); // New non-incremental request

    FBU.bytes = 0;
    FBU.rects -= 1;

    debug("<< set_desktopsize");
    return true;
};

//
// Public API interface functions
//

that.connect = function(host, port, password) {
    rfb_host       = host;
    rfb_port       = port;
    rfb_password   = (password !== undefined)   ? password : "";

    if ((!rfb_host) || (!rfb_port)) {
        updateState('failed', "Must set host and port");
        return;
    }
    updateState('connect');
};

that.disconnect = function() {
    updateState('disconnect', 'Disconnecting');
};

that.sendPassword = function(passwd) {
    rfb_password = passwd;
    rfb_state = "Authentication";
    setTimeout(init_msg, 1);
};

that.sendCtrlAltDel = function() {
    if (rfb_state !== "normal") { return false; }
    info("Sending Ctrl-Alt-Del");
    var arr = [];
    arr = arr.concat(keyEvent(0xFFE3, 1)); // Control
    arr = arr.concat(keyEvent(0xFFE9, 1)); // Alt
    arr = arr.concat(keyEvent(0xFFFF, 1)); // Delete
    arr = arr.concat(keyEvent(0xFFFF, 0)); // Delete
    arr = arr.concat(keyEvent(0xFFE9, 0)); // Alt
    arr = arr.concat(keyEvent(0xFFE3, 0)); // Control
    arr = arr.concat(fbUpdateRequest(1));
    send_array(arr);
};

// Send a key press. If 'down' is not specified then send a down key
// followed by an up key.
that.sendKey = function(code, down) {
    if (rfb_state !== "normal") { return false; }
    var arr = [];
    if (typeof down !== 'undefined') {
        info("Sending key code (" + (down ? "down" : "up") + "): " + code);
        arr = arr.concat(keyEvent(code, down ? 1 : 0));
    } else {
        info("Sending key code (down + up): " + code);
        arr = arr.concat(keyEvent(code, 1));
        arr = arr.concat(keyEvent(code, 0));
    }
    arr = arr.concat(fbUpdateRequest(1));
    send_array(arr);
};

that.testMode = function(override_send_array) {
    // Overridable internal functions for testing
    test_mode = true;
    send_array = override_send_array;
    that.recv_message = recv_message;  // Expose it

    checkEvents = function () { /* Stub Out */ };
    that.connect = function(host, port, password) {
            rfb_host = host;
            rfb_port = port;
            rfb_password = password;
            updateState('ProtocolVersion', "Starting VNC handshake");
        };
};


// Sanity checks and initialization
try {
    canvas = new Canvas({'target': conf.target,
                         'focusContainer': conf.focusContainer});
} catch (exc) {
    error("Canvas exception: " + exc);
    updateState('fatal', "No working Canvas");
}
if (!window.WebSocket) {
    updateState('fatal', "Native WebSockets support is required");
}

init_vars();
updateState('loaded', 'noVNC ready: native WebSockets, ' + 
    canvas.conf.render_mode);
return that;  // Return the public API interface

}  // End of RFB()


// -------------------------------------------------------------------
// 16-byte DES implementation:
//     Copyright (C) 1999 AT&T Laboratories Cambridge.  All Rights Reserved.
//     Copyright (c) 1996 Widget Workshop, Inc. All Rights Reserved.
//     Copyright (C) 1996 by Jef Poskanzer <jef@acme.com>.  All rights reserved.
//
// See docs/LICENSE.DES for full copyright and license
// -------------------------------------------------------------------
function DES(passwd) {

// Tables, permutations, S-boxes, etc.
var PC2 = [13,16,10,23, 0, 4, 2,27,14, 5,20, 9,22,18,11, 3,
           25, 7,15, 6,26,19,12, 1,40,51,30,36,46,54,29,39,
           50,44,32,47,43,48,38,55,33,52,45,41,49,35,28,31 ],
    totrot = [ 1, 2, 4, 6, 8,10,12,14,15,17,19,21,23,25,27,28],
    z = 0x0, a,b,c,d,e,f, SP1,SP2,SP3,SP4,SP5,SP6,SP7,SP8,
    keys = [];

a=1<<16; b=1<<24; c=a|b; d=1<<2; e=1<<10; f=d|e;
SP1 = [c|e,z|z,a|z,c|f,c|d,a|f,z|d,a|z,z|e,c|e,c|f,z|e,b|f,c|d,b|z,z|d,
       z|f,b|e,b|e,a|e,a|e,c|z,c|z,b|f,a|d,b|d,b|d,a|d,z|z,z|f,a|f,b|z,
       a|z,c|f,z|d,c|z,c|e,b|z,b|z,z|e,c|d,a|z,a|e,b|d,z|e,z|d,b|f,a|f,
       c|f,a|d,c|z,b|f,b|d,z|f,a|f,c|e,z|f,b|e,b|e,z|z,a|d,a|e,z|z,c|d];
a=1<<20; b=1<<31; c=a|b; d=1<<5; e=1<<15; f=d|e;
SP2 = [c|f,b|e,z|e,a|f,a|z,z|d,c|d,b|f,b|d,c|f,c|e,b|z,b|e,a|z,z|d,c|d,
       a|e,a|d,b|f,z|z,b|z,z|e,a|f,c|z,a|d,b|d,z|z,a|e,z|f,c|e,c|z,z|f,
       z|z,a|f,c|d,a|z,b|f,c|z,c|e,z|e,c|z,b|e,z|d,c|f,a|f,z|d,z|e,b|z,
       z|f,c|e,a|z,b|d,a|d,b|f,b|d,a|d,a|e,z|z,b|e,z|f,b|z,c|d,c|f,a|e];
a=1<<17; b=1<<27; c=a|b; d=1<<3; e=1<<9; f=d|e;
SP3 = [z|f,c|e,z|z,c|d,b|e,z|z,a|f,b|e,a|d,b|d,b|d,a|z,c|f,a|d,c|z,z|f,
       b|z,z|d,c|e,z|e,a|e,c|z,c|d,a|f,b|f,a|e,a|z,b|f,z|d,c|f,z|e,b|z,
       c|e,b|z,a|d,z|f,a|z,c|e,b|e,z|z,z|e,a|d,c|f,b|e,b|d,z|e,z|z,c|d,
       b|f,a|z,b|z,c|f,z|d,a|f,a|e,b|d,c|z,b|f,z|f,c|z,a|f,z|d,c|d,a|e];
a=1<<13; b=1<<23; c=a|b; d=1<<0; e=1<<7; f=d|e;
SP4 = [c|d,a|f,a|f,z|e,c|e,b|f,b|d,a|d,z|z,c|z,c|z,c|f,z|f,z|z,b|e,b|d,
       z|d,a|z,b|z,c|d,z|e,b|z,a|d,a|e,b|f,z|d,a|e,b|e,a|z,c|e,c|f,z|f,
       b|e,b|d,c|z,c|f,z|f,z|z,z|z,c|z,a|e,b|e,b|f,z|d,c|d,a|f,a|f,z|e,
       c|f,z|f,z|d,a|z,b|d,a|d,c|e,b|f,a|d,a|e,b|z,c|d,z|e,b|z,a|z,c|e];
a=1<<25; b=1<<30; c=a|b; d=1<<8; e=1<<19; f=d|e;
SP5 = [z|d,a|f,a|e,c|d,z|e,z|d,b|z,a|e,b|f,z|e,a|d,b|f,c|d,c|e,z|f,b|z,
       a|z,b|e,b|e,z|z,b|d,c|f,c|f,a|d,c|e,b|d,z|z,c|z,a|f,a|z,c|z,z|f,
       z|e,c|d,z|d,a|z,b|z,a|e,c|d,b|f,a|d,b|z,c|e,a|f,b|f,z|d,a|z,c|e,
       c|f,z|f,c|z,c|f,a|e,z|z,b|e,c|z,z|f,a|d,b|d,z|e,z|z,b|e,a|f,b|d];
a=1<<22; b=1<<29; c=a|b; d=1<<4; e=1<<14; f=d|e;
SP6 = [b|d,c|z,z|e,c|f,c|z,z|d,c|f,a|z,b|e,a|f,a|z,b|d,a|d,b|e,b|z,z|f,
       z|z,a|d,b|f,z|e,a|e,b|f,z|d,c|d,c|d,z|z,a|f,c|e,z|f,a|e,c|e,b|z,
       b|e,z|d,c|d,a|e,c|f,a|z,z|f,b|d,a|z,b|e,b|z,z|f,b|d,c|f,a|e,c|z,
       a|f,c|e,z|z,c|d,z|d,z|e,c|z,a|f,z|e,a|d,b|f,z|z,c|e,b|z,a|d,b|f];
a=1<<21; b=1<<26; c=a|b; d=1<<1; e=1<<11; f=d|e;
SP7 = [a|z,c|d,b|f,z|z,z|e,b|f,a|f,c|e,c|f,a|z,z|z,b|d,z|d,b|z,c|d,z|f,
       b|e,a|f,a|d,b|e,b|d,c|z,c|e,a|d,c|z,z|e,z|f,c|f,a|e,z|d,b|z,a|e,
       b|z,a|e,a|z,b|f,b|f,c|d,c|d,z|d,a|d,b|z,b|e,a|z,c|e,z|f,a|f,c|e,
       z|f,b|d,c|f,c|z,a|e,z|z,z|d,c|f,z|z,a|f,c|z,z|e,b|d,b|e,z|e,a|d];
a=1<<18; b=1<<28; c=a|b; d=1<<6; e=1<<12; f=d|e;
SP8 = [b|f,z|e,a|z,c|f,b|z,b|f,z|d,b|z,a|d,c|z,c|f,a|e,c|e,a|f,z|e,z|d,
       c|z,b|d,b|e,z|f,a|e,a|d,c|d,c|e,z|f,z|z,z|z,c|d,b|d,b|e,a|f,a|z,
       a|f,a|z,c|e,z|e,z|d,c|d,z|e,a|f,b|e,z|d,b|d,c|z,c|d,b|z,a|z,b|f,
       z|z,c|f,a|d,b|d,c|z,b|e,b|f,z|z,c|f,a|e,a|e,z|f,z|f,a|d,b|z,c|e];

// Set the key.
function setKeys(keyBlock) {
    var i, j, l, m, n, o, pc1m = [], pcr = [], kn = [],
        raw0, raw1, rawi, KnLi;

    for (j = 0, l = 56; j < 56; ++j, l-=8) {
        l += l<-5 ? 65 : l<-3 ? 31 : l<-1 ? 63 : l===27 ? 35 : 0; // PC1
        m = l & 0x7;
        pc1m[j] = ((keyBlock[l >>> 3] & (1<<m)) !== 0) ? 1: 0;
    }

    for (i = 0; i < 16; ++i) {
        m = i << 1;
        n = m + 1;
        kn[m] = kn[n] = 0;
        for (o=28; o<59; o+=28) {
            for (j = o-28; j < o; ++j) {
                l = j + totrot[i];
                if (l < o) {
                    pcr[j] = pc1m[l];
                } else {
                    pcr[j] = pc1m[l - 28];
                }
            }
        }
        for (j = 0; j < 24; ++j) {
            if (pcr[PC2[j]] !== 0) {
                kn[m] |= 1<<(23-j);
            }
            if (pcr[PC2[j + 24]] !== 0) {
                kn[n] |= 1<<(23-j);
            }
        }
    }

    // cookey
    for (i = 0, rawi = 0, KnLi = 0; i < 16; ++i) {
        raw0 = kn[rawi++];
        raw1 = kn[rawi++];
        keys[KnLi] = (raw0 & 0x00fc0000) << 6;
        keys[KnLi] |= (raw0 & 0x00000fc0) << 10;
        keys[KnLi] |= (raw1 & 0x00fc0000) >>> 10;
        keys[KnLi] |= (raw1 & 0x00000fc0) >>> 6;
        ++KnLi;
        keys[KnLi] = (raw0 & 0x0003f000) << 12;
        keys[KnLi] |= (raw0 & 0x0000003f) << 16;
        keys[KnLi] |= (raw1 & 0x0003f000) >>> 4;
        keys[KnLi] |= (raw1 & 0x0000003f);
        ++KnLi;
    }
}

// Encrypt 8 bytes of text
function enc8(text) {
    var i = 0, b = text.slice(), fval, keysi = 0,
        l, r, x; // left, right, accumulator

    // Squash 8 bytes to 2 ints
    l = b[i++]<<24 | b[i++]<<16 | b[i++]<<8 | b[i++];
    r = b[i++]<<24 | b[i++]<<16 | b[i++]<<8 | b[i++];

    x = ((l >>> 4) ^ r) & 0x0f0f0f0f;
    r ^= x;
    l ^= (x << 4);
    x = ((l >>> 16) ^ r) & 0x0000ffff;
    r ^= x;
    l ^= (x << 16);
    x = ((r >>> 2) ^ l) & 0x33333333;
    l ^= x;
    r ^= (x << 2);
    x = ((r >>> 8) ^ l) & 0x00ff00ff;
    l ^= x;
    r ^= (x << 8);
    r = (r << 1) | ((r >>> 31) & 1);
    x = (l ^ r) & 0xaaaaaaaa;
    l ^= x;
    r ^= x;
    l = (l << 1) | ((l >>> 31) & 1);

    for (i = 0; i < 8; ++i) {
        x = (r << 28) | (r >>> 4);
        x ^= keys[keysi++];
        fval =  SP7[x & 0x3f];
        fval |= SP5[(x >>> 8) & 0x3f];
        fval |= SP3[(x >>> 16) & 0x3f];
        fval |= SP1[(x >>> 24) & 0x3f];
        x = r ^ keys[keysi++];
        fval |= SP8[x & 0x3f];
        fval |= SP6[(x >>> 8) & 0x3f];
        fval |= SP4[(x >>> 16) & 0x3f];
        fval |= SP2[(x >>> 24) & 0x3f];
        l ^= fval;
        x = (l << 28) | (l >>> 4);
        x ^= keys[keysi++];
        fval =  SP7[x & 0x3f];
        fval |= SP5[(x >>> 8) & 0x3f];
        fval |= SP3[(x >>> 16) & 0x3f];
        fval |= SP1[(x >>> 24) & 0x3f];
        x = l ^ keys[keysi++];
        fval |= SP8[x & 0x0000003f];
        fval |= SP6[(x >>> 8) & 0x3f];
        fval |= SP4[(x >>> 16) & 0x3f];
        fval |= SP2[(x >>> 24) & 0x3f];
        r ^= fval;
    }

    r = (r << 31) | (r >>> 1);
    x = (l ^ r) & 0xaaaaaaaa;
    l ^= x;
    r ^= x;
    l = (l << 31) | (l >>> 1);
    x = ((l >>> 8) ^ r) & 0x00ff00ff;
    r ^= x;
    l ^= (x << 8);
    x = ((l >>> 2) ^ r) & 0x33333333;
    r ^= x;
    l ^= (x << 2);
    x = ((r >>> 16) ^ l) & 0x0000ffff;
    l ^= x;
    r ^= (x << 16);
    x = ((r >>> 4) ^ l) & 0x0f0f0f0f;
    l ^= x;
    r ^= (x << 4);

    // Spread ints to bytes
    x = [r, l];
    for (i = 0; i < 8; i++) {
        b[i] = (x[i>>>2] >>> (8*(3 - (i%4)))) % 256;
        if (b[i] < 0) { b[i] += 256; } // unsigned
    }
    return b;
}

// Encrypt 16 bytes of text using passwd as key
function encrypt(t) {
    return enc8(t.slice(0,8)).concat(enc8(t.slice(8,16)));
}

setKeys(passwd);             // Setup keys
return {'encrypt': encrypt}; // Public interface

} // End of DES()
