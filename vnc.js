// Diet noVNC: noVNC (HTML5 VNC client) but without the sugar.
// Copyright (C) 2010 Joel Martin
// Licensed under LGPL-3 (see LICENSE.txt)

"use strict";
/*jslint browser: true, bitwise: false, white: false, plusplus: false */
/*global window, console, document, WebSocket */

var log_level = (document.location.href.match(
                 /logging=([a-z]*)/) || ['', 'warn'])[1],
    DES, stub = function(m) {}, 
    debug = stub, warn = stub, error = stub;

// Logging/debug
if (! window.console) {
    window.console = {'log': stub, 'warn': stub, 'error': stub};
}
switch (log_level) {
    case 'debug': debug = function (msg) { console.log(msg); };
    case 'warn':  warn  = function (msg) { console.warn(msg); };
    case 'error': error = function (msg) { console.error(msg); };
    case 'none':  break;
    default:      throw("invalid logging type '" + log_level + "'");
}

// --- VNC/RFB core code ---------------------------------------------
function RFB(conf) {

var that           = {},         // Public API interface

    // Pre-declare private functions used before definitions (jslint)
    init_ws, init_msg, normal_msg, recv_message, framebufferUpdate,
    fbUpdateRequest, checkEvents, keyEvent, pointerEvent,
    keyPress, mouseButton, mouseMove,

    // Private Canvas namespace variables
    c_ctx, c_width = 0, c_height = 0,

    // Detect gecko engine (code from mootools).
    gecko = (function() { return (!document.getBoxObjectFor && window.mozInnerScreenX == null) ? false : ((document.getElementsByClassName) ? 19 : 18); }()),

    // Private RFB namespace variables
    rfb_host       = '',
    rfb_port       = 5900,
    rfb_password   = '',

    rfb_state      = 'disconnected',
    rfb_version    = 0,
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
        rects  : 0,
        lines  : 0,  // RAW
        tiles  : 0,  // HEXTILE
        bytes  : 0,
        enc    : 0,
        subenc : -1,
        bg     : null
    },

    fb_Bpp         = 4,
    fb_depth       = 3,
    fb_width       = 0,
    fb_height      = 0,
    fb_name        = "",

    last_req_time  = 0,

    test_mode      = false,

    // Mouse state
    btnMask        = 0,
    mouse_arr      = [];


// Configuration settings
that.conf = conf || {}; // Make it public
function cdef(v, defval, desc) { 
    if (typeof conf[v] === 'undefined') { conf[v] = defval; } }

// Configuration settings
cdef('target',            null, 'VNC viewport rendering Canvas');
cdef('focusContainer',    document, 'DOM element that traps keyboard input');
cdef('encrypt',           false, 'Use TLS/SSL/wss encryption');
cdef('connectTimeout',    2,    'Time (s) to wait for connection');
cdef('disconnectTimeout', 3,    'Time (s) to wait for disconnection');
cdef('check_rate',        217,  'Timing (ms) of send/receive check');
cdef('fbu_req_rate',      1413, 'Timing (ms) of frameBufferUpdate requests');
cdef('updateState',       function() {}, 'callback: state update');

//
// Private Canvas functions
//

// Translate DOM key event to keysym value
function getKeysym(e) {
    var keysym, map1, map2, map3;

    map1 = {
        8  : 0x08, 9  : 0x09, 13 : 0x0D, 27 : 0x1B, 45 : 0x63, 46 : 0xFF,
        36 : 0x50, 35 : 0x57, 33 : 0x55, 34 : 0x56, 37 : 0x51, 38 : 0x52,
        39 : 0x53, 40 : 0x54, 112: 0xBE, 113: 0xBF, 114: 0xC0, 115: 0xC1,
        116: 0xC2, 117: 0xC3, 118: 0xC4, 119: 0xC5, 120: 0xC6, 121: 0xC7,
        122: 0xC8, 123: 0xC9, 16 : 0xE1, 17 : 0xE3, 18 : 0xE9 };

    map2 = {
        186: 59, 187: 61, 188: 44, 189: 45, 190: 46, 191: 47,
        192: 96, 219: 91, 220: 92, 221: 93, 222: 39 };
    if (gecko) { map2[109] = 45; }

    map3 = {
        48: 41, 49: 33, 50: 64, 51: 35, 52: 36, 53: 37, 54: 94,
        55: 38, 56: 42, 57: 40, 59: 58, 61: 43, 44: 60, 45: 95,
        46: 62, 47: 63, 96: 126, 91: 123, 92: 124, 93: 125, 39: 34 };

    keysym = e.keyCode;

    // Remap modifier and special keys
    if (keysym in map1) { keysym = 0xFF00 + map1[keysym]; }

    // Remap symbols
    if (keysym in map2) { keysym = map2[keysym]; }
    
    // Remap shifted and unshifted keys
    if (!!e.shiftKey) {
        if (keysym in map3) { keysym = map3[keysym]; }
    } else if ((keysym >= 65) && (keysym <=90)) {
        // Remap unshifted A-Z
        keysym += 32;
    } 

    return keysym;
}

// Mouse event position within DOM element
function eventPos(e, obj) {
    var x = 0, y = 0;
    if (obj.offsetParent) {
        while (obj) {
            x += obj.offsetLeft;
            y += obj.offsetTop;
            obj = obj.offsetParent;
        }
    }
    return {'x': e.pageX - x, 'y': e.pageY - y};
}

// Event registration. Based on: http://www.scottandrew.com/weblog/articles/cbs-events
function addEvent(o, e, fn){
    if (o.attachEvent) { return o.attachEvent("on"+e, fn); }
    o.addEventListener(e, fn, false);
    return true;
}

function removeEvent(o, e, fn){
    if (o.detachEvent) { return o.detachEvent("on"+e, fn); }
    o.removeEventListener(e, fn, false);
    return true;
}

function stopEvent(e) {
    e.stopPropagation();
    e.preventDefault();
    return false;
}

function onMouseButton(e, down) {
    var p = eventPos(e, conf.target);
    mouseButton(p.x, p.y, down, 1<<e.button);
    return stopEvent(e);
}
function onMouseDown(e) { onMouseButton(e, 1); }
function onMouseUp(e)   { onMouseButton(e, 0); }

function onMouseWheel(e) {
    var p = eventPos(e, conf.target),
        wData = e.detail ? e.detail * -1 : e.wheelDelta / 40;
    mouseButton(p.x, p.y, 1, 1 << (wData > 0 ? 3 : 4));
    mouseButton(p.x, p.y, 0, 1 << (wData > 0 ? 3 : 4));
    return stopEvent(e);
}

function onMouseMove(e) {
    var p = eventPos(e, conf.target);
    mouseMove(p.x, p.y);
}

function onKeyDown(e) {
    keyPress(getKeysym(e), 1);
    return stopEvent(e);
}

function onKeyUp(e) {
    keyPress(getKeysym(e), 0);
    return stopEvent(e);
}

function onMouseDisable(e) {
    var p = eventPos(e, conf.target);
    // Stop propagation if inside canvas area
    if (p.x >= 0 && p.y >= 0 && p.x < c_width && p.y < c_height) {
        return stopEvent(e);
    }
    return true;
}

function c_modEvents(add) {
    var c = conf.target, f = add ? addEvent : removeEvent;
    f(conf.focusContainer, 'keydown', onKeyDown);
    f(conf.focusContainer, 'keyup', onKeyUp);
    f(c, 'mousedown', onMouseDown);
    f(c, 'mouseup', onMouseUp);
    f(c, 'mousemove', onMouseMove);
    f(c, (gecko) ? 'DOMMouseScroll' : 'mousewheel', onMouseWheel);

    // Work around right and middle click browser behaviors
    f(conf.focusContainer, 'click', onMouseDisable);
    f(conf.focusContainer.body, 'contextmenu', onMouseDisable);
}


function c_resize(width, height) {
    var c = conf.target;

    c.width = width;
    c.height = height;

    c_width  = c.offsetWidth;
    c_height = c.offsetHeight;
}

function c_clear() {
    c_resize(640, 20);
    c_ctx.clearRect(0, 0, c_width, c_height);
}

function c_fillRect(x, y, width, height, c) {
    c_ctx.fillStyle = "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
    c_ctx.fillRect(x, y, width, height);
}

function c_copyImage(x1, y1, x2, y2, w, h) {
    c_ctx.drawImage(conf.target, x1, y1, w, h, x2, y2, w, h);
}

function c_blitImage(x, y, width, height, arr, offset) {
    var img, i, j, data;
    img = c_ctx.createImageData(width, height);
    data = img.data;
    for (i=0, j=offset; i < (width * height * 4); i=i+4, j=j+4) {
        data[i + 0] = arr[j + 0];
        data[i + 1] = arr[j + 1];
        data[i + 2] = arr[j + 2];
        data[i + 3] = 255; // Set Alpha
    }
    c_ctx.putImageData(img, x, y);
}

// Tile rendering functions
function c_getTile(x, y, width, height, color) {
    var img, data = [], r, g, b, i;
    img = {'x': x, 'y': y, 'width': width, 'height': height,
           'data': data};
    r = color[0]; g = color[1]; b = color[2];
    for (i = 0; i < (width * height * 4); i+=4) {
        data[i] = r; data[i+1] = g; data[i+2] = b;
    }
    return img;
}

function c_setSubTile(img, x, y, w, h, color) {
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
}

function c_putTile(img) {
    c_blitImage(img.x, img.y, img.width, img.height, img.data, 0);
}

//
// Private RFB/VNC functions
//

function init_vars() {
    rQ               = [];
    rQi              = 0;
    sQ               = "";
    FBU.rects        = 0;
    FBU.lines        = 0;  // RAW
    FBU.tiles        = 0;  // HEXTILE
    btnMask          = 0;
    mouse_arr        = [];
}

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

//
// Utility routines
//

// Running states:
//   disconnected - idle state
//   normal       - connected
//
// Page states:
//   loaded       - page load, equivalent to disconnected
//   connect      - starting initialization
//   disconnect   - starting disconnect
//   failed       - abnormal transition to disconnected
//   fatal        - failed to load page, or fatal error
//
// VNC initialization states:
//   ProtocolVersion
//   Security
//   Authentication
//   password     - waiting for password, not part of RFB
//   SecurityResult
//   ServerInitialization
function updateState(state, statusMsg) {
    var func, cmsg, oldstate = rfb_state;

    if (state === oldstate) {
        debug("Already in state '" + state + "', ignoring.");
        return;
    }

    // Disconnected states. A previous connect may asynchronously
    // cause a connection so make sure we are closed.
    if (state in {'disconnected':1, 'loaded':1, 'connect':1,
                  'disconnect':1, 'failed':1, 'fatal':1}) {
        if (sendTimer) { sendTimer = clearInterval(sendTimer); }
        if (msgTimer)  { msgTimer  = clearInterval(msgTimer); }

        if (c_ctx) {
            c_modEvents(false);
            if (log_level !== 'debug') {
                c_clear();
            }
        }

        if (ws) {
            if ((ws.readyState === WebSocket.OPEN) || 
               (ws.readyState === WebSocket.CONNECTING)) {
                debug("Closing WebSocket connection");
                ws.close();
            }
            ws.onmessage = function (e) { return; };
        }
    }

    if (oldstate === 'fatal') {
        error("Fatal error, cannot continue");
    }

    if ((state === 'failed') || (state === 'fatal')) {
        func = error;
    } else {
        func = warn;
    }

    rfb_state = state;
    if ((oldstate === 'failed') && (state === 'disconnected')) {
        // Do disconnect action, but stay in failed state.
        rfb_state = 'failed';
    }

    cmsg = typeof(statusMsg) !== 'undefined' ? (" Msg: " + statusMsg) : "";
    func("New state '" + rfb_state + "', was '" + oldstate + "'." + cmsg);

    if (connTimer && (rfb_state !== 'connect')) {
        debug("Clearing connect timer");
        connTimer = clearInterval(connTimer);
    }

    if (disconnTimer && (rfb_state !== 'disconnect')) {
        debug("Clearing disconnect timer");
        disconnTimer = clearInterval(disconnTimer);
    }

    switch (state) {
    case 'connect':
        connTimer = setTimeout(function () {
                updateState('failed', "Connect timeout");
            }, conf.connectTimeout * 1000);
        init_vars();
        init_ws();
        break; // onopen transitions to 'ProtocolVersion'

    case 'disconnect':
        if (! test_mode) {
            disconnTimer = setTimeout(function () {
                    updateState('failed', "Disconnect timeout");
                }, conf.disconnectTimeout * 1000);
        }
        break; // onclose transitions to 'disconnected'

    case 'failed':
        // Make sure we transition to disconnected
        setTimeout(function() { updateState('disconnected'); }, 50);
        break;
    }

    if ((oldstate === 'failed') && (state === 'disconnected')) {
        // Leave the failed message
        conf.updateState(that, state, oldstate);
    } else {
        conf.updateState(that, state, oldstate, statusMsg);
    }
}

// base64 encode
function encode_message(arr) {
    var i, encStr = "";
    for (i=0; i < arr.length; i++) {
        encStr += String.fromCharCode(arr[i]);
    }
    sQ += window.btoa(encStr);
}

// base64 decode
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
function send_array(arr) {
    encode_message(arr);
    if (ws.bufferedAmount === 0) {
        ws.send(sQ);
        sQ = "";
    } else {
        debug("Delaying send");
    }
}

function genDES(password, challenge) {
    var i, passwd = [];
    for (i=0; i < password.length; i++) {
        passwd.push(password.charCodeAt(i));
    }
    return (new DES(passwd)).encrypt(challenge);
}

function flushClient() {
    if (mouse_arr.length > 0) {
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

keyPress = function (keysym, down) {
    send_array(keyEvent(keysym, down).concat(fbUpdateRequest(1)));
};

mouseButton = function(x, y, down, bmask) {
    btnMask = down ? btnMask |= bmask : btnMask ^= bmask;
    mouse_arr = mouse_arr.concat( pointerEvent(x, y) );
    flushClient();
};

mouseMove = function(x, y) {
    mouse_arr = mouse_arr.concat( pointerEvent(x, y) );
};

// Setup routines

init_ws = function() {
    var uri = "";
    if (conf.encrypt) {
        uri = "wss://";
    } else {
        uri = "ws://";
    }
    uri += rfb_host + ":" + rfb_port + "/";
    debug("connecting to " + uri);
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
};

// Client message routines

function pixelFormat() {
    return [0, 0,0,0, fb_Bpp*8, fb_depth*8, // msg, pad, bpp, depth
        0,1,0,255,0,255,0,255, // little-endian, truecolor, R,G,B max
        0,8,16,0,0,0];         // R,G,B shift, padding
}

function clientEncodings() {
    var i, n, arr = [2, 0,0, encList.length]; // msg, pad, cnt
    for (i=0; i<encList.length; i++) {
        n = encList[i];
        arr.push((n>>24)&0xff, (n>>16)&0xff, (n>>8)&0xff, (n)&0xff);
    }
    return arr;
}

fbUpdateRequest = function(incremental) {
    return [3, incremental, 0,0, 0,0,  // msg, incremental, x, y
        fb_width>>8,fb_width&0xff,     // width
        fb_height>>8,fb_height&0xff];  // height
};

keyEvent = function(k, down) {
    return [4, down, 0,0, 0,0,k>>8,k&0xff]; // msg, down, pad, keysym
};

pointerEvent = function(x, y) {
    return [5, btnMask, x>>8,x&0xff, y>>8,y&0xff]; // msg, mask, x, y
};


// Server message handlers

// RFB/VNC initialisation message handler
init_msg = function() {
    var strlen, reason, length, sversion,
        i, types, num_types, challenge, response, bpp, true_color,
        depth, big_endian;

    switch (rfb_state) {

    case 'ProtocolVersion' :
        if (rQlen() < 12) {
            updateState('failed',
                    "Disconnected: incomplete protocol version");
            return;
        }
        sversion = rQshiftStr(12).substr(4,7);
        debug("Server ProtocolVersion: " + sversion);
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

        send_array(("RFB 00" + parseInt(rfb_version,10) + ".00" +
                    ((rfb_version * 10) % 10) + "\n").split('').map(
            function (chr) { return chr.charCodeAt(0); } ) );
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
                    reason = rQshiftStr(length);
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

        // Screen size
        fb_width  = rQshift16();
        fb_height = rQshift16();

        // PIXEL_FORMAT
        bpp            = rQ[rQi++];
        depth          = rQ[rQi++];
        big_endian     = rQ[rQi++];
        true_color     = rQ[rQi++];

        debug("Screen: " + fb_width + "x" + fb_height + 
                  ", bpp: " + bpp + ", depth: " + depth +
                  ", big_endian: " + big_endian +
                  ", true_color: " + true_color);

        // Connection name/title
        rQshiftStr(12);
        length   = rQshift32();
        fb_name = rQshiftStr(length);

        c_resize(fb_width, fb_height);
        c_modEvents(true);

        response = pixelFormat();
        response = response.concat(clientEncodings());
        response = response.concat(fbUpdateRequest(0));
        send_array(response);
        
        // Start pushing/polling
        setTimeout(checkEvents, conf.check_rate);

        if (conf.encrypt) {
            updateState('normal', "Connected (encrypted) to: " + fb_name);
        } else {
            updateState('normal', "Connected (unencrypted) to: " + fb_name);
        }
        break;
    }
};


// Normal RFB/VNC server message handler
normal_msg = function() {
    var length, msg_type = (FBU.rects === 0) ? rQ[rQi++] : 0;
    switch (msg_type) {
    case 0:  // FramebufferUpdate
        return framebufferUpdate(); // false means need more data
    case 1:  // SetColourMapEntries
        updateState('failed', "Error: got SetColourMapEntries");
        break;
    case 2:  // Bell
        warn("Bell (unsupported)");
        break;
    case 3:  // ServerCutText
        if (rQwait("ServerCutText header", 7, 1)) { return false; }
        rQshiftBytes(3);  // Padding
        length = rQshift32();
        if (rQwait("ServerCutText", length, 8)) { return false; }
        debug("ServerCutText: " + rQshiftStr(length));
        break;
    default:
        updateState('failed', "Illegal message type: " + msg_type);
    }
    return true;
};

framebufferUpdate = function() {
    if (FBU.rects === 0) {
        if (rQwait("FBU header", 3)) {
            if (rQi === 0) { rQ.unshift(0); } // FBU msg_type
            else           { rQi -= 1; }
            return false;
        }
        rQi++;
        FBU.rects = rQshift16();
        FBU.bytes = 0;
    }

    while (FBU.rects > 0) {
        if (rfb_state !== "normal") { return false; }
        if (rQwait("FBU")) { return false; }
        if (FBU.bytes === 0) {
            // New FramebufferUpdate
            if (rQwait("rect header", 12)) { return false; }

            var h = rQshiftBytes(12); // header
            FBU.x      = (h[0]<<8)+h[1];
            FBU.y      = (h[2]<<8)+h[3];
            FBU.w      = (h[4]<<8)+h[5];
            FBU.h      = (h[6]<<8)+h[7];
            FBU.enc    = (h[8]<<24)+(h[9]<<16)+(h[10]<<8)+h[11];

            if (FBU.enc in encHandlers) {
                // Debug:
                /*
                var msg =  "FramebufferUpdate rects:" + FBU.rects;
                msg += " x: " + FBU.x + " y: " + FBU.y;
                msg += " width: " + FBU.w     + " height: " + FBU.h     ;
                msg += " encoding:" + FBU.enc;
                msg += "(" + encNames[FBU.enc.toString()] + ")";
                msg += ", rQlen(): " + rQlen();
                debug(msg);
                */
            } else {
                updateState('failed', "Illegal encoding " + FBU.enc);
                return false;
            }
        }

        if (! encHandlers[FBU.enc]()) { return false; }
    }
    return true; // FBU finished
};


// FramebufferUpdate encodings

encHandlers[0] = function display_raw() {
    if (FBU.lines === 0) {
        FBU.lines = FBU.h;
    }

    var x = FBU.x, y = FBU.y + (FBU.h - FBU.lines), w = FBU.w,
        h = Math.min(FBU.lines, Math.floor(rQlen()/(FBU.w * fb_Bpp)));
    FBU.bytes = w * fb_Bpp; // At least a line
    if (rQwait("RAW")) { return false; }
    c_blitImage(x, y, w, h, rQ, rQi);
    rQi += w * h * fb_Bpp;
    FBU.lines -= h;

    if (FBU.lines > 0) {
        FBU.bytes = FBU.w * fb_Bpp; // At least another line
    } else {
        FBU.rects -= 1;
        FBU.bytes = 0;
    }
    return true;
};

encHandlers[1] = function display_copy_rect() {
    if (rQwait("COPYRECT", 4)) { return false; }

    var old_x = rQshift16(), old_y = rQshift16();
    c_copyImage(old_x, old_y, FBU.x, FBU.y, FBU.w, FBU.h);
    FBU.rects -= 1;
    FBU.bytes = 0;
    return true;
};

encHandlers[5] = function display_hextile() {
    var subenc, subrects, tile, color, cur_tile,
        tile_x, x, w, tile_y, y, h, xy, s, sx, sy, wh, sw, sh;

    if (FBU.tiles === 0) {
        FBU.tiles_x = Math.ceil(FBU.w/16);
        FBU.tiles_y = Math.ceil(FBU.h/16);
        FBU.total_tiles = FBU.tiles_x * FBU.tiles_y;
        FBU.tiles = FBU.total_tiles;
    }

    // FBU.bytes comes in as 1, rQlen() at least 1
    while (FBU.tiles > 0) {
        FBU.bytes = 1;
        if (rQwait("HEXTILE subencoding")) { return false; }
        subenc= rQ[rQi];  // Peek
        if (subenc> 30) { // Raw
            updateState('failed', "Illegal hextile subencoding " + subenc);
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

        // Figure out how much we are expecting
        if (subenc & 0x01) { // Raw
            FBU.bytes += w * h * fb_Bpp;
        } else {
            if (subenc & 0x02) { // Background
                FBU.bytes += fb_Bpp;
            }
            if (subenc & 0x04) { // Foreground
                FBU.bytes += fb_Bpp;
            }
            if (subenc & 0x08) { // AnySubrects
                FBU.bytes++;   // Since we aren't shifting it off
                if (rQwait("hextile subrects header")) { return false; }
                subrects = rQ[rQi + FBU.bytes-1]; // Peek
                if (subenc & 0x10) { // SubrectsColoured
                    FBU.bytes += subrects * (fb_Bpp + 2);
                } else {
                    FBU.bytes += subrects * 2;
                }
            }
        }

        if (rQwait("hextile")) { return false; }

        // We know the encoding and have a whole tile
        FBU.subenc = rQ[rQi++];
        if (FBU.subenc === 0) {
            c_fillRect(x, y, w, h, FBU.bg);
        } else if (FBU.subenc & 0x01) { // Raw
            c_blitImage(x, y, w, h, rQ, rQi);
            rQi += FBU.bytes - 1;
        } else {
            if (FBU.subenc & 0x02) { // Background
                FBU.bg = rQ.slice(rQi, rQi + fb_Bpp);
                rQi += fb_Bpp;
            }
            if (FBU.subenc & 0x04) { // Foreground
                FBU.foreground = rQ.slice(rQi, rQi + fb_Bpp);
                rQi += fb_Bpp;
            }

            tile = c_getTile(x, y, w, h, FBU.bg);
            if (FBU.subenc & 0x08) { // AnySubrects
                subrects = rQ[rQi++];
                for (s = 0; s < subrects; s++) {
                    if (FBU.subenc & 0x10) { // SubrectsColoured
                        color = rQ.slice(rQi, rQi + fb_Bpp);
                        rQi += fb_Bpp;
                    } else {
                        color = FBU.foreground;
                    }

                    xy = rQ[rQi++]; sx = (xy>>4);   sy = (xy&0xf);
                    wh = rQ[rQi++]; sw = (wh>>4)+1; sh = (wh&0xf)+1;
                    c_setSubTile(tile, sx, sy, sw, sh, color);
                }
            }
            c_putTile(tile);
        }
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
    c_clear();
    c_resize(fb_width, fb_height);
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
    debug("Sending Ctrl-Alt-Del");
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
        debug("Sending key code (" + (down ? "down" : "up") + "): " + code);
        arr = arr.concat(keyEvent(code, down ? 1 : 0));
    } else {
        debug("Sending key code (down + up): " + code);
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
    if (! conf.target) { throw("target must be set"); }
    if (! conf.target.getContext) { throw("no getContext method"); }
    c_ctx = conf.target.getContext('2d');
    if (! c_ctx.createImageData) { throw("no createImageData method"); }
} catch (exc) {
    error("Canvas exception: " + exc);
    updateState('fatal', "No working Canvas");
    return;
}
if (!window.WebSocket) {
    updateState('fatal', "Native WebSockets support is required");
    return;
}

c_clear();
init_vars();
updateState('loaded', 'noVNC ready: native WebSockets');
return that;  // Return the public API interface

}  // End of RFB()


// --- 16-byte DES --------------------------------------------------
//     Copyright (C) 1999 AT&T Laboratories Cambridge
//     Copyright (c) 1996 Widget Workshop, Inc
//     Copyright (C) 1996 by Jef Poskanzer <jef@acme.com>
// See docs/LICENSE.DES for full license/copyright

DES = function(passwd) {

var PC2, totrot, i,j,l,m,n,o, pc1m = [], pcr = [], kn = [],
    a,b,c,d,e,f, q,r,s,t,u,v,w,x,y, z = 0x0,
    S1,S2,S3,S4,S5,S6,S7,S8, keys = [];

// Set the keys based on the passwd.
PC2 = [13,16,10,23, 0, 4, 2,27,14, 5,20, 9,22,18,11, 3,
      25, 7,15, 6,26,19,12, 1,40,51,30,36,46,54,29,39,
      50,44,32,47,43,48,38,55,33,52,45,41,49,35,28,31 ];
totrot = [ 1, 2, 4, 6, 8,10,12,14,15,17,19,21,23,25,27,28];
for (j = 0, l = 56; j < 56; ++j, l-=8) {
    l += l<-5 ? 65 : l<-3 ? 31 : l<-1 ? 63 : l===27 ? 35 : 0; // PC1
    m = l & 0x7;
    pc1m[j] = ((passwd[l >>> 3] & (1<<m)) !== 0) ? 1: 0;
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
// generate 32 24-bit subkeys
for (i = 0; i < 32;) {
    a = kn[i];
    b = kn[i+1];
    keys[i] = (a & 0x00fc0000) << 6;
    keys[i] |= (a & 0x00000fc0) << 10;
    keys[i] |= (b & 0x00fc0000) >>> 10;
    keys[i++] |= (b & 0x00000fc0) >>> 6;
    keys[i] = (a & 0x0003f000) << 12;
    keys[i] |= (a & 0x0000003f) << 16;
    keys[i] |= (b & 0x0003f000) >>> 4;
    keys[i++] |= (b & 0x0000003f);
}

// Generate substitutions
function mix(g,h,i,j) { a=1<<g; b=1<<h; c=a|b; d=1<<i; e=1<<j; f=d|e;
    q=a|d;r=a|e;s=a|f; t=b|d;u=b|e;v=b|f; w=c|d;x=c|e;y=c|f; }
mix(16,24,2,10);
S1 = [x,z,a,y,w,s,d,a,e,x,y,e,v,w,b,d,f,u,u,r,r,c,c,v,q,t,t,q,z,f,s,b,
      a,y,d,c,x,b,b,e,w,a,r,t,e,d,v,s,y,q,c,v,t,f,s,x,f,u,u,z,q,r,z,w];
mix(20,31,5,15);
S2 = [y,u,e,s,a,d,w,v,t,y,x,b,u,a,d,w,r,q,v,z,b,e,s,c,q,t,z,r,f,x,c,f,
      z,s,w,a,v,c,x,e,c,u,d,y,s,d,e,b,f,x,a,t,q,v,t,q,r,z,u,f,b,w,y,r];
mix(17,27,3,9);
S3 = [f,x,z,w,u,z,s,u,q,t,t,a,y,q,c,f,b,d,x,e,r,c,w,s,v,r,a,v,d,y,e,b,
      x,b,q,f,a,x,u,z,e,q,y,u,t,e,z,w,v,a,b,y,d,s,r,t,c,v,f,c,s,d,w,r];
mix(13,23,0,7);
S4 = [w,s,s,e,x,v,t,q,z,c,c,y,f,z,u,t,d,a,b,w,e,b,q,r,v,d,r,u,a,x,y,f,
      u,t,c,y,f,z,z,c,r,u,v,d,w,s,s,e,y,f,d,a,t,q,x,v,q,r,b,w,e,b,a,x];
mix(25,30,8,19);
S5 = [d,s,r,w,e,d,b,r,v,e,q,v,w,x,f,b,a,u,u,z,t,y,y,q,x,t,z,c,s,a,c,f,
      e,w,d,a,b,r,w,v,q,b,x,s,v,d,a,x,y,f,c,y,r,z,u,c,f,q,t,e,z,u,s,t];
mix(22,29,4,14);
S6 = [t,c,e,y,c,d,y,a,u,s,a,t,q,u,b,f,z,q,v,e,r,v,d,w,w,z,s,x,f,r,x,b,
      u,d,w,r,y,a,f,t,a,u,b,f,t,y,r,c,s,x,z,w,d,e,c,s,e,q,v,z,x,b,q,v];
mix(21,26,1,11);
S7 = [a,w,v,z,e,v,s,x,y,a,z,t,d,b,w,f,u,s,q,u,t,c,x,q,c,e,f,y,r,d,b,r,
      b,r,a,v,v,w,w,d,q,b,u,a,x,f,s,x,f,t,y,c,r,z,d,y,z,s,c,e,t,u,e,q];
mix(18,28,6,12);
S8 = [v,e,a,y,b,v,d,b,q,c,y,r,x,s,e,d,c,t,u,f,r,q,w,x,f,z,z,w,t,u,s,a,
      s,a,x,e,d,w,e,s,u,d,t,c,w,b,a,v,z,y,q,t,c,u,v,z,y,r,r,f,f,q,b,x];

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
        fval =  S7[x & 0x3f];
        fval |= S5[(x >>> 8) & 0x3f];
        fval |= S3[(x >>> 16) & 0x3f];
        fval |= S1[(x >>> 24) & 0x3f];
        x = r ^ keys[keysi++];
        fval |= S8[x & 0x3f];
        fval |= S6[(x >>> 8) & 0x3f];
        fval |= S4[(x >>> 16) & 0x3f];
        fval |= S2[(x >>> 24) & 0x3f];
        l ^= fval;
        x = (l << 28) | (l >>> 4);
        x ^= keys[keysi++];
        fval =  S7[x & 0x3f];
        fval |= S5[(x >>> 8) & 0x3f];
        fval |= S3[(x >>> 16) & 0x3f];
        fval |= S1[(x >>> 24) & 0x3f];
        x = l ^ keys[keysi++];
        fval |= S8[x & 0x0000003f];
        fval |= S6[(x >>> 8) & 0x3f];
        fval |= S4[(x >>> 16) & 0x3f];
        fval |= S2[(x >>> 24) & 0x3f];
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

return {'encrypt': encrypt}; // Public interface

}; // End of DES()
