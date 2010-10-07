## Diet noVNC: noVNC (HTML5 VNC Client) but without the sugar


### Description

Diet noVNC is a simplified version of
[noVNC](http://github.com/kanaka/noVNC). Diet noVNC is also licensed
under the [LGPLv3](http://www.gnu.org/licenses/lgpl.html).

Diet noVNC is *just an experiment* in shrinking noVNC down to the bare
minimum for a usable HTML5 VNC client. noVNC is 110K of Javascript,
Diet noVNC is 41K of Javascript (18K minified).


### Missing features and limitations

The following features of noVNC have been removed:

* wsproxy 
* WebSockets emulation (must have native WebSockets)
* RRE protocol
* Tight PNG protocol
* Colour Map (non-true-color) support
* Local Cursor rendering
* Clipboard support
* 'info' logging level
* sendKey API

Other notes:

* All code modules have been combined into vnc.js and are no longer
  usable as standalone libraries.
* The API is more rigid. Diet noVNC does not have easy integration
  as a core goal.
* There is less debug and stastics reporting



