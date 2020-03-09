"use strict";

// Takes a f(...args) => promise and returns a f(..args) that does so one a time.
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


// P2P DISPATCHERS: Used by the signaling classes to carry p2p messages.

// Dispatches typed message events to a receiver at a fixed id, but can send to many ids via the p2pSend method.
// There can be one id with multiple P2pDispatch for different receivers (e.g., that are paired to different peers at different ids).
// There can also be multiple P2pDispatch ids in the same browser.
// The recevier object has two requirements:
// 1. It must have a method for every message to be received.
// 2. It must have a property called 'peerId', that must match the message.from of messages to be acted on.
// Note: This defines the USAGE. The actual implementation might multiplex multiple ids over the same underlying "connection".
class P2pDispatch {
    // Subclasses should return a Promise for the dispatch that resolves
    // when the underlying connection is open and ready for data.
    constructor(id, receiver) { 
        this.id = id;
        this.receiver = receiver;
    }
    p2pSend(to, type, data) {
        // Clients use this to send typed p2p messages. Subclasses define the internal sendObject() to actually
        // send over the connection.
        // The data is anything that can be serialized as JSON (i.e., does not have to be pre-serialized).
        // The type argument is a string that names a method on the receiver that has an id specified by to.
        return this.sendObject({from: this.id, to, data, type});
        // FIXME: error handling!
    }
    p2pReceive(messageObject) {
        // Subclasses call this to receive a  string over the connection. The method specified by the message
        // type is called on the receiver directly, with the original (parsed) data.
        //
        // An alternative design might have been to not specify a receiver in the constructor, and to
        // instead have clients call dispatcher.addEventListener(type, handler). Alas, there is no standard way
        // to dispatch to an application-constructed typed event such that the handler would be called with
        // an event that has a data property.

        // Note that dipatching to your own id will deliver at every dispatcher with that id!
        // It would not work to have the semantics be that 'from' is really a concatnation of both peer ids, because
        // you could have multiple rtc instances (multiple receivers) between a given pair.
        const peer = this.receiver.peerId;
        if (peer && (messageObject.from !== peer)) return // normal. Next line would indicate a bug, though.
        if (messageObject.to !== this.id) return console.warn(`${messageObject.type} to ${messageObject.to} received at ${this.id}`);
        // untyped messages must be handled by an application-specific onmessage handler.
        if (messageObject.type) this.receiver[messageObject.type](messageObject.data, messageObject);
    }
    // Not every subclass connection has a close event that we can attach to for doing cleanup. So instead, clients should
    // call this close method explicitly. (And subclasses will extend this method to close the underlying connection as needed.)
    close() { }
}

// Simplest example, useful for testing two instances IN THE SAME BROWSER. It just keeps a shared dictionary of instances
// within the class. The sendObject method calls p2pReceive directly on the instance found in the dictionary.
class LoopbackDispatch extends P2pDispatch {
    constructor(id, receiver) {
        super(id, receiver);
        const dispatchers = this.constructor.peers[id] = (this.constructor.peers[id] || []);
        dispatchers.push(this);
        return Promise.resolve(this); // Following the rule that the constructor must return a promise that resolves to instance.
    }
    sendObject(messageObject) {
        this.constructor.peers[messageObject.to].forEach(dispatcher => dispatcher.p2pReceive(messageObject));
    }
    close() {
        if (!this.id) return;
        super.close();
        const dispatchers = this.constructor.peers[this.id];
        dispatchers.splice(dispatchers.indexOf(this), 1);
        if (!dispatchers.length) delete this.constructor.peers[this.id];
        this.id = null;
    }
}
LoopbackDispatch.peers = {};

// Same as LoopbackDispatch, but with a random delay before dispatching.
class RandomDelayLoopbackDispatch extends P2pDispatch {
    constructor(id, receiver) {
        super(id, receiver);
        const dispatchers = this.constructor.peers[id] = (this.constructor.peers[id] || []);
        dispatchers.push(this);
        this.messageQueue = []; // Messages are ordered.
        return Promise.resolve(this);
    }
    sendObject(messageObject) {
        // Adds one message to the queue, sets a random timer to FIFO one message out later, but it might not be our message!
        this.messageQueue.unshift(messageObject);
        setTimeout(_ => {
            const message = this.messageQueue.pop();
            const dispatchers = this.constructor.peers[message.to]
            dispatchers.forEach(dispatcher => dispatcher.p2pReceive(message));
        }, Math.random() * this.constructor.MaxDelayMS); // Edge fails a lot above 150ms.
    }
    close() {
        if (!this.id) return;
        super.close();
        const dispatchers = this.constructor.peers[this.id];
        dispatchers.splice(dispatchers.indexOf(this), 1);
        if (!dispatchers.length) delete this.constructor.peers[this.id];
        this.id = null;
    }
}
RandomDelayLoopbackDispatch.peers = {}; // Not shared with base class.
RandomDelayLoopbackDispatch.MaxDelayMS = 100; // See DONE_TO_CLOSE_INTERVAL_MS in unit tests.

// Dispatches via a WebSocket connection.
// The expections on the server are:
// - A connection to wss://<domain>/<id> remembers that you are at at id.
// - Any mesage over that resource (by you or others) will be parsed as json, and the string at the property 'to' will be examined.
// - The entire message (i.e., the whole json string, including the 'to') will be delivered only to the socket that connected at
//   the id that matches to.
// - The server cleans up when the client closes the wss connection. No other notification message is necessary.
/* Something like this (or see current server code):
const wss = new require('ws').Server({ server }), wsRegistrants = {};
wss.on('connection', function (ws, req) {
    const id = require('url').parse(req.url).pathname.slice(1);
    wsRegistrants[id] = ws;
    ws.on('message', function (data) {
        const message = JSON.parse(data), destination = wsRegistrants[message.to];
        if (id !== message.from) return ws.terminate(); // Don't allow forging of the from address.
        if (!destination) return ws.terminate(); // Just close the connection, just as if client were directly connected to the destination.
        destination.send(data);
    });
    ws.on('close', function () { delete wsRegistrants[id]; });
});
*/

class WebSocketDispatch extends P2pDispatch {
    constructor(id, receiver, ignoredEvents, waitForOpen = true) {
        super(id, receiver);
        return this.constructor.getConnection(this, waitForOpen).then(connection => {
            this.connection = connection;
            // add/removeEventListener to connection, rather than preventing applications from using connection.onmessage.
            this.onmessage = event => this.p2pReceive(JSON.parse(event.data));
            this.connection.addEventListener('message', this.onmessage);
            return this;
        });
    }
    // Regardless of whethere there is one WebSocket per browser (e.g., regardless of how many ids are presented in that browser),
    // the server dispatches by message.to string (not message.to + message.from), so the server must not be asked for
    // more than one WebSocket connection per message.to id. Therefore, we must multiplex multiple receiver objects on the same
    // id over a single WebSocket. We could do this with a single handler that dispatches to the receiver that matches mssage.from,
    // but currently, we do that by multiple onmessage, 
    static getConnection1(instance, waitForOpen = true) { // create or update connection for new id, returning a promise that resolves when open
        const id = instance.id;
        const dispatchers = WebSocketDispatch.peers[id] = (WebSocketDispatch.peers[id] || []);
        dispatchers.push(instance);
        if (dispatchers.length > 1) return Promise.resolve(dispatchers[0].connection);
        return new Promise(resolve => {
            const connection = new WebSocket(`${WebSocketDispatch.site}/${id}`);
            if (!waitForOpen) return resolve(connection);
            connection.onopen = _ => { connection.onopen = null; resolve(connection); };
        });
    }
    sendObject(messageObject) {
        return this.connection.send(JSON.stringify(messageObject));
    }
    close() {
        if (!this.connection) return;
        super.close();
        this.connection.removeEventListener('message', this.onmessage);

        const dispatchers = this.constructor.peers[this.id];
        dispatchers.splice(dispatchers.indexOf(this.connection), 1);
        if (!dispatchers.length) {
            delete this.constructor.peers[this.id];
            this.connection.close();
        }
        this.connection = null;
    }
}
WebSocketDispatch.site = ((location.protocol === 'https:') ? 'wss:' : 'ws:') + "//" + location.host;
WebSocketDispatch.getConnection = serializePromises(WebSocketDispatch.getConnection1);
WebSocketDispatch.peers = {};

// Dispatches by POSTing to /message, with {from, to, type, data} as the JSON body.
// Receves through an EventSource at /messages/<id>
// The expectation on the server is analogous to that for WebSocketDispatch, above. E.g., a connection to
// /messages/<id> remembers that you are at id, and a /message with body {to: id} will be delivered there.
// One subtle thing is that WebSocket guarantees the order of messages, but (post /message) does not. To make this work,
// we require that the server not respond to /message (e.g., with 200) until it has actually sent the SSE.
class EventSourceDispatch extends P2pDispatch {
    constructor(id, receiver, eventTypes, waitForOpen = true) {
        super(id, receiver);
        this.eventTypes = eventTypes;
        return this.constructor.getConnection(this, waitForOpen).then(connection => {
            this.connection = connection;
            // If we simply called fetch(..a..), fetch(..b..), the receiver might
            // see b before a. By serializing them, we ensure that the server sees AND RESPSONDS to
            // these in order. (The implementation on the server will deliver a SSE before it responds
            // to the post.)
            // Note that a lot of messages (e.g., icecandidate) received just before closing can stack up,
            // and may be delivered after the other end closes, resulting in logspam as described just below here.
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
            // Instead, the current implementation on the server does send the message type as the SSE event,
            // which means we won't get a generic 'message' event on the EventSource,
            // but rather a typed event that needs a handler added by addEventListener, and
            // removed by removeEventListner, below, for each of the expected eventTypes.
            this.onmessage = event => this.p2pReceive(JSON.parse(event.data));
            eventTypes.forEach(type => this.connection.addEventListener(type, this.onmessage));
            return this;
        });
    }
    static getConnection1(instance, waitForOpen = true) {
        const id = instance.id;
        const dispatchers = EventSourceDispatch.peers[id] = (EventSourceDispatch.peers[id] || []);
        dispatchers.push(instance);
        if (dispatchers.length > 1) return Promise.resolve(dispatchers[0].connection);
        return new Promise(resolve => {
            const connection = new EventSource(`/messages/${id}`);
            if (!waitForOpen) return resolve(connection);
            connection.onopen = _ => { connection.onopen = null; resolve(connection); };
        });
    }
    sendObject(messageObject) {
        return this.poster(JSON.stringify(messageObject));
    }
    close() {
        if (!this.connection) return;
        super.close();
        this.eventTypes.forEach(type => this.connection.removeEventListener(type, this.onmessage));

        const dispatchers = this.constructor.peers[this.id];
        dispatchers.splice(dispatchers.indexOf(this.connection), 1);
        if (!dispatchers.length) {
            delete this.constructor.peers[this.id];
            this.connection.close();
        }
        this.connection = null;
    }
}
EventSourceDispatch.getConnection = serializePromises(EventSourceDispatch.getConnection1);
EventSourceDispatch.peers = {};



// SIGNALING PEERS: Represents half a peer pair, maintaing an RTCPeerConnection between them.

// Base class for signaling and resignaling of RTCPeerConnection.
// Subclasses (below) are specialized for different kinds of signaling message carriers.
class RTCSignalingPeer {
    constructor(ourId, peerId, configuration = null) {
        this.id = ourId;
        this.peerId = peerId;
        const peer = this.peer = new RTCPeerConnection(configuration);

        // We use add/removeEventListener so that applications are free to use peer.onMumble.
        this.onnegotiationneeded = _ => this.negotiationneeded();
        // The spec says that a null candidate should not be sent, but that an empty string candidate should.
        // But Safari gets errors either way.
        this.onicecandidate = event => event.candidate && event.candidate.candidate
            && this.p2pSend('icecandidate', event.candidate);
        // Support unknown. Can be overridden, of course.
        this.onicecandidateerror = event => {
            // STUN errors are in the range 300-699. See RFC 5389, section 15.6
            // for a list of codes. TURN adds a few more error codes; see
            // RFC 5766, section 15 for details.
            // Server could not be reached are in the range 700-799.
            console.error('ice code:', event.errorCode, event);
        };
        peer.addEventListener('negotiationneeded', this.onnegotiationneeded);
        peer.addEventListener('icecandidate', this.onicecandidate);
        peer.addEventListener('icecandidateerror', this.onicecandidateerror);
        // These are not widely supported, but might be useful for debugging.
        //peer.onconnectionstatechange = _ => console.log(this.id, 'connection state', peer.connectionState);
        //peer.oniceconnectionstatechange = _ => console.log(this.id, 'ice connection state', peer.iceConnectionState);
        //peer.onicegatheringstatechange = _ => console.log(this.id, 'ice gathering state', peer.iceGatheringState);
        
        this.queue = Promise.resolve(); // See acquireLock

        return new this.constructor.dispatchClass(ourId, this, this.constructor.events).then(dispatch => {
            this.p2pDispatcher = dispatch;
            return this;
        });
    }
    p2pSend(type, message) {
        return this.p2pDispatcher.p2pSend(this.peerId, type, message);
    }
    // Not all RTCPeerConnection implementations fire connectionstatechange or other indication of closure.
    close() { // So applications should explicitly call this to allow cleanup.
        const peer = this.peer;
        fixme('close', this.id);
        peer.removeEventListener('negotiationneeded', this.onnegotiationneeded);
        peer.removeEventListener('icecandidate', this.onicecandidate);
        peer.removeEventListener('icecandidateerror', this.onicecandidateerror);
        peer.close();
        this.p2pDispatcher.close();
    }

    icecandidate(iceCandidate) { // We have been signalled by the other end about a new candidate.
        this.peer.addIceCandidate(iceCandidate).catch(console.error)
    }
    inRace() { // When checked within negotiationneeded or offer handlers, indicates that we are already negotiating.
        // See https://blog.mozilla.org/webrtc/perfect-negotiation-in-webrtc/
        // Using this, I can get Firefox to work ALMOST all the time without using acquireLock.
        // But Chrome and Safari don't work.
        //return this.peer.signalingState !== 'stable';
        return false; // So, let's just rely on acquireLock instead.
    }
    isPolite() { // Exactly one of a peer pair must defer to the other in race conditions.
        // It cannot be by role, because a peer can be master to ther other's slave for, say, data
        // and simultaneously the reverse for another (media, or a different data channel).
        return this.id < this.peerId;
    }

    // When we add a stream or channel, or conditions change, we get this event to (re)start the signaling process.
    negotiationneeded() {
        fixme('negotiationneeded at', this.id,
                    'has pending:', !!this.peerLockPending,
                    'is polite:', !!this.isPolite(),
                    'seeking lock response:', !!this.lockResponse,
                    'has lock:', !!this.acquired
                   );
        if (!this.lockResponse) { // See acquireLock, below.
            return this.acquireLock(_ =>  {
                this.negotiationneeded();
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
    offer(offer) { // Handler for receiving an offer from the other user (who started the signaling process).
        // Note that during signaling, we will receive negotiationneeded/answer, or offer, but not both, depending
        // on whether we were the one that started the signaling process.
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
    answer(answer) { // Handler for finishing the signaling process that we started.
        this.peer.setRemoteDescription(answer);
    }

    // Applications should not create data channel or add tracks directly to this.peer. Use these two instead.
    // They both answer a promise that does not resolve until channel or stream is "ready" for use.

    createDataChannel(label = "data", channelOptions = {}, {waitForOpen = true, timeout, delay = 1000} = {}) { // Promise resolves when the channel is open (implying negotiation has happened).
        // One should not write on an RTCDataChannel until it gets 'open'. So that's when we primarily resolve.
        // However, some browsers have bugs (cough, Edge), in which they sometimes fail to signal 'open', particularly if signaling takes too long.
        // So... acquireLock is watching for peer.signalingState returning to stable anyway (for negotiationneeded and addStream), so if we detect that
        // we will finish up delay (1000 ms) after stable (unless we do get 'open' in the mean time), and hope for the best.
        // (Sometimes even then, Edge fails to mark the channel open and checks for open when you try to send. Sigh.)
        fixme('createDataChannel', this.id);
        return this.acquireLock(resolve => {
            const channel = this.peer.createDataChannel(label, channelOptions);
            if (waitForOpen) {
                channel.onopen = _ => resolve(channel);
            } else{
                resolve(channel);
            }
            return channel;
        }, timeout, delay);
    }
    addStream(stream, {timeout, delay} = {}) { // Promise resolves when the peer has negotiated.
        fixme('addStream', this.id);
        return this.acquireLock(resolve => {
            if (!stream) return resolve(null); // If it went away by the time we got a lock.
            stream.getTracks().forEach(track => this.peer.addTrack(track, stream));
            // There isn't a media equivalent to 'onopen' as there is for dataChannel,
            // so I haven't found a very satisfying way to know whether the media is really
            // established and ready for use. Here we just wait until we move out of stable
            // and back to it, which is the default for acquireLock.
            // (Note that acquireLock makes sure that we were stable when we entered here and added the tracks.)
            // I have also tried listening on the other side for the tracks, and having it send a message back to
            // to us over the signaling connection. But for all it's complexity, that didn't seem to offer any advantage.
            return stream;
        }, timeout, delay);
    }
    // Executes body(resolve, reject) with a mutex between the peers.
    // Requests to acquireLock will be queued up and execute one at a time (on our side of the pair), in serial.
    // When it our turn, we request a lock from our peer and wait for it. This is done as a two phase commit:
    // - If only one side requests, it goes when the other side agrees.
    // - If both sides request before either has obtained the lock, then the one that isPolite() allows the other to go.
    // A promise is returned that is not resolved until body completes, which then also releases the lock, allowing
    // any pending bodies to then start. There are several ways to complete the body:
    // - body is given functions resolve, reject. These can be called from body to complete the work.
    //   The resolved value is used as the value of the promise returned by aquireLock.
    // - Otherwise, we monitor signaling state changes. (It is assumed that body triggers signaling.)
    //   After we return to stable, body is resolved automatically.
    // - Otherwise, a timer is started WHEN WE REQUEST THE LOCK FROM THE PEER (not when we are waiting our turn to run).
    //   When this goes off, the body is rejected.
    // The mutex exists only between the two pairs. It does not effect other RTCSignalingPeers, even in the same browser.
    acquireLock(body, timeoutMs = 5000, stableResolutionDelayMs = 1) {
        var timeout, onStateChange, result, delay;
        fixme('attempting to acquireLock at', this.id);
        return this.queue = this.queue
            .then(_ => new Promise((resolve, reject) => {
                fixme('aquireLock processing at', this.id);
                timeout = setTimeout(_ => {fixme('lock timeout!', this.id); reject()}, timeoutMs);
                onStateChange = _ => {
                    fixme('signaling state', this.peer.signalingState, this.id);
                    if (this.peer.signalingState === 'stable') {
                        delay = setTimeout(_ => resolve(result), stableResolutionDelayMs);
                    }
                };
                this.lockResponse = _ => {
                    fixme('acquire lock at', this.id);
                    this.acquired = true;
                    this.peer.addEventListener('signalingstatechange', onStateChange);
                    result = body(resolve, reject);
                };
                this.p2pSend('lockRequest');
            }))
            .catch(_ => null)
            .then(result => {
                clearTimeout(timeout);
                clearTimeout(delay);
                this.peer.removeEventListener('signalingstatechange', onStateChange);
                const hasPending = this.peerLockPending;
                fixme('completed locked work at', this.id, 'hasPending:', !!hasPending);
                this.lockResponse = this.peerLockPending = this.acquired = null;
                if (hasPending) {fixme('sending lockResponse', this.id); this.p2pSend('lockResponse');}
                return result;
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
}
RTCSignalingPeer.events = ['icecandidate', 'offer', 'answer', 'lockRequest', 'lockResponse', 'gotTrack'];

// As an example of use, here's a subclass where both peers have to be in the same browser, and 
// p2pSend just passes the data directly to the other peer. Real-world subclasses are below.
class LoopbackRTC extends RTCSignalingPeer { }
LoopbackRTC.dispatchClass = LoopbackDispatch;

// Same, but with a srandom signaling delay.
class RandomDelayLoopbackRTC extends LoopbackRTC { }
RandomDelayLoopbackRTC.dispatchClass = RandomDelayLoopbackDispatch;


/*
Signaling over WebSockets:

WebSocket makes logical sense for signaling, but the word on the Web seems to be that it does not scale well.
1. Client is limited to about 200 WebSockets per server/page (browser-specific). This implementation works around
   that by multiplexing communications for all RTCSignalingPeer instances over a single WebSocket per page,
   rather than having the page open a socket for each RTCSignllingPeer that it will interact with.
2. Server is limited to about 1000 WebSockets. Since either client of a pair might need to resignal, both ends
   have to keep their WebSockets open the whole time that they use the RTCPeerConnection, even if there is no
   traffic. So, we would need concurrency/1000 servers, and a message buss between servers (to route messages
   from a client on one server to the correct server for the other client.
3. Front end / load balancers / reverse proxies (such as NGINX) typically work at the HTTP level, not the
   TCP level that WebSockets operate at, so it may be difficult or impossible for such to provide their
   benefits with WebSockets. My guess is that this may be true of client-side forward proxies as well, which may
   matter for mobile.
4. HTTP/2 has significant scaling advantages, but isn't compatible with WebSockets.
5. Mobile devices and carriers don't like to leave sockets open indefinitely. (SSE, below, behaves similarly to
   the various proprietary mechanism to push an event to a mobile device, and so is more likely to be adaptable.)
Thus WebSockets may ultimately be a dead end in industry. Nonetheless, they're familiar, so the following provides a sample
client use. 
*/
class WebSocketRTC extends RTCSignalingPeer { }
WebSocketRTC.dispatchClass = WebSocketDispatch;

// Signaling with ordinary GET to send messages, and Server-Side Events to receive them.
class EventSourceRTC extends RTCSignalingPeer {
    //fixme
    signalingError(type, from, to, response) { // Can be overriden.
        // Handle an asynchronous communication error during signaling (e.g., from p2pSend)
        // Note that Chrome will report 404 from fetch in the console as if by console.error, without
        // actually signaling an error. (The spec says no error is signalled, but it doesn't prevent
        // Chrome from being annoying noisy about it. See
        // https://stackoverflow.com/questions/4500741/suppress-chrome-failed-to-load-resource-messages-in-console/30847631#30847631
        console.error(type, from, to, response.status, response.url, response.statusText);
        return response;
    }
}
EventSourceRTC.dispatchClass = EventSourceDispatch;
