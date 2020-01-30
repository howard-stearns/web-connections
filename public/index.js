'use strict';

function uuidv4() { // Not crypto strong, but good enough for prototype.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

const ICE_SERVERS = null;

// Whenever this browser on this machine tests again, we want the same id.
// localStorage is NOT shared between different browsers on the same machine,
// but it is shared between tabs of the same browser.
const ID_KEY = 'guid';
const guid = localStorage.getItem(ID_KEY)
      || (localStorage.setItem(ID_KEY, uuidv4()), localStorage.getItem(ID_KEY));


// Acts like the other peer is a local object to send and receive events directly, by various subclass means.
class P2PChannel extends EventTarget {
    constructor(ourId, theirId) {
        this.id = ourId;
        this.peerId = theirId;
    }
}

class WebSocketP2PChannel extends P2PChannel {
    constructor(targetId) {
        const protocol = (location.protocol === 'http:') ? 'ws:' : 'wss:';
        const wsSite = protocol + "//" + location.host;
        const webSocket = new WebSocket([wsSite, guid, targetId].join('/'));
        super(guid, targetId);
        this.webSocket = webSocket;
        webSocket.onmessage = event => {
            const [type, message] = JSON.parse(event.data);
            this.dispatchEvent(new MessageEvent(type, {data: message}));
        };
    }
    send(type, message) {
        this.webSocket.send(JSON.stringify([type, message]));
    }
}

const eventSource = new EventSource('/eventSource');
class EventStreamP2PChannel extends P2PChannel {
    constructor(targetId) {
        eventSource.onmessage = event => {
            const {from, message} = JSON.parse(event.data);
            if (from !== targetId) return;
            event.data = message;
            this.dispatchEvent(event);
        };
    }
    send(type, message) {
        fetch(this.messageUrl, {
            method: 'post',
            body: JSON.stringify({
                to: this.peerId,
                from: this.id,
                type: type,
                message: message
            })
        });
    }
}
        

// Has one property, peer (an RTCPeerConnection), to which media tracks and data channels can be attached.
// This class takes care of any signalling needed, which may occur when adding or during operations,
// e.g., if the network changes behavior.
class SignallingPeer {
    constructor(peerId) {
        this.peerId = peerId;
        var peer = this.peer = new RTCPeerConnection(ICE_SERVERS);
        peer.addEventListener('negotiationneeded', event => this.negotiationneeded());
        peer.addEventListener('icecandidate', event => this.p2pSend('icecandidate', event.candidate));
    }
    p2pSend(operation, data) {
        // FIXME
    }
    icecandidate(iceCandidate) { // We have been signalled by the other end about a new candidate.
        this.peer.addIceCandidate(iceCandidate).catch(e => console.error('CONNECTION ADD ICE FAILED', e.name, e.message));
    }
    negotiationneeded() { // When we add a stream, we get this event to start the signalling process.
        console.log('negotiationneeded', this.peerId);
        const peer = this.peer;
        var offer;
        peer.createOffer({})
            .then(result => offer = result)
            .then(() => peer.setLocalDescription(offer)) // promise does not resolve to offer
            .then(() => this.p2pSend('offer', offer));
    }
    offer(offer) { // Handler for receiving an offer from the other user (who started the signalling process).
        // Note that during signalling, we will receive negotiationneeded/answer, or offer, but not both, depending
        // on whether we were the one that started the signalling process.
        const peer = this.peer;
        var answer;
        peer.setRemoteDescription(offer)
            .then(() => this.connectStream('webcam'))
            .then(() => peer.createAnswer())
            .then(result => answer = result)
            .then(() => peer.setLocalDescription(answer)) // promise does not resolve to answer
            .then(() => this.p2pSend('answer', answer));
    }
    answer(answer) { // Handler for finishing the signalling process that we started.
        this.peer.setRemoteDescription(answer);
    }
}

class TestClient {
    constructor(p2pChannel) {
        this.connection = new SignallingPeer(p2pChannel);
        this.connection.peer.ondatachannel = event => {
            this.realtimeChannel = event.channel;
            this.realtimeChannel.onmessage = event => {
                if (event.data === 'ping') this.realtimeChannel.send('pong');
            };
        };
    }
}

class TestPeer {
    constructor(peerId) {
        ;
        this.connection = new SignallingPeer();
        this.realtimeChannel = this.connection.peer.createDataChannel(peerId, {}); // Should immediately start signalling
        // FIXME: handle 'error' and 'close' by aborting the test
    }
    time(thunk) {
        const start = Date.now();
        thunk();
        return Date.now() - start;
    }
    test() {
        const results = {};
        const pongPromise = new Promise((resolve, reject) => {
            this.realtimeChannel.addEventListener('data', event => {
                if (event.data === 'pong') resolve(event.data);
            });
        });
        results.ping = this.time(async _ => {
            this.realtimeChannel.send('ping');
            await pongPromise;
        });
        // measure round trip ping
        // measure time to send a lot of data (more than one chunk)
        // measure time to receive the data back
        return results;
    }
    static runTestAndReport(peerId) {
        return  new TestPeer(peerId);
            .test()
            .then(result => this.report(result));
    }
    static report(result) {
        return fetch('/report.json', {
            method: 'post',
            body: JSON.stringify({id: guid, result})
        });
    }
}

fetch('/register.json?id=' + guid)
    .then(response => response.json())
    .then(peers => Promise.all(peers.map(TestPeer.runTestAndReport))) // complete all tests before reporting
    .then(reports => {
        if (reports) console.log('Reported', reports.length, 'results');
        console.log('Awaiting other testers.');
    });
              
