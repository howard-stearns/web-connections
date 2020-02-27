"use strict";

// Takes a f(...args) => promise into a f(..args) that does so one a time.
function serializePromises(make1Promise) {
    let last = Promise.resolve();
    return function (...args) {
        last = last.catch(_ => _).then(_ => make1Promise(...args));
        return last;
    }
}

function fixme(...args) {
    //console.log(...args);
}

// Dispatches typed message events to a receiver at a fixed id, but can send to many ids via the p2pSend method.
// E.g., A browser might have just one (subclass) intance of this to represent "our" id,
// or if impersonating two different receiving ids, there might be two of these. 
// Note: This defines the USAGE. The actual implementation might multiplex multiple ids over the same underlying "connection".
class P2pDispatch {
    constructor(id, receiver) { // Subclasses should return a Promise for the dispatch that resolves
        // when the underlying connection is open and ready for data.
        this.id = id;
        this.receiver = receiver;
    }
    p2pSend(to, type, data) {
        // Clients use this to send typed p2p messages. Subclasses define the internal connectionSend() to actually
        // send over the connection.
        // The data is anything that can be serialized as JSON (i.e., does not have to be pre-serialized).
        // The type argument is a string that names a method on the receiver for the specified specified id string.
        return this.sendObject({from: this.id, to, data, type});
        // FIXME: error handling!
    }
    p2pReceive(messageObject) {
        // Subclasses call this to receive a  string over the connection. The method specified by the message
        // type is called on the receiver directly, with the original (parsed) data.
        //
        // An alternative design might have been to not specify a receiver in the constructor, and to
        // instead have clients call dispatcher.addEventListener(type, handler). Alas, there is no standard way
        // to dispatch to an application-constructed typed event such that handler would be called with
        // an event that has a data property.
        //if (!this.receiver[messageObject.type] || ['lockResponse'].includes(messageObject.type)) fixme('fixme p2pReceive receiver:', !!this.receiver, messageObject.type, !!this.receiver[messageObject.type], this.id);
        if (messageObject.to !== this.id) return;
        this.receiver[messageObject.type](messageObject.data);
    }
    close() { }
}
class LoopbackDispatch extends P2pDispatch {
    constructor(id, receiver) {
        super(id, receiver);
        LoopbackDispatch.peers[id] = this;
        return Promise.resolve(this);
    }
    sendObject(messageObject) {
        LoopbackDispatch.peers[messageObject.to].p2pReceive(messageObject);
    }
    close() {
        super.close();
        delete LoopbackDispatch.peers[this.id];
    }
}
LoopbackDispatch.peers = {};
class RandomDelayLoopbackDispatch extends P2pDispatch {
    constructor(id, receiver) {
        super(id, receiver);
        RandomDelayLoopbackDispatch.peers[id] = this;
        this.messageQueue = []; // Messages are ordered.
        /* // FIXME
        this.poster = serializePromises(messageObject => {
            return new Promise((resolve, reject) => {
                setTimeout(_ => {
                    const peer = RandomDelayLoopbackDispatch.peers[messageObject.to]
                    fixme('poster', messageObject.type, messageObject.to, peer);
                    if (peer && peer.p2pReceive) { // E.g., not a delayed icecandidate after close
                        // FIXME: there's a similar situation for SSE!
                        peer.p2pReceive(messageObject);
                    }
                    resolve();
                }, 200 / *Math.random() * 200* /);
            });
        }) */
        return Promise.resolve(this);
    }
    sendObject(messageObject) {
        this.messageQueue.unshift(messageObject);
        setTimeout(_ => {
            const message = this.messageQueue.pop();
            const peer = RandomDelayLoopbackDispatch.peers[message.to]
            // FIXME: there's a similar situation for SSE!
            if (!peer || !peer.p2pReceive) return; // E.g., not a delayed icecandidate after close
            peer.p2pReceive(message);
        }, 200 /*Math.random()  200*/);
    }
    close() {
        super.close();
        delete RandomDelayLoopbackDispatch.peers[this.id];
    }
}
RandomDelayLoopbackDispatch.peers = {};
class WebSocketDispatch extends P2pDispatch {
    constructor(id, receiver) {
        super(id, receiver);
        return new Promise(resolve => {
            this.connection = new WebSocket(`${WebSocketDispatch.site}/${id}`);
            this.connection.onopen = _ => { this.connection.onopen = null; resolve(this); };
            this.connection.onmessage = event => this.p2pReceive(JSON.parse(event.data));
        });
    }
    sendObject(messageObject) {
        return this.connection.send(JSON.stringify(messageObject));
    }
    close() {
        super.close();
        this.connection.onmessage = null;
        this.connection.close();
        this.connection = null;
    }
}
WebSocketDispatch.site = ((location.protocol === 'https:') ? 'wss:' : 'ws:') + "//" + location.host;
class EventSourceDispatch extends P2pDispatch {
    constructor(id, receiver, eventTypes) {
        super(id, receiver);
        return new Promise(resolve => {
            this.eventTypes = eventTypes;
            this.connection = new EventSource(`/messages/${id}`);
            this.connection.onopen = _ => { this.connection.onopen = null; resolve(this); };
            // If we simply called fetch(..a..), fetch(..b..), the receiver might
            // see b before a. By serializing them, we ensure that the server sees AND RESPSONDS TO
            // these in order. (The implementation on the server will deliver a SSE before it responds
            // to the post.)
            this.poster = serializePromises(body => fetch('/message', {
                method: 'post',
                headers: {'Content-Type': 'application/json'},
                body: body
            }).then(r => { // fetch does not give errors on bad responses, so let's log them here.
                // Some browsers DO log bad responses in a way that looks like an error but isn't (and
                // annoyingly, you can't turn this off), but it doesn't give you the url nor the body.
                if (!r.ok) console.log(`${r.url} got ${r.statusText} when passed ${body}.`);
                return r;
            }));
            // One could imagine the server implementation sending a SSE with the JSON payload as
            // data, and not specifying any event. Then we could just do
            //    this.onmessage = event => this.p2pReceive(JSON.parse(event.data));
            // here, as we do for WebSocketDispatch.
            // Instead, the current implementation on the server does send the type as the SSE event,
            // which means we won't get a generic message event on the EventSource,
            // but rather a typed event that needs a handler added by addEventListener, and
            // removed by removeEventListner, below.
            this.dispatcher = event => this.p2pReceive(JSON.parse(event.data));
            eventTypes.forEach(type => this.connection.addEventListener(type, this.dispatcher));
        });
    }
    sendObject(messageObject) {
        return this.poster(JSON.stringify(messageObject));
    }
    close() {
        super.close();
        this.eventTypes.forEach(type => this.connection.removeEventListener(type, this.dispatcher));
        this.connection.close();
        this.connection = null;
    }
}



// Base class for signalling and resignalling of RTCPeerConnection.
// Subclasses (below) are specialized for different kinds of signalling message carriers, and illustrate what must be provided.
class RTCSignallingPeer {
    constructor(ourId, peerId, configuration = null) {
        this.id = ourId;
        this.peerId = peerId;
        const peer = this.peer = new RTCPeerConnection(configuration);
        this.events = ['icecandidate', 'offer', 'answer', 'lockRequest', 'lockResponse', 'gotTrack'];
        // FIXME: change these to add/removeEventListener, in case the application wants its own.
        peer.onnegotiationneeded = _ => this.negotiationneeded();
        // The spec says that a null candidate should not be sent, but that an empty string candidate should.
        // But Safari gets errors from empty candidate string.
        // FIXME try sending and making a=end-of-candidates at the the other end
        peer.onicecandidate = event => event.candidate && event.candidate.candidate
            && this.p2pSend('icecandidate', event.candidate) && fixme('sending candidate', this.id);
        // Support unknown. Can be overridden, of course.
        peer.onicecandidateerror = event => {
            // STUN errors are in the range 300-699. See RFC 5389, section 15.6
            // for a list of codes. TURN adds a few more error codes; see
            // RFC 5766, section 15 for details.
            // Server could not be reached are in the range 700-799.
            console.error('ice code:', event.errorCode, event);
        };
        this.queue = Promise.resolve();
        //peer.onconnectionstatechange = _ => console.log(this.id, 'connection state', peer.connectionState);
        //peer.onsignalingstatechange = _ => console.log(this.id, 'signalling state', peer.signalingState);
        //peer.oniceconnectionstatechange = _ => console.log(this.id, 'ice connection state', peer.iceConnectionState);
        /*
        this.ontrack = event => {
            fixme('ontrack at', this.id, 'lockResponse:', !!this.lockResponse);
            this.p2pSend('track', {
                streams: event.streams.map(s => s.id),
                kind: event.track.kind});
        };
        peer.addEventListener('track', this.ontrack);
        */
        
        //peer.onicegatheringstatechange = _ => console.log(this.id, 'ice gathering state', peer.iceGatheringState);
        return new this.constructor.dispatchClass(ourId, this, this.events).then(dispatch => {
            this.p2pDispatcher = dispatch;
            return this;
        });
    }
    p2pSend(type, message) {
        return this.p2pDispatcher.p2pSend(this.peerId, type, message);
    }
    // Not all RTCPeerConnection implementations fire connectionstatechange or other indication of closure.
    close() { // So use this to allow cleanup.
        const peer = this.peer;
        fixme('close', this.id);
        peer.onnegotiationneeded = peer.onicecandidate = null;
        //peer.removeEventListener('track', this.ontrack);
        peer.close();
        this.p2pDispatcher.close();
    }
    // Executes thunk with a mutex between the pairs.
    // That is, thunk will wait until the cross-network mutex has been obtained.
    // Thunk can be an async function, or it can return a promise, and the mutex is released automatically
    // when the async completes or resolves, or upon timeoutMs elapsing.
    // The aquireLock method itself return a promise that resolves when the thunk does, and it resolves to
    // whatever the promise or thunk returned, or null if there was an error or rejection in the thunk.
    // The mutex exists only between the two pairs. It does not effect other RTCSignallingPeers, even in the same browser.
    acquireLock(thunk, timeoutMs = 5000) {
        // FIXME? Should this be used around negotiation needed instead of createDataChannel/addStream?
        var timeout;
        fixme('attempting to acquireLock at', this.id);
        return this.queue = this.queue
            .then(_ => new Promise((resolve, reject) => {
                fixme('aquireLock processing at', this.id);
                timeout = setTimeout(_ => {fixme('lock timeout!', this.id); reject()}, timeoutMs);
                this.lockResponse = _ => {
                    fixme('acquire lock at', this.id);
                    this.acquired = true;
                    const thunkResult = thunk();
                    if (thunkResult.then) {
                        thunkResult.then(resolve, reject);
                    } else {
                        resolve(thunkResult);
                    }
                }
                this.p2pSend('lockRequest');
            }))
            .catch(_ => null)
            .then(value => {
                clearTimeout(timeout);
                const hasPending = this.peerLockPending;
                fixme('completed locked work at', this.id, 'hasPending:', !!hasPending);
                this.lockResponse = this.peerLockPending = this.acquired = null;
                if (hasPending) {fixme('sending lockResponse', this.id); this.p2pSend('lockResponse');}
                return value;
            })
    }
    lockRequest() {
        // FIXME: do coverage-analaysis and make sure all branches are exercised.
        if (this.acquired || (this.lockResponse && !this.isPolite())) {
            fixme('delaying lockResponse at', this.id);
            this.peerLockPending = true;
        } else {
            fixme('responding to lockRequest at', this.id);
            this.p2pSend('lockResponse');
        }
    }
    createDataChannel(label = "data", options = {}) {
        fixme('createDataChannel', this.id);
        return this.acquireLock(_ => {
            const channel = this.peer.createDataChannel(label, options);
            return new Promise(resolve => channel.onopen = _ => resolve(channel));
        });
    }
    addStream(stream) {
        fixme('addStream', this.id);
        return this.acquireLock(_ => {
            if (!stream) return; // If it went away by the time we got a lock.
            const tracks = stream.getTracks();
            var nOutstandingTracks = tracks.length;
            fixme('adding tracks', this.id);
            tracks.forEach(track => this.peer.addTrack(track, stream));
            fixme('added tracks', this.id);
            /*
            return new Promise(resolve => {
                var that = this;
                function track({streams, kind}) {
                    fixme('got notice of track', kind, streams, that.id);
                    if (!streams.includes(stream.id)) return;
                    // Track ids are not the same at each end. But we really only care about the quantity.
                    if (--nOutstandingTracks > 0) return;
                    this.track = null;
                    resolve(stream);
                }
                this.track = track;
            });
            */
            return new Promise(resolve => {
                var that = this;
                function checkSignalingState() {
                    fixme('signaling state', that.peer.signalingState, that.id);
                    if (that.peer.signalingState === 'stable') {
                        that.peer.removeEventListener('signalingstatechange', checkSignalingState);
                        resolve(stream);
                    }
                }
                this.peer.addEventListener('signalingstatechange', checkSignalingState);
            });
        });
    }
    icecandidate(iceCandidate) { // We have been signalled by the other end about a new candidate.
        this.peer.addIceCandidate(iceCandidate)
            //FIXME .then(_ => fixme('ice ok', this.id), e => fixme('ice fail', this.id, e.message))
            .catch(console.error)
    }
    inRace() { // When checked within negotiationneeded or offer handlers, indicates that we are already negotiating.
        // See https://blog.mozilla.org/webrtc/perfect-negotiation-in-webrtc/
        // Using this, I can get Firefox to work ALMOST all the time without using acquireLock.
        // But Chrome and Safari don't work.
        //return this.peer.signalingState !== 'stable';
        return false; // So, let's just rely on aquireLock instead.
    }
    isPolite() { // Exactly one a peer pair must defer to the other in race conditions.
        // It cannot be by role, because a peer can be master to ther other's slave for one thing,
        // and simultaneously the reverse for another.
        return this.id < this.peerId; // FIXME run tests the other way and see if anything are senstive to order
    }

    // When we add a stream or channel, or conditions change, we get this event to (re)start the signalling process.
    negotiationneeded() {
        fixme('negotiationneeded at', this.id,
                    'has pending:', !!this.peerLockPending,
                    'is polite:', !!this.isPolite(),
                    'seeking lock response:', !!this.lockResponse,
                    'has lock:', !!this.acquired
                   );
        if (!this.lockResponse) {
            return this.acquireLock(_ =>  {
                this.negotiationnneded();
                return new Promise(resolve => {
                    this.fixmehack = resolve;
                });
            });
        }
        const peer = this.peer;
        if (this.inRace()) return; // It is possible to have this queued after an offer
        peer.createOffer().then(offer => {
            if (this.inRace()) return; // We might have set a remote offer while creating our own.
            peer.setLocalDescription(offer) // promise does not resolve to offer
                .then(_ => fixme('sending offer at', this.id))
                .then(_ => this.p2pSend('offer', offer));
        });
    }
    offer(offer) { // Handler for receiving an offer from the other user (who started the signalling process).
        // Note that during signalling, we will receive negotiationneeded/answer, or offer, but not both, depending
        // on whether we were the one that started the signalling process.
        fixme('got offer at', this.id);
        const peer = this.peer;
        // If we are the impolite half of a pair, we completely ignore offers that come in while we are negotiating.
        if (this.inRace() && !this.isPolite()) return;
        Promise.all([
            this.inRace() // Buf if we're polite, roll our local offer back in parallel to noting theirs.
                ? peer.setLocalDescription({type: 'rollback'})
                : Promise.resolve(),
            peer.setRemoteDescription(offer)
        ])
            .then(_ => peer.createAnswer())
            .then(answer => peer.setLocalDescription(answer)) // promise does not resolve to answer
            .then(_ => this.p2pSend('answer', peer.localDescription));
    }
    answer(answer) { // Handler for finishing the signalling process that we started.
        this.peer.setRemoteDescription(answer)
            .then(_ => { if (this.fixmehack) this.fixmehack(); });
    }
}

/* As an example of use, here's a subclass where both peers have to be in the same browser, and 
   p2pSend just passes the data directly to the other peer. Real-world subclasses are below.
*/
//const loopbackPeers = {};
class LoopbackRTC extends RTCSignallingPeer { }
LoopbackRTC.dispatchClass = LoopbackDispatch;
class RandomDelayLoopbackRTC extends LoopbackRTC { }
RandomDelayLoopbackRTC.dispatchClass = RandomDelayLoopbackDispatch;


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

class WebSocketRTC extends RTCSignallingPeer { }
WebSocketRTC.dispatchClass = WebSocketDispatch;

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

class EventSourceRTC extends RTCSignallingPeer {
    /*p2pSend(type, message) {
        const body = JSON.stringify({type, from: this.id, to: this.peerId, data: message});
        return this.poster(body).then(response => response.ok ? response
                                      : this.signallingError(type, this.id, this.peerId, response));
    }*/
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
EventSourceRTC.dispatchClass = EventSourceDispatch;
