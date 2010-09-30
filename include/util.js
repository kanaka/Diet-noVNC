/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2010 Joel Martin
 * Licensed under LGPL-3 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 */

"use strict";
/*jslint bitwise: false, white: false */
/*global window, console, document, navigator, ActiveXObject */

// Globals defined here
var Util = {};


/*
 * Make arrays quack
 */

Array.prototype.push8 = function (num) {
    this.push(num & 0xFF);
};

Array.prototype.push16 = function (num) {
    this.push((num >> 8) & 0xFF,
              (num     ) & 0xFF  );
};
Array.prototype.push32 = function (num) {
    this.push((num >> 24) & 0xFF,
              (num >> 16) & 0xFF,
              (num >>  8) & 0xFF,
              (num      ) & 0xFF  );
};

/* 
 * ------------------------------------------------------
 * Namespaced in Util
 * ------------------------------------------------------
 */

/*
 * Logging/debug routines
 */

Util.log_level =  (document.location.href.match(
                    /logging=([A-Za-z0-9\._\-]*)/) ||
                    ['', 'warn'])[1];
_stub = function(m) {};
if (typeof window.console === "undefined") {
    window.console = {'log': _stub, 'warn': _stub, 'error': _stub};
}

Util.Debug = Util.Info = Util.Warn = Util.Error = _stub;
switch (Util.log_level) {
    case 'debug': Util.Debug = function (msg) { console.log(msg); };
    case 'info':  Util.Info  = function (msg) { console.log(msg); };
    case 'warn':  Util.Warn  = function (msg) { console.warn(msg); };
    case 'error': Util.Error = function (msg) { console.error(msg); };
    case 'none':
        break;
    default:
        throw("invalid logging type '" + level + "'");
}


// Set browser engine versions. Based on mootools.
Util.Features = {xpath: !!(document.evaluate), air: !!(window.runtime), query: !!(document.querySelector)};

Util.Engine = {
    'presto': (function() {
            return (!window.opera) ? false : ((arguments.callee.caller) ? 960 : ((document.getElementsByClassName) ? 950 : 925)); }()),
    'trident': (function() {
            return (!window.ActiveXObject) ? false : ((window.XMLHttpRequest) ? ((document.querySelectorAll) ? 6 : 5) : 4); }()),
    'webkit': (function() {
            try { return (navigator.taintEnabled) ? false : ((Util.Features.xpath) ? ((Util.Features.query) ? 525 : 420) : 419); } catch (e) { return false; } }()),
    //'webkit': (function() {
    //        return ((typeof navigator.taintEnabled !== "unknown") && navigator.taintEnabled) ? false : ((Util.Features.xpath) ? ((Util.Features.query) ? 525 : 420) : 419); }()),
    'gecko': (function() {
            return (!document.getBoxObjectFor && window.mozInnerScreenX == null) ? false : ((document.getElementsByClassName) ? 19 : 18); }())
};
