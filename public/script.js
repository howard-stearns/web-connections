'use strict';

// References basic-report.js, but in a separate file so that obsolete browsers may still run that part
// despite syntax errors here.

// Communications:

function initWebSocket() {
    webSocket = new WebSocket(`${wsSite}/${guid}`);
}

function sendSelfMessage(data, type) { // Returns a promise
    const message = {to: guid, from: guid};
    if (data !== undefined) message.data = data;
    if (type !== undefined) message.type = type;
    return fetch('/message', {
        method: 'post',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(message)
    });
}

function sendWebsocketMessage(data) { // Returns a promise
    return Promise.resolve(webSocket.send(JSON.stringify({to: guid, from: guid, data: data})));
}

var ourCurrentVersion;
function initEventSource() {
    if (eventSource) return sendSelfMessage(undefined, 'listing');

    eventSource = new EventSource(`/messages/${guid}`);

    // We will immediately be given a listing of currently connected peers. Save it for later
    function listingHandler(messageEvent) {
        const message = JSON.parse(messageEvent.data);
        console.log('listingHandler', messageEvent.data);
        if (ourCurrentVersion && (ourCurrentVersion !== message.version)) {
            console.log('NEW VERSION', message.version);
            location.reload();
        }
        ourCurrentVersion = message.version;
        // Hitting refresh can sometimes allow our guid to still be registered.
        // We need two different EventSource to test loopback, but then we'd be registered twice and things would get weird.
        existingPeers = message.peers.filter(p => p !== guid);
        browserData.concurrency = existingPeers.length;
        browserData.ip = message.ip;
        updateTestingMessage();
    }
    eventSource.addEventListener('listing', listingHandler);

    // We will now be reported to others, so respond if they start to connect to us.
    function peerEventHandler(messageEvent) {
        const message = JSON.parse(messageEvent.data);
        // This could be a renegotiation of something that already has it's own connection.
        if (respondingConnections[message.from]) return;
        // Create a responder and let it act on the offer.
        respondingConnections[message.from] = new RespondingConnection(message);
    }
    eventSource.addEventListener('offer', peerEventHandler);

    // Server will timeout the connection, but a reload produce confusing results unless we play nice.
    window.addEventListener('beforeunload', event => {
        eventSource.removeEventListener('listing', listingHandler);
        eventSource.removeEventListener('offer', peerEventHandler);
        eventSource.close()
    });
}


// Testing:

var block = '', blockSize = 1<<15; // 32k 1-byte chracters (UTF-8)
for (var i = 0; i < blockSize; i++) { block += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i % 26]; }
const protocol = (location.protocol === 'http:') ? 'ws:' : 'wss:';
const wsSite = protocol + "//" + location.host;
var eventSource, existingPeers = [], stream, webSocket;
const testConnections = {};
const respondingConnections = {};
const RTC_CONFIGURATION = {
    iceServers: [
        {urls: [
            "stun:stun.l.google.com:19302",
            //"stun:stun.voiparound.com",
            //"stun:stun.voipbuster.com",
            //"stun:stun.ideasip.com",
            //"stun:stun.ekiga.net",
            //"stun:stun.xten.com"
            //"stun:ice.highfidelity.com"
        ]},
        {urls: 'turn:numb.viagenie.ca',
         credential: 'muazkh',
         username: 'webrtc@live.com'}
    ]
};

function updateTestingMessage() {
    var message = "Thank you for sharing your computer" + (stream ? " and webcam.": ".") + " Testing ";
    if (browserData.concurrency) {
        const peers = browserData.concurrency === 1 ? "1 peer" : "" + browserData.concurrency + " peers";
        message += "among " + peers + "... It will be at least "
            + MEDIA_RUNTIME_SECONDS + " seconds before results start showing above.";
    } else {
        message += "...";
    }
    userMessages.innerHTML = message;
}

// Answer Date.now(), but also start a timer that will reject the test if
// the specified collector[key] has not been set before the timer goes off.
function startSubtest(milliseconds, collector, key, reject, channel = {}) {
    setTimeout(_ => {
        if (collector[key] === undefined) {
            const failReason = channel.failReason || FAIL_VALUE;
            var label = channel.failReason || "timeout";
            if (channel && (channel.readyState !== undefined)) {
                label += ' ' + channel.readyState;
            }
            reject(label);
        }
    }, milliseconds);
    return Date.now();
}

// Returns a function suitable for .catch(notarizeFailure(...)).
function notarizeFailure(collector, key) {
    return error => {
        console.error(key, error);
        collector[key] = error.message || error;
    };
}

// Returns a promise resolving to collector with results of setup, ping and bandwidth noted.
// We're relying on each "channel" having and onopen and onmessage.
function testSetupPingBandwidth(label, channel, send, collector, skipSetup = false) {
    const setupKey = label + 'Setup';
    const pingKey = label + 'Ping';
    const bandwidthKey = label + 'Kbs';
    return new Promise((resolve, reject) => {
        channel.onopen = _ => {
            // We're now setup.
            collector[setupKey] = skipSetup ? -1 : (Date.now() - start);
            console.log(setupKey, collector[setupKey]);
            channel.onmessage = event => {
                // We got the ping.
                collector[pingKey] = Date.now() - start;
                console.log(pingKey, collector[pingKey]);
                if (label === 'data') { // hack special case
                    collector.peerIp = event.data;
                }
                channel.onmessage = messageEvent => {
                    // We got the data block.
                    const elapsed = Date.now() - start;
                    const envelope = messageEvent.data;
                    collector[bandwidthKey] = envelope.length * 8 / elapsed;
                    console.log(bandwidthKey, collector[bandwidthKey]);

                    // Cleanup
                    channel.onopen = channel.onmessage = null;
                    // On to the next...
                    resolve(collector);
                };
                // Send a data block and expect a message back.
                start = startSubtest(5000, collector, bandwidthKey, reject, channel);
                send('data' + block);
            };
            // Send ping and expect a message back.
            start = startSubtest(5000, collector, pingKey, reject, channel);
            send('ping');
        }
        var start = startSubtest(5000, collector, setupKey, reject, channel);
        if (skipSetup) channel.onopen();
    }).catch(notarizeFailure(collector, setupKey));
}

// Returns a promise resolving to a media stream.
function obtainMediaStream(browserHasMedia, collector, key) {
    var webcamTimer;
    return new Promise((resolve, reject) => {

        if (!browserHasMedia) return reject('SKIPPED');

        userMessages.innerHTML = "Allowing webcam and microphone helps us to gauge media transfer. "
            + "It will not be displayed or recorded anywhere, and will be turned off at the conclusion of testing."

        webcamTimer = setTimeout(_ => reject('IGNORED'), 10 * 1000);

        navigator.mediaDevices.getUserMedia({video: true, audio: true}).then(resolve, reject)
    })
        .catch(notarizeFailure(collector, key))
        .then(mediaStream => {
            clearTimeout(webcamTimer);
            return mediaStream;
        });
}

var contributionCount = 0;
class CommonConnection extends EventSourceRTC { // Connection to whatever we are testing with. Two subclasses, below.
    constructor(peerId) {
        super(eventSource, guid, peerId, RTC_CONFIGURATION);
        this.closeMessageHandler =  messageEvent => {
            // Either end can close, by sending a message. We use the signalling channel because
            // there no completely supported way to tell if an RTCPeerConnection or RTCDataChannel
            // has been closed.
            this.close();
        };
        eventSource.addEventListener('close', this.closeMessageHandler);
    }
    initDataChannel(channel) {
        this.channel = channel;
        channel.onerror = e => console.error(e); // Alas, not widely supported.
    }
    close() {
        const kill1 = (dictionary, label) => {
            const peerId = this.peerId;
            const connection = dictionary[peerId];
            if (connection) {
                delete dictionary[peerId];
                console.info('Finished', label, peerId);
                return true;
            }
        }
        super.close();
        eventSource.removeEventListener('close', this.closeMessageHandler);
        if (kill1(testConnections, 'testing')) {
            report(this.results);
        } else { // We currently do not report our end of test.
            served.innerHTML = ++contributionCount;
            kill1(respondingConnections, 'responding to');
        }
    }
}
class RespondingConnection extends CommonConnection { // If someone is starting a test with us, this is how we respond.
    // Our event source received an unhandled message from someone who has started signalling with us.
    constructor(message) {
        super(message.from);
        console.info('Starting response to', this.peerId);
        this.trackHandler = event => this.channel && this.channel.send(event.track.kind);
        this.peer.addEventListener('track', this.trackHandler);
        this.peer.ondatachannel = event => {
            console.log('Got data channel for', this.peerId);
            const channel = event.channel;
            this.initDataChannel(channel);
            channel.onmessage = event => {
                const message = event.data,
                      key = message.slice(0, 4);
                console.log('Got', key, 'from', this.peerId);
                switch (key) {
                case 'ping':
                    // Server should not send other people's data, but the peer can.
                    channel.send(browserData.ip);
                    break;
                case 'data':
                    channel.send(message);
                    break;
                default:
                    console.error('Unrecognized data', message, 'from', this.peerId);
                }
            };
        };
        this[message.type](message.data); // And now act on whatever triggered our creation (e.g., offer).
    }
    close() {
        super.close();
        this.peer && this.peer.removeEventListener('track', this.trackHandler);
        this.peer && (this.peer.ondatachannel = null);
        this.channel && (this.channel.onmessage = null);
    }
}

class TestingConnection extends CommonConnection {
    static run(peerId) {
        const connection = testConnections[peerId] = new TestingConnection(peerId);
        var mediaStartTime;
        connection.results = Object.assign({peer: peerId}, browserData);
        return testSetupPingBandwidth('data', connection.channel,
                                      data => connection.channel.send(data),
                                      connection.results)
            .then(_ => connection.testMedia())
            .then(_ => connection.peer.getStats())
            .then(stats => connection.reportMedia(stats))
            .then(_ => connection.channel.onmessage = null)
            .catch(e => console.log('caught', e))
            .then(_ => connection.p2pSend('close', null))
            .then(_ => connection.close());
    }
    constructor(peerId) {
        super(peerId);
        this.initDataChannel(this.peer.createDataChannel(`${this.id} => ${this.peerId}`));
    }
    signallingError(type, from, to, response) { // Can be overriden.
        console.error(type, from, to, response.status, response.url, response.statusText);
        this.channel.failReason = (response.status == 404) ? "peer offline" : response.statusText;
        return response;
    }
    testMedia() {
        const nTracksKey = 'nTracks';
        const setupKey = 'mediaSetup';
        const collector = this.results;
        var mediaStartTime
        collector[nTracksKey] = 0;
        return new Promise((resolve, reject) => {
            var tracksReceived = 0;
            if (!stream) return resolve(); // obtainMediaStream already recorded whatever needs recording
            this.channel.onmessage = event => {
                if (!['audio', 'video'].includes(event.data)) {
                    return console.error("Unexpected video message %s from %s", event.data, this.peerId);
                }
                if (++tracksReceived < collector[nTracksKey]) return;
                collector[setupKey] = Date.now() - start;
                console.log(setupKey, collector[setupKey], 'track', tracksReceived, '/', collector[nTracksKey]);
                mediaStartTime = Date.now();
                setTimeout(_ => resolve(collector), MEDIA_RUNTIME_SECONDS * 1000); // Get 10 seconds of audio to collect stats on
            };
            // Now start the video
            var start = startSubtest(5000, collector, setupKey, reject);
            stream.getTracks().forEach(track => {
                this.peer.addTrack(track, stream);
                collector[nTracksKey]++;
            });
        })
            .then(_ => stream && (collector.mediaRuntime = Date.now() - mediaStartTime))
            .catch(notarizeFailure(collector, setupKey));
    }
    reportMedia(stats) {
        var selected;
        stats.forEach(report => {
            if ((report.type === 'candidate-pair') && // find the selected report
                (report.selected || (report.nominated && (report.state === 'succeeded')))) {
                selected = report;
                return;
            }
            const kinds = mediaReportMap[report.type]; // Is this a report for which we want media stats?
            if (!kinds) { return; }
            kinds[report.kind || report.mediaType].forEach(key => {
                const value = report[key];
                if (value !== undefined) {
                    this.results[[report.type, (report.kind || report.mediaType), key].join('-')] = value;
                }
            });
        });
        if (!selected) { // If this happens, let's try to see why.
            console.error('No selected candidate-pair report',
                          stats.filter(r => (r.type === 'candidate-pair') && r.nominated));
            return;
        }
        stats.forEach(report => { // Find local and remote ICE candidate referenced by the selected report.
            if (((report.type === 'local-candidate') && (report.id === selected.localCandidateId))
                || ((report.type === 'remote-candidate') && (report.id === selected.remoteCandidateId))) {
                const prefix = report.type.split('-')[0] + '-';
                ['protocol', 'candidateType', 'address'].forEach(key => {
                    const altKey = {address: 'ip'}[key];
                    this.results[prefix + key] = (report[key] || report[altKey]);
                });
            }
        });
    }
}

function doAllTests() {
    retest.disabled = true;
    if (FAILED) return console.error("Missing required functionality.");
    obtainMediaStream(browserData.av, browserData, 'mediaSetup') // Just once...
        .then(media => stream = media) // ... and shared among each RTCPeerConnection
        .then(updateTestingMessage)
        .then(initWebSocket)
        .then(_ => testSetupPingBandwidth('ws', webSocket, sendWebsocketMessage, browserData))
        .then(_ => webSocket.close())
        .then(initEventSource)
        .then(reinited => testSetupPingBandwidth('sse', eventSource, sendSelfMessage, browserData, !!reinited))
        .then(_ => Promise.all(existingPeers.map(TestingConnection.run)))
        .then(results => {
            stream && stream.getTracks().forEach(track => track.stop());
            console.info(`Completed ${results.length} peer tests.`);
            if (!results.length) report(browserData);
            userMessages.innerHTML = "Testing is complete. If you can,"
                + " <b>please leave this page up</b> so that other people can test with you at higher concurrency."
                + " (No futher webcam or audio data will be used, however.)";
            retest.disabled = false;
        })
}
window.onload = doAllTests;

