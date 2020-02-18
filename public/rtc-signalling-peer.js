"use strict";

// Base class for signalling and resignalling of RTCPeerConnection.
// Subclasses (below) are specialized for different kinds of signalling message carriers, and illustrate what must be provided.
class RTCSignallingPeer {
    constructor(ourId, peerId, configuration = null) {
        this.id = ourId;
        this.peerId = peerId;
        const peer = this.peer = new RTCPeerConnection(configuration);
        this.events = ['icecandidate', 'offer', 'answer'];
        peer.onnegotiationneeded = _ => this.negotiationneeded();
        // The spec says that a null candidate should not be sent, but that an empty string candidate should.
        // But Safari gets errors from empty candidate string.
        peer.onicecandidate = event => event.candidate && event.candidate.candidate
            && this.p2pSend('icecandidate', event.candidate);
        // Support unknown. Can be overridden, of course.
        peer.onicecandidateerror = event => {
            // STUN errors are in the range 300-699. See RFC 5389, section 15.6
            // for a list of codes. TURN adds a few more error codes; see
            // RFC 5766, section 15 for details.
            // Server could not be reached are in the range 700-799.
            console.error('ice code:', event.errorCode, event);
        };
        
        //peer.onconnectionstatechange = _ => console.log(this.id, 'connection state', peer.connectionState);
        //peer.onsignalingstatechange = _ => console.log(this.id, 'signalling state', peer.signalingState);
        //peer.oniceconnectionstatechange = _ => console.log(this.id, 'ice connection state', peer.iceConnectionState);
        //peer.onicegatheringstatechange = _ => console.log(this.id, 'ice gathering state', peer.iceGatheringState);
    }
    // Not all RTCPeerConnection implementations fire connectionstatechange or other indication of closure.
    close() { // So use this to allow cleanup.
        const peer = this.peer;
        peer.onnegotiationneeded = peer.onicecandidate = null;
        peer.close();
    }
    icecandidate(iceCandidate) { // We have been signalled by the other end about a new candidate.
        this.peer.addIceCandidate(iceCandidate)
            .catch(e => setTimeout(_ => alert(`CONNECTION ADD ICE FAILED id: ${this.id}, candidate: ${iceCandidate.candidate}, error: ${e.name}: ${e.message}`), 0));
    }
    // When we add a stream or channel, or conditions change, we get this event to (re)start the signalling process.
    negotiationneeded() {
        const peer = this.peer;
        var offer;
        peer.createOffer()
            .then(result => offer = result)
            .then(_ => peer.setLocalDescription(offer)) // promise does not resolve to offer
            .then(_ => this.p2pSend('offer', offer));
    }
    offer(offer) { // Handler for receiving an offer from the other user (who started the signalling process).
        // Note that during signalling, we will receive negotiationneeded/answer, or offer, but not both, depending
        // on whether we were the one that started the signalling process.
        const peer = this.peer;
        var answer;
        peer.setRemoteDescription(offer)
            .then(_ => peer.createAnswer())
            .then(result => answer = result)
            .then(_ => peer.setLocalDescription(answer)) // promise does not resolve to answer
            .then(_ => this.p2pSend('answer', answer));
    }
    answer(answer) { // Handler for finishing the signalling process that we started.
        this.peer.setRemoteDescription(answer);
    }
}

/* As an example of use, here's a subclass where both peers have to be in the same browser, and 
   p2pSend just passes the data directly to the other peer. Real-world subclasses are below.
*/
const loopbackPeers = {};
class LoopbackRTC extends RTCSignallingPeer {
    constructor(eventSource, ourId, peerId, configuration = null) {
        super(ourId, peerId, configuration);
        loopbackPeers[ourId] = this;
    }
    p2pSend(type, message) {
        loopbackPeers[this.peerId][type](message);
    }
}


/*
Signalling over WebSockets:

WebSocket makes logical sense for signalling, but the word on the Web seems to be that it does not scale well.
1. Client is limited to about 200 WebSockets per server/page (browser-specific). This implementation works around
   that by multiplexing communications for all RTCSignallingPeer instances over a single WebSocket per page,
   rather than having the page open a socket for each RTCSignllingPeer that it will interact with.
2. Server is limited to about 1000 WebSockets. Since either client of a pair might need to resignal, both ends
   have to keep their WebSockets open the whole time that they use the RTCPeerConnection, even if there is no
   traffic. So, we would need concurrency/1000 servers, and a message buss between servers (to route messages
   from a client on one server to the correct server for the other client.
3. Front end / load balancers / reverse proxies (such as NGINX) typically work at the HTTP level, not the
   the TCP level that WebSockets operate at, so it may be difficult or impossible for such to provide their
   benefits with WebSockets. My guess is that this may be true of client-side forward proxies as well, which may
   matter for mobile.
4. HTTP/2 has significant scaling advantages, but isn't compatible with WebSockets.
5. Mobile devices and carriers don't like to leave sockets open indefinitely. (SSE, below, behaves similarly to
   the various proprietary mechanism to push an event to a mobile device, and so is more likely to be adaptable.)
Thus WebSockets may ultimately be a dead end. Nonetheless, they're familiar, so the following provides a sample
client use. 

The server at this site provides a simple service like the following, meant to illustrate how the multiplexing works:

const wss = new require('ws').Server({ server }), wsRegistrants = {};
wss.on('connection', function (ws, req) {
    const url = new URL(req.url, CANONICAL_HOST), id = url.pathname.slice(1);
    wsRegistrants[id] = ws;
    ws.on('message', function (data) {
        const message = JSON.parse(data), destination = wsRegistrants[message.to];
        if (id !== message.from) return ws.terminate();
        if (!destination) return ws.terminate(); // Just close the connection, just as if client were directly connected to the destination.
        destination.send(data);
    });
    ws.on('close', function () { delete wsRegistrants[id]; });
});

Example use in browser:
const ourId = 'A', peerId = 'B', ws = new WebSocket(`wss://${host}/${ourId}`);
ws.onopen = _ => { const connection = new WebSocketRTC(ws, ourId, peerId); ..... }
*/

class WebSocketRTC extends RTCSignallingPeer {
    constructor(webSocket, ourId, peerId, configuration = null) {
        super(ourId, peerId, configuration);
        this.webSocket = webSocket;
        // Each WebSocketRTC adds it's own listener to the shared webSocket, each of which ignores messages
        // that are not for it. (Yes, each one is parsing the message, but by using WebSockets, the
        // the scalability ship has already sailed.)
        this.messageListener = messageEvent => {
            const message = JSON.parse(messageEvent.data);
            if (message.from !== this.peerId) return;
            this[message.type](message.data);
        };
        webSocket.addEventListener('message', this.messageListener);
    }
    close() {
        this.webSocket.removeEventListener('message', this.messageListener);
        super.close();
    }
    p2pSend(type, message) { // Create json message with metadata and send it up the socket.
        this.webSocket.send(JSON.stringify({type: type, from: this.id, to: this.peerId, data: message}));
    }
}

/*
Signalling with ordinary GET to send messages, and Server-Side Events to receive them.  

Use of this class in the browser is similar to above:
const ourId = 'A', peerId = 'B', sse = new EventSource(`/messages/${ourId}`);
ws.onopen = _ => { const connection = new EventSourceRTC(ws, ourId, peerId); ..... }

The server provides two endpoints:
  /messages/X - Pushes responses providing typed messageEvents on the EventSource. 
                   The forwarder below attaches to the signalling events and checks that they
                   are from our peer.
  /message?type=W&to=X&from=Y&data=Z - Server routes the data to X's event source.
*/

// Takes a f(...args) => promise into a f(..args) that does so one a time.
function serializePromises(make1Promise) {
    let last = Promise.resolve();
    return function (...args) {
        last = last.catch(_ => _).then(_ => make1Promise(...args));
        return last;
    }
}
class EventSourceRTC extends RTCSignallingPeer {
    constructor(eventSource, ourId, peerId, configuration = null) {
        super(ourId, peerId, configuration);
        this.eventListener = this.forwarder.bind(this);
        this.events.forEach(type => eventSource.addEventListener(type, this.eventListener));
        // Ensure that this peer's outgoing signalling messages are done in serial.
        // Multiple peers in the same browser can overlap in parallel.
        this.poster = serializePromises(body => fetch('/message', {
            method: 'post',
            headers: {'Content-Type': 'application/json'},
            body: body
        }));
    }
    close() {
        // Consider what happens when we create this to communicate with a given peerId,
        // and close it, and then instantiate it again for the same peerId. We don't want
        // the event listener to continue to send to the closed instance.
        this.events.forEach(type => eventSource.removeEventListener(type, this.eventListener));
        super.close();
    }
    forwarder(messageEvent) {
        const message = JSON.parse(messageEvent.data);
        if (message.from !== this.peerId) return;
        this[messageEvent.type](message.data);
    }
    p2pSend(type, message) {
        const body = JSON.stringify({type, from: this.id, to: this.peerId, data: message});
        return this.poster(body).then(response => response.ok ? response
                                      : this.signallingError(type, this.id, this.peerId, response));
    }
    signallingError(type, from, to, response) { // Can be overriden.
        // Handle an asynchronous communication error during signalling (e.g., from p2pSend)
        // Note that Chrome will report 404 from fetch in the console as if by console.error, without
        // actually signalling an error. (The spec says no error is signalled, but it doesn't prevent
        // Chrome from being annoying noisy about it. See
        // https://stackoverflow.com/questions/4500741/suppress-chrome-failed-to-load-resource-messages-in-console/30847631#30847631
        console.error(type, from, to, response.status, response.url, response.statusText);
        return response;
    }
}

                                          
