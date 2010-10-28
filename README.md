## Diet noVNC: noVNC (HTML5 VNC Client) without the sugar


### Description

Diet noVNC is a simplified version of
[noVNC](http://github.com/kanaka/noVNC). Diet noVNC is also licensed
under the [LGPLv3](http://www.gnu.org/licenses/lgpl.html).

Diet noVNC is just an *experiment* in shrinking noVNC down to the bare
minimum for a usable HTML5 VNC client.

noVNC is 120 KB of Javascript + HTML.

Diet noVNC is 22 KB of Javascript + HTML (less than 10 KB w/ Packer 3).


### Why?

That is a good question. Essentially, I was inspired by the Javascript
[10K Apart](http://10k.aneventapart.com/) contest to do something neat
using less than 10K of Javascript + HTML.  Unfortunately, the contest
was already done by the time I started.

Also, I enjoy applying minimalism to code (sometimes called "code
golf"). There is a deep hacker satisfaction from taking something
large and stripping it down to the bare essential. In some ways it is
similar to creating a Quine; both require a conceptual leap in
understanding of a given language.


### Caveats

Diet noVNC is not intended to replace noVNC in any sense. The amount
of data sent via the VNC protocol in just a few seconds can be orders
of magnitude larger than the size of the full noVNC client so the code
size is really a non-issue in practice.

Diet noVNC is not an example of good coding practices. While it passes
[JSLint](http://www.jslint.com/), I make liberal use of techniques
that have minimal code size, but that I would not use in regular code.

Other:

* All code modules have been combined into `vnc.js` and are no longer
  usable as standalone libraries.
* The API is more rigid, easy integration is not a core goal.
* There is less debug and stastics reporting.
* The data send and framebuffer request algorithms have been
  simplified and may not work as well with high latency connections.


### Missing

* `wsproxy` (WebSockets to TCP proxy script)
* WebSockets emulation (must have native WebSockets)
* VNC Password Authentication
* RRE protocol
* Tight PNG protocol
* Colour Map (non-true-color) support
* Local Cursor rendering
* Clipboard support
* 'info' and 'warn' logging levels
* sendKey API


### Still there

* Raw, CopyRect Hextile, and DesktopSize encodings
* Encryption (wss://) support via 'encrypt=1' query parameter.
* Some debug output (console) via 'debug=1' query parameter.
* Send CtlAltDel button
* Good performance (almost as good as noVNC).


### Usage

See the [noVNC README](http://github.com/kanaka/noVNC/) for full usage
instructions. You will probably need to run `wsproxy` from noVNC in
order to use Diet noVNC.

Diet noVNC does not support password authentication (another reason
not to use it for anyting except experimentation). If you use
`vncserver` to start your VNC server, you may need to make a copy of
the script and comment out the `authType` seting near the beginning of
the script.

Default connect parameters can be provided in the query string:
    
    http://example.com/vnc.html?host=HOST&port=PORT&encrypt=1&debug=1


