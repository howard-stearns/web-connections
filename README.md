# Web Connections

A test bed for investigating p2p connectivity between web pages.

## status

Moving now from an initial PoC, towards a _reference implementation_. 

Needs testing/cleanup, and then design/code review. (This is a situation where "we don't know what we don't know", and thus the design is still a bit too "organic".) _**I need to meet with Alan/Jazmin/Jess about the test Web page design.**_

Soliciting feedback on Recommendations, below.

## synopsis

1. An [**RTCSignalingPeer** class](https://github.com/howard-stearns/web-connections/blob/master/public/rtc-signaling-peer.js#L261) wraps both RTCPeerConnection, _and_ signaling. 
  - While the peer and its events are still available to applications, application-level methods are provided to add a data channel or a media stream. Different forms of signaling are handled by subclasses. (API below.)
  - Internally, a **signaling protocol** is defined, with [implementations](https://github.com/howard-stearns/web-connections/blob/master/public/rtc-signaling-peer.js#L17) that use WebSockets (WS), or EventSource (SSE), or other mechanism for testing purposes. (This could be extended to, e.g., an overlay gossip network of peers, or Croquet, or other mechanisms, but there's no current need.)
  - A small reference nodejs **signaling server** for WS and SSE matching the above. The latter also has provisions for listing the currently available peers. ([source](https://github.com/howard-stearns/web-connections/blob/master/index.js))
2. **Testing**
  - A [**unit test suite**](https://web-connections.herokuapp.com/SpecRunner.html) that exercises this between two peers in the same browser, through a matrix of (_specific-tests_ X _signaling-mechanism_). ([source](https://web-connections.herokuapp.com/browser-spec.js)) There are currently 21 specific tests, including various forms of "doing two things at once". There are four signaling-mechanisms tested: WS, SSE, direct "loopback" calls (because both peers are in the same browser), and loopback with a random delay for each message.
  - A [**performance test page**](https://web-connections.herokuapp.com/) that tests for basic functionality, and then makes various performance tests of WS and SSE against the server and of RTCSignalingPeer against all other browsers that are still on that page. The performance tests repeat every 30 minutes. ("Credits" are given as an incentive to keep the page up, and as a crude test of whether people will contribute resources if it is easy enough.) 

Note: This is entirely Javascript. There is not yet a C++ implementation of RTCSignalingPeer.

## Recommendations

At this point, I think different teams should gain as much direct experience with RTC as they can, and do whatever is most convenient for their own needs. (Run fast and learn stuff. Don't bother with the reference implementation for a PoC (e.g., where there is no design review,) unless you want to.)

However, as people come to face various design choices, it might pay to make those choices based on the findings here, and on the following considerations. (E.g., each project design review should have answers for the following.)

1. What application-level operations are needed? The reference implementation provides a very small set of specific operations that can be performed robustly. Do we need more? Or in a more convenient form? (See API below.)

2. Does it work on our target platforms (especially phones) and networks? How do you know? Currently, all unit tests in this repo work on iOS/Safari, Android/Chrome, Win/Chrome, Win/Firefox, OSX/Safari, OSX/Chrome, OSX/Firefox. (Win/Edge occassionally fails. See Performance.) The cross-browser test page works in my own testing of all combinations of the above (including cellular connections), but _**field testing remains to be done**_. 

3. What other considerations are required (such as TURN, or performance impact)? Currently, the test page uses Google STUN and mooches off of some random TURN that isn't always up. (You can see errors in the console with 700-series status codes, meaning not available. _**I need to capture that to our data.**_) It looks like we are indeed falling back to TURN in some browser combinations. _**We're going to have to figure out where this leaves us.**_ E.g., is the incidence low enough that we can afford to provide enough of our own TURN servers? Or do we need another answer? Also, I'd like to know how much packet loss and delay we can survive. (_**Gotta design some repeatable/test-coordinated networking fuzzing so that we can measure these.**_)

4. Does it play nice with others? E.g., if another part of the application also uses rtc, can they coexist? Do they share the RTCPeerConnection or signaling channel? Do they share an id namespace? Can they listen for signals independently, or have you used onMumble (which removes other such signal handlers)? _**The reference implementation purports to be reusable by different apps, and yet the test page uses different peers when it is the tester vs the testee, and generates a different id for each role. So it is not yet proven that the RTCSignalingPeer can actually be re-used by different parts of the app!**_

5. How do you handle disconnects - either network outage or the other end quitting abruptly? Note that both WS and SSE get interrupted, especially with intermediate front-ends (e.g., Nginx), phone systems, home routers, VPN, etc. I don't care how often you send pings or heartbeats, the connection will go down. The reference implementation maintains an ESS connection to the server (so that we know what ids are available to test against) and re-attaches if it goes away. It also checks at both ends for ping timeouts. **However:** 1. It doesn't currently terminate/reconnect for ping timeouts detected on the client side (only on the server side). 2. It doesn't do anything special for rtc disconnects. (How should we tell? There is no RTCPeerConnection close event (although there is a poorly supported connectionstatechange, and an RTCDataChannel close event.) 3. The tests don't check this. (How?)

6. How do you handle versioning, such as when the server is reved but clients in the field are still running. In the reference implementation, peers report their availability to others by making an ESS connection. (See previous.) Upon connecting, they are told the version of the server, and if this doesn't match, the page reloads and gets the current Javascript.

7. How do you handle "glare"? This is when two (or more) signaling handshakes overlap between the same peers. It can happen in application-controllable ways (such as when two data channels are asynchronously but simultaneously added by different parts of the app), and also in uncontrollable normal operation (such as when network weather causes both sides to separately signal negotiationneeded at the same time). The unit tests show that a straightforward use of the signaling code from the many Web examples do _not_ function in the presence of glare. This [Mozilla Blog](https://blog.mozilla.org/webrtc/perfect-negotiation-in-webrtc/) suggests that the examples can be modified in a specific way to survive glare. While the unit tests show that these modifications do work for Firefox-to-Firefox, _they do not work when other browsers are involved_ (including Android/Chrome or iOS/Safari). So instead, the reference implementation has an internal acquireLock utility that serializes all signal-producing activity (createDataChannel, addStream, and negotiationnneded) across the wire so that only one can occur at a time between the two peers.

8. How will the signaling scale on servers? While there seems to be a lot of evidence that the "big boys" are using SSE rather than WS for big connected apps, I don't think anyone can afford 10-100 M always-on connections of either. _**I think that ultimately we'll need some sort of overlay gossip network built on those of our peers that are online.**_ Best practice is to clearly spearate the functionality of the signaling mechanism, and be able to re-run tests to prove it works.

## Data

**What's Missing:** (in modern browsers, including mobile but not Internet Explorer):

| what                        | where                            | % users | notes |
|----------------------------:|:---------------------------------|:-------:|-------|
| **data channels**           | Edge (intermittent)              | TBD!    |       |
| **TURN required**           | cellular? TBD!                   | TBD!    |       |
| **_any_ other RTC failure** | TBD!                             | TBD!    |       |
| **Speech-to-Text**          | missing everywhere except Chrome | TBD!    | Android chrome beeps annoyingly at start of capture|
| **captureStream**           | Safari                           | TBD!    |       |


_**I need to get lists from Sam and Chris for feature detection reporting.**_

_**TBD: What data is meaningful as to how many people contribute how much computing time?**_


**Performance:** Very rough typical figures (averaged by eye over a small sample):

|                    |setup (ms)  | ping (ms) | bandwidth (kb/s)            |
|-------------------:|:----------:|:---------:|:---------------------------:|
| web sockets        | 200-700    | 75-100    | 750-1,100                   |
| server-side events | 80-400     | 85-400    | 750-1,600                   |
| rtc data channel   | 1,000-3,000*| 30-300    | 500-2,000                   |
| rtc media          | 250-1,300*  | 30-150    | 35 audio, 1,200 video       |

- Ping time is round trip to _server_ and back for ws and sse, and to peer and back for data channel. For media, it is "round trip time" from the rtc stats (ignoring peers that are on the same local network).
- Bandwidth for ws, sse, and data channel is crudely computed from time to send a bit more than 30kB (and therefore requires several packets). The data channel is configured as reliable and ordered (defaults), and I ignored peers on the same local network.
- Bandwidth for media is from the stats bytesSent and the test runtime.

(_**I'm thinking we should probably get a true average and one-std-deviation below. I expect we would find that it is bimodal for wifi separate from cellular, but we don't have a way to check whether someone is on cellular.**_)

## Primary API

The reference implemention provides the following API for application-level code to use. Note that _createDataChannel_ and _addStream_ are provided as high-level (application-level) operations rather manipulating the RTCPeerConnection directly. (See the "glare" section of Recommendataions, above.)

**RTCSignalingPeer**(localId, remoteId, RTCConfigurationDictionary) => a promise that resolves to an instance that is ready to use (creating or reusing the underlying signaling channel and ensureing that it is ready for use). The ids are arbitrary/unstructured strings. _**(Given the application-level methods that follow, maybe there's no need for this to be a promise, as createDataChannel/addStream could just wait until the signaling channel is ready.)**_

Subclasses **EventSourceRTC**, and **WebSocketRTC**.

RTCSignalingPeer#**createDataChannel**(labelString, channelOptionsDictionary, arcaneOptions) => a promise that resolves to a ready to use (open) RTCDataChannel. Can be used multiple times, with other calls to createDataChannel or addStream overlaping before resolution.

RTCSignalingPeer#**addStream**(mediaStream) => a promise that resolve to a ready to use media stream (the same as was given). Can be used multiple times, with other calls to createDataChannel or addStream overlaping before resolution.

RTCSignalingPeer#**close**() => Should be explicitly called by the application to close the connection and free resources.

RTCSignalingPeer#**peer** => The RTCPeerConnection.

## Internal/Implementation API

_**FIXME**: acquireLock (anti-glare), underlying signaling channel protocol, getting a listing of available peers, mechanism to detect disconnect and reconnect, mechanism to handle versioning, ..._