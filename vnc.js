// Diet noVNC: noVNC (HTML5 VNC client) but without the sugar.
// Copyright (C) 2010 Joel Martin
// Licensed under LGPL-3 (see docs/LICENSE.LGPL-3 and docs/LICENSE.GPL-3)

"use strict";
/*jslint browser: true, bitwise: false, white: false, plusplus: false */
/*global window, console, document, WebSocket */

var DES, stub=function(m){}, debug=stub, error=stub, dC = document,
    $ = function(id) { return dC.getElementById(id); };


// --- VNC/RFB core code ---------------------------------------------
function RFB(C, callback, wss, shared) {

var api = {}, // Public API interface
    mM = Math.min, mC = Math.ceil, mF = Math.floor,

    // Pre-declare (jslint)
    state, send, recv,

    gecko = dC.getBoxObjectFor || window.mozInnerScreenX ? 1 : 0,

    ws, tmp, curS = '', test = false,
    Ctx, host = '', port = 0, Cbpp = 4, Cdepth = 3, Cw = 0, Ch = 0,
    offStates = {'disconnected':1, 'loaded':1, 'connect':1,
                 'disconnect':1, 'failed':1, 'fatal':1},

    encList = [1, 5, 0, -223], // COPYRECT, HEXTILE, RAW, DesktopSize
    encFunc = {},
    cTime = 2, dTime = 3, req_rate = 513,
    sTimer, cTimer, dTimer, mTimer, // send, connect, disconnect, msg
    rQ, rQi, rQmax = 100000, sQ, // receive/send queue

    FBU     = {rects: 0, lines: 0, t: 0, bytes: 0 }, // FBU state
    btnMask = 0; // Mouse state

// Translate DOM key event to keysym value
function getKeysym(e) {
    var k = e.keyCode, t;

    // Remap modifier and special keys
    t = {8  :0x08, 9  :0x09, 13 :0x0D, 27 :0x1B, 45 :0x63, 46 :0xFF,
         36 :0x50, 35 :0x57, 33 :0x55, 34 :0x56, 37 :0x51, 38 :0x52,
         39 :0x53, 40 :0x54, 112:0xBE, 113:0xBF, 114:0xC0, 115:0xC1,
         116:0xC2, 117:0xC3, 118:0xC4, 119:0xC5, 120:0xC6, 121:0xC7,
         122:0xC8, 123:0xC9, 16 :0xE1, 17 :0xE3, 18 :0xE9 }[k];
    if (t) { k = 0xFF00 + t; }

    // Remap symbols
    t = {109: gecko?45:109, 186:59, 187:61, 188:44, 189:45, 190:46,
         191:47, 192:96, 219:91, 220:92, 221:93, 222:39 }[k];
    if (t) { k = t; }
    
    if (!!e.shiftKey) {
        // Remap shifted
        t = {48:41, 49:33, 50:64, 51:35, 52:36, 53:37, 54:94, 55:38,
             56:42, 57:40, 59:58, 61:43, 44:60, 45:95, 46:62, 47:63,
             96:126, 91:123, 92:124, 93:125, 39:34 }[k];
        if (t) { k = t; }
    } else if ((k >= 65) && (k <=90)) {
        k += 32; // Remap unshifted A-Z
    } 
    return k;
}

// Mouse event position within DOM element
function ePos(e, obj) {
    var x = 0, y = 0;
    if (obj.offsetParent) {
        for (; obj; obj = obj.offsetParent) {
            x += obj.offsetLeft;  y += obj.offsetTop;
        }
    }
    return {'x': e.pageX - x, 'y': e.pageY - y};
}

function stopEvent(e) {
    e.stopPropagation();
    e.preventDefault();
    return false;
}

function mEvent(x, y) {
    return [5, btnMask, x>>8,x&0xff, y>>8,y&0xff]; // msg, mask, x, y
}

function btn(x, y, down, b) {
    btnMask = down ? btnMask |= b : (btnMask &= 0xff - b);
    send( mEvent(x, y), true, 1);
}

function onBtn(e, down) {
    var p = ePos(e, C);
    btn(p.x, p.y, down, 1<<e.button);
    return stopEvent(e);
}
function onMouseDown(e) { onBtn(e, 1); }
function onMouseUp(e) { onBtn(e, 0); }

function onWheel(e) {
    var p = ePos(e, C), w = e.detail ? e.detail * -1 : e.wheelDelta / 40;
    btn(p.x, p.y, 1, 1 << (w > 0 ? 3 : 4));
    btn(p.x, p.y, 0, 1 << (w > 0 ? 3 : 4));
    return stopEvent(e);
}

function onMouseMove(e) {
    var p = ePos(e, C);
    send( mEvent(p.x, p.y), true);
}

function keyEvent(k, down) {
    return [4, down, 0,0, 0,0,k>>8,k&0xff]; // msg, down, pad, keysym
}

function onKeyDown(e) {
    send(keyEvent(getKeysym(e), 1), true, 1);
    return stopEvent(e);
}

function onKeyUp(e) {
    send(keyEvent(getKeysym(e), 0), true, 1);
    return stopEvent(e);
}

function onMouseDisable(e) {
    var p = ePos(e, C), w = C.offsetWidth, h = C.offsetHeight;
    // Stop propagation if inside canvas area
    if (p.x >= 0 && p.y >= 0 && p.x < w && p.y < h) {
        return stopEvent(e);
    }
    return true;
}

// Event registration.
function modEvent(o, m, e, fn){ o[m](e, fn, false); return true; }
function modEvents(add) {
    var f = modEvent, m = (add?'add':'remove') + 'EventListener';
    f(dC, m, 'keydown', onKeyDown);
    f(dC, m, 'keyup', onKeyUp);
    f(C, m, 'mousedown', onMouseDown);
    f(C, m, 'mouseup', onMouseUp);
    f(C, m, 'mousemove', onMouseMove);
    f(C, m, gecko ? 'DOMMouseScroll' : 'mousewheel', onWheel);
    // Work around right and middle click browser behaviors
    f(dC, m, 'click', onMouseDisable);
    f(dC.body, m, 'contextmenu', onMouseDisable);
}

function blitImage(x, y, w, h, arr, offset) {
    var img = Ctx.createImageData(w, h), i, j, d = img.data;
    for (i=0, j=offset; i < (w * h * 4); i=i+4, j=j+4) {
        d[i+0] = arr[j+0]; d[i+1] = arr[j+1]; d[i+2] = arr[j+2];
        d[i+3] = 255; // Set Alpha
    }
    Ctx.putImageData(img, x, y);
}

function init_vars() {
    rQ        = [];
    rQi       = 0;
    sQ        = "";
    FBU.rects = 0;
    FBU.lines = 0;  // RAW
    FBU.t     = 0;  // HEXTILE
    btnMask   = 0;
}

// Receive Queue functions
function rQlen() {
    return rQ.length - rQi;
}

function rQ2() {
    return (rQ[rQi++] << 8) + rQ[rQi++];
}
function rQ4() {
    return (rQ[rQi++] << 24) + (rQ[rQi++] << 16) +
           (rQ[rQi++] <<  8) +  rQ[rQi++];
}
function rQstr(len) {
    rQi += len;
    return rQ.slice(rQi-len, rQi).map(function (n) {
            return String.fromCharCode(n); } ).join('');

}
function rQbytes(len) {
    rQi += len;
    return rQ.slice(rQi-len, rQi);
}

// Do we need to wait for more data
function rQwait(msg, num) {
    if (!num) { num = FBU.bytes; }
    var rQlen = rQ.length - rQi; // Skip rQlen() function call
    if (rQlen < num) {
        //debug("   waiting for " + (num-rQlen) +
        //           " " + msg + " byte(s)");
        return true;  // true means need more data
    }
    return false;
}

function fail(msg){ return state('failed', msg); }
state = function(newS, msg) {
    var func = debug, oldS = curS?curS:'start', uri;

    // Disconnected states. A previous connect may asynchronously
    // cause a connection so make sure we are closed.
    if (newS in offStates) {
        if (sTimer) { sTimer = clearInterval(sTimer); }
        if (mTimer) { mTimer = clearInterval(mTimer); }

        if (Ctx) {
            modEvents(false);
            C.width = 640; C.height = 20;
        }

        if (ws) {
            if (ws.readyState !== WebSocket.CLOSED) {
                //debug("Closing WebSocket connection");
                ws.close();
            }
            ws.onmessage = function (e) { return; };
        }
    }

    if (oldS === 'fatal') { return; }
    if (newS in {'failed':1,'fatal':1}) { func = error; }

    curS = newS;
    if (oldS === 'failed' && newS === 'disconnected') {
        // Do disconnect, but stay failed and no new message.
        curS = 'failed';
        msg = null;
    }

    func("State " + curS + " (was " + oldS + "). " + (msg?msg:''));

    if (cTimer && curS !== 'connect') {
        //debug("Clearing connect timer");
        cTimer = clearInterval(cTimer);
    }

    if (dTimer && curS !== 'disconnect') {
        //debug("Clearing disconnect timer");
        dTimer = clearInterval(dTimer);
    }

    switch (newS) {
    case 'connect':
        modEvents(false);
        init_vars();
        if (test) {
            return state('I1', "Starting VNC handshake");
        }
        cTimer = setTimeout(function () {
                fail("Connect timeout");
            }, cTime * 1000);

        uri = (wss?"wss://":"ws://") + host + ":" + port + "/";
        debug("connecting to " + uri);
        ws = new WebSocket(uri);
        ws.onmessage = recv;
        ws.onopen = function(e) {
                state('I1', "Starting VNC handshake"); };
        ws.onclose = function(e) {
            if (curS === 'disconnect') {
                state('disconnected', 'VNC disconnected');
            } else if (curS === 'I1') {
                fail('Failed to connect to server');
            } else if (curS in {'failed':1, 'disconnected':1}) {
                error("onclose while disconnected");
            } else  {
                fail('Server disconnected');
            }
        };
        ws.onerror = function(e) { fail("WebSocket error"); };
        break; // onopen transitions to 'I1'
    case 'disconnect':
        if (! test) {
            dTimer = setTimeout(function () {
                    fail("Disconnect timeout");
                }, dTime * 1000);
        }
        break; // onclose transitions to 'disconnected'
    case 'failed':
        // Make sure we transition to disconnected
        setTimeout(function() { state('disconnected'); }, 50);
        break;
    }

    callback(api, newS, msg);
    return false;
};

function framebufferUpdate() {
    if (FBU.rects === 0) {
        if (rQwait("FBU header", 3)) {
            rQ.unshift(0); // msg-type
            return false;
        }
        rQi++;
        FBU.rects = rQ2();
        FBU.bytes = 0;
    }

    while (FBU.rects > 0) {
        if (curS !== "normal") { return false; }
        if (rQwait("FBU")) { return false; }
        if (FBU.bytes === 0) {   // New FramebufferUpdate
            if (rQwait("rect header", 12)) { return false; }

            var h = rQbytes(12); // header
            FBU.x = (h[0]<<8)+h[1];  FBU.y = (h[2]<<8)+h[3];
            FBU.w = (h[4]<<8)+h[5];  FBU.h = (h[6]<<8)+h[7];
            FBU.enc = (h[8]<<24)+(h[9]<<16)+(h[10]<<8)+h[11];

            if (! FBU.enc in encFunc) {
                return fail("Invalid encoding " + FBU.enc);
            }
            /*
            // Debug:
            debug("FBU rects:" + FBU.rects +
                    " x: " + FBU.x + " y: " + FBU.y +
                    " w: " + FBU.w + " h: " + FBU.h +
                    " enc:" + FBU.enc + " rQlen(): " + rQlen());
            */
        }

        if (! encFunc[FBU.enc]()) { return false; }
    }
    return true; // FBU finished
}


// Server message handlers
//   I1 = ProtocolVersion
//   I2 = Security
//   I3 = ServerInitialisation
function init_msg() {
    switch (curS) {
    case 'I1' :
        if (rQlen()<12) { return fail("Incomplete version"); }
        tmp = rQstr(12).substr(0,11);
        sTimer = setInterval(function (){ send([], true); }, 25);
        send(("RFB 003.003\n").split('').map(
            function (c) { return c.charCodeAt(0); } ), true);
        state('I2', "Got " + tmp + " sent RFB 003.003");
        break;
    case 'I2' :
        if (rQwait("security scheme", 4)) { return false; }
        tmp = rQ4();
        switch (tmp) {
            case 0:  return fail("Auth failure: " + rQstr(rQ4()));
            case 1:  break;
            case 2:  return fail("Server password not supported");
            default: return fail("Unsupported auth: " + tmp);
        }
        send([shared ? 1 : 0], true); // ClientInitialisation
        state('I3'); 
        break;
    case 'I3' :
        if (rQlen()<24) { return fail("Invalid server init"); }

        Cw  = rQ2(); Ch = rQ2(); // Screen size
        rQi += 16; // ignore bpp, depth, endian, true_color, pad

        debug("Screen: " + Cw + "x" + Ch);
        tmp = "connection to: " + rQstr(rQ4());

        C.width = Cw; C.height = Ch;
        modEvents(true);

        var i, n, arr = [0, 0,0,0, Cbpp*8, Cdepth*8,
            0,1,0,255,0,255,0,255, 0,8,16,0,0,0]; // pixelFormat
        arr.push(2, 0,0, encList.length); // clientEncodings
        for (i=0; i<encList.length; i++) {
            n = encList[i];
            arr.push((n>>24)&0xff, (n>>16)&0xff, (n>>8)&0xff, (n)&0xff);
        }
        send(arr, false, 0);

        state('normal', (wss?"E":"Une") + "ncrypted " + tmp);
        break;
    }
}

function normal_msg() {
    var msg_type = (FBU.rects === 0) ? rQ[rQi++] : 0;
    switch (msg_type) {
    case 0: return framebufferUpdate(); // false: need more data
    case 2: error("Bell Unsupported"); break;
    case 3:
        if (rQwait("ServerCutText", 8)) { rQi--; return false; }
        rQi+=3; // Pad
        debug("ServerCutText: " + rQstr(rQ4()));
        break;
    default: fail("Unsupported message type: " + msg_type);
    }
    return true;
}

function handle_message() {
    if (rQlen() === 0) {
        error("Empty receive queue");
    } else if (curS in offStates) {
        error("Data while disconnected");
    } else if (curS === 'normal') {
        if (normal_msg() && rQlen() > 0) {
            // true means we can continue processing
            // Give other events a chance to run
            if (! mTimer) {
                mTimer = setTimeout(function () {
                        mTimer = null; handle_message(); }, 10);
            }
        }
        // Compact the queue
        if (rQ.length > rQmax) {
            //debug("Compacting receive queue");
            rQ = rQ.slice(rQi);
            rQi = 0;
        }
    } else {
        init_msg();
    }
}

recv = function(e) {
    try {
        // base64 decode
        var str = window.atob(e.data), i = rQ.length, j;
        for (j=0; j < str.length; i++, j++) {
            rQ[i] = str.charCodeAt(j);
        }
        handle_message();
    } catch (exc) {
        if (typeof exc.stack !== 'undefined') {
            error("exception: " + exc.stack);
        }
        if (typeof exc.name !== 'undefined') {
            fail(exc.name + ": " + exc.message);
        } else {
            fail(exc);
        }
    }
};

// base64 encode and put on send queue, overridable for testing
send = function(arr, now, req) {
    if (typeof req === 'number') {
        // FBU request
        arr.push(3, req, 0,0, 0,0, Cw>>8,Cw&0xff, Ch>>8,Ch&0xff);
    }
    sQ += window.btoa(arr.map(function (c) {
            return String.fromCharCode(c); } ).join(''));
    if (now) {
        if (sQ && ws.bufferedAmount === 0) {
            if (! test) { ws.send(sQ); }
            sQ = "";
        }
        //else if (sQ) {
        //    debug("Delaying send");
        //}
    }
};

// FramebufferUpdate encodings

encFunc[0] = function() {  // RAW
    if (FBU.lines === 0) { FBU.lines = FBU.h; }

    var x = FBU.x, y = FBU.y + (FBU.h - FBU.lines), w = FBU.w,
        h = mM(FBU.lines, mF(rQlen()/(FBU.w * Cbpp)));
    FBU.bytes = w * Cbpp; // At least a line
    if (rQwait("RAW")) { return false; }
    blitImage(x, y, w, h, rQ, rQi);
    rQi += w * h * Cbpp;
    FBU.lines -= h;
    if (FBU.lines > 0) {
        FBU.bytes = FBU.w * Cbpp; // At least another line
    } else {
        FBU.rects -= 1;
        FBU.bytes = 0;
    }
    return true;
};

encFunc[1] = function() { // COPYRECT
    if (rQwait("COPYRECT", 4)) { return false; }
    var x1 = rQ2(), y1 = rQ2(), w = FBU.w, h = FBU.h;
    Ctx.drawImage(C, x1, y1, w, h, FBU.x, FBU.y, w, h);
    FBU.rects -= 1;
    FBU.bytes = 0;
    return true;
};

encFunc[5] = function() { // HEXTILE
    var subenc, subrects, c, d, i, j, p, r,g,b, xend, yend,
        x, w, y, h, xy, s, sx, sy, wh, sw, sh;

    if (FBU.t === 0) {
        FBU.tx = mC(FBU.w/16);
        FBU.ty = mC(FBU.h/16);
        FBU.t_total = FBU.tx * FBU.ty;
        FBU.t = FBU.t_total;
    }

    while (FBU.t > 0) {
        FBU.bytes = 1;
        if (rQwait("HEXTILE subenc")) { return false; }
        subenc = rQ[rQi];  // Peek
        if (subenc > 30) { // Raw
            return fail("Invalid HEXTILE subenc " + subenc);
        }
        subrects = 0;
        x = FBU.x + 16*  ((FBU.t_total - FBU.t) % FBU.tx);
        y = FBU.y + 16*mF((FBU.t_total - FBU.t) / FBU.tx);
        w = mM(16, (FBU.x + FBU.w) - x);
        h = mM(16, (FBU.y + FBU.h) - y);

        // Calc FBU.bytes
        if (subenc & 0x01) { // Raw
            FBU.bytes += w * h * Cbpp;
        } else {
            if (subenc & 0x02) { FBU.bytes += Cbpp; } // Background
            if (subenc & 0x04) { FBU.bytes += Cbpp; } // Foreground
            if (subenc & 0x08) { // AnySubrects
                FBU.bytes++;   // Since we aren't shifting it off
                if (rQwait("HEXTILE subrects header")) { return false; }
                subrects = rQ[rQi + FBU.bytes-1]; // Peek
                if (subenc & 0x10) { // SubrectsColoured
                    FBU.bytes += subrects * (Cbpp + 2);
                } else {
                    FBU.bytes += subrects * 2;
                }
            }
        }
        if (rQwait("HEXTILE")) { return false; }

        // We have a whole tile
        FBU.subenc = rQ[rQi++];
        if (FBU.subenc === 0) {
            c = FBU.bg;
            Ctx.fillStyle = "rgb("+c[0]+","+c[1]+","+c[2]+")";
            Ctx.fillRect(x, y, w, h);
        } else if (FBU.subenc & 0x01) { // Raw
            blitImage(x, y, w, h, rQ, rQi);
            rQi += FBU.bytes - 1;
        } else {
            if (FBU.subenc & 0x02) { // Background
                FBU.bg = rQ.slice(rQi, rQi + Cbpp);
                rQi += Cbpp;
            }
            if (FBU.subenc & 0x04) { // Foreground
                FBU.fg = rQ.slice(rQi, rQi + Cbpp);
                rQi += Cbpp;
            }

            // getTile
            d = []; r = FBU.bg[0]; g = FBU.bg[1]; b = FBU.bg[2];
            for (i = 0; i < (w * h * 4); i+=4) {
                d[i] = r; d[i+1] = g; d[i+2] = b;
            }

            if (FBU.subenc & 0x08) { // AnySubrects
                subrects = rQ[rQi++];
                for (s = 0; s < subrects; s++) {
                    if (FBU.subenc & 0x10) { // SubrectsColoured
                        c = rQ.slice(rQi, rQi + Cbpp);
                        rQi += Cbpp;
                    } else {
                        c = FBU.fg;
                    }

                    xy = rQ[rQi++]; sx = (xy>>4);   sy = (xy&0xf);
                    wh = rQ[rQi++]; sw = (wh>>4)+1; sh = (wh&0xf)+1;

                    // setSubTile
                    r = c[0]; g = c[1]; b = c[2];
                    xend = sx + sw; yend = sy + sh;
                    for (j = sy; j < yend; j++) {
                        for (i = sx; i < xend; i++) {
                            p = (i + (j * w) ) * 4;
                            d[p+0] = r; d[p+1] = g; d[p+2] = b;
                        }   
                    } 
                }
            }

            // putTile
            blitImage(x, y, w, h, d, 0);
        }
        FBU.bytes = 0;
        FBU.t -= 1;
    }
    if (FBU.t === 0) {
        FBU.rects -= 1;
    }
    return true;
};

encFunc[-223] = function() { // DesktopSize
    //debug(">> set_desktopsize");
    Cw = FBU.w;
    Ch = FBU.h;
    C.width = Cw; C.height = Ch;
    send([], false, 0); // New non-incremental request
    FBU.bytes = 0;
    FBU.rects -= 1;
    //debug("<< set_desktopsize");
    return true;
};


// Public API interface functions

api.connect = function(h, p) {
    host = h; port = p;
    if (!host || !port) { return fail("Must set host and port"); }
    state('connect');
};

api.disconnect = function() {
    state('disconnect', 'Disconnecting');
};

api.sendCAD = function() {
    if (curS !== "normal") { return false; }
    //debug("Sending Ctrl-Alt-Del");
    var i = 0, k, arr = [];
    for (; i < 3; i++) {
        k = [0xffe3, 0xffe9, 0xffff][i];
        arr = keyEvent(k, 1).concat(arr.concat(keyEvent(k, 0)));
    }
    send(arr, true, 1);
    return false;
};

api.testMode = function(override_send) {
    // Overridable internal functions for testing
    test = true;
    send = override_send;
    api.recv_message = recv;  // Expose it
};

// Sanity checks and initialization
try {
    Ctx = C.getContext('2d');
    if (! Ctx.createImageData) { throw("no createImageData method"); }
} catch (exc) {
    return state('fatal', "No working Canvas: " + exc);
}
if (!window.WebSocket) {
    return state('fatal', "No native WebSockets");
}

C.width = 640; C.height = 20;
init_vars();
setInterval(function (){
        if (curS === 'normal') {
            send([], true, 1);
        } }, req_rate);
state('loaded', 'noVNC ready: native WebSockets');
return api;  // Public API interface

}  // End of RFB()


// --- Main page render code ----------------------------------------
function getVar(name) {
    var re = new RegExp('[?][^#]*' + name + '=([^&#]*)');
    return (location.href.match(re) || ['', null])[1];
}

// Logging/debug
if (! window.console) { window.console = {'log': stub, 'error': stub}; }
error = function (msg) { console.error(msg); };
if (getVar('debug')) { debug = function (msg) { console.log(msg); }; }

function state(o, st, msg) {
    var s = $('S'), cb = $('CB'), cad = $('CAD'), c = "#ff4";
    cad.disabled = true;
    cad.onclick = o.sendCAD;
    cb.disabled = false;
    cb.value = "Connect";
    cb.onclick = function() { o.connect($('h').value, $('p').value); };
    if (st === 'normal') {
        cb.value = "Disconnect";
        cb.onclick = o.disconnect;
        cad.disabled = false;
    } else if (st in {'fatal':1, 'failed':1}) {
        cb.disabled = true;
    }
    switch (st) {
    case 'failed': case 'fatal':                       c = "#f44"; break;
    case 'loaded': case 'normal': case 'disconnected': c = "#eee"; break;
    }

    if (msg) {
        $('B').style.background = c;
        s.innerHTML = msg;
    }
}

window.onload = function (){
    $('h').value = getVar('host'); $('p').value = getVar('port');
    RFB($('vnc'), state, getVar('encrypt'), getVar('shared'));
};

