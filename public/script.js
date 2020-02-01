'use strict';

// Basic info for reporting:
var FAILED = false;
var dummy = window.RTCPeerConnection && new window.RTCPeerConnection();
var browserData = {
    promises: !!window.Promise,
    storage: !!window.localStorage,
    ws: !!window.WebSocket,
    sse: !!window.EventSource,
    rtc: !!window.RTCPeerConnection,
    data: dummy && !!dummy.createDataChannel,
    av: navigator.mediaDevices && !!navigator.mediaDevices.getUserMedia
}
dummy = null;

function uuidv4(label = '') { // Not crypto strong, but good enough for prototype.
    return label + 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Whenever this browser on this machine tests again, we want the same id.
// localStorage is NOT shared between different browsers on the same machine,
// but it is shared between tabs of the same browser.
var ID_KEY = 'guid';
var guid = (window.localStorage && localStorage.getItem(ID_KEY)) || uuidv4();

// Reporting:
const FAIL_VALUE = 'FAIL';
const MEDIA_RUNTIME_SECONDS = 10;
const mediaReportMap = {
    'outbound-rtp': {
        audio: ['bytesSent', 'nackCount', 'packetsSent'],
        video: ['bitrateMean', 'bitrateStdDev', 'bytesSent', 'droppedFrames', 'framerateMean', 'framerateStdDev',
                'framesEncoded', 'nackCount', 'packetsSent']
    },
    'remote-inbound-rtp': {
        audio: ['bytesReceived', 'jitter', 'packetsLost', 'packetsReceived', 'roundTripTime'],
        video: ['bytesReceived', 'jitter', 'packetsLost', 'packetsReceived', 'roundTripTime']
    }
};
function report(data) {
    console.info("Test " + guid + (FAILED ? " failed: " : " passed:\n"), data);
    window.result = data;
    const keys = [
        "date","tzOffset", "ip", "peerIp", "peer", "concurrency",
        "wsSetup","wsPing","wsKbs",
        "sseSetup","ssePing","sseKbs",
        "dataSetup","dataPing","dataKbs",
        "nTracks", "mediaSetup", "mediaRuntime",
        "outbound-rtp-audio-bytesSent","outbound-rtp-audio-nackCount","outbound-rtp-audio-packetsSent",
        "outbound-rtp-video-bitrateMean","outbound-rtp-video-bitrateStdDev","outbound-rtp-video-bytesSent","outbound-rtp-video-droppedFrames","outbound-rtp-video-framerateMean","outbound-rtp-video-framerateStdDev","outbound-rtp-video-framesEncoded","outbound-rtp-video-nackCount","outbound-rtp-video-packetsSent",
        "remote-inbound-rtp-audio-bytesReceived","remote-inbound-rtp-audio-jitter","remote-inbound-rtp-audio-packetsLost","remote-inbound-rtp-audio-packetsReceived","remote-inbound-rtp-audio-roundTripTime",
        "remote-inbound-rtp-video-bytesReceived","remote-inbound-rtp-video-jitter","remote-inbound-rtp-video-packetsLost","remote-inbound-rtp-video-packetsReceived","remote-inbound-rtp-video-roundTripTime"];
    const row = document.createElement('tr');
    keys.forEach(key => {
        const item = document.createElement('td');
        var value = data[key];
        if (value === undefined) {
            value = '    ';
        } else if (value === FAIL_VALUE) {
            value = '<b>FAIL</b>';
        } else if (typeof value === 'number') {
            if (value >= 1) {
                value = Math.round(value);
            } else if (value > 0) {
                value = value.toFixed(3);
            }
        }
        item.innerHTML = value;
        row.appendChild(item);
    });
    table.appendChild(row);
    fetch("https://hifi-telemetric.herokuapp.com/gimmedata", {
        method: 'post',
        mode: 'no-cors',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(data)
    }).catch(error => console.error('post', error));
}

Object.keys(browserData).forEach(function (key) {
    document.getElementById(key).checked = browserData[key];
    if (!browserData[key] && (key != 'av')) {
        FAILED = true;
        browserData.concurrency = browserData.concurrency || 'missing:';
        browserData.concurrency += ' ' + key;
    }
});
ourId.innerHTML = browserData.id = guid; 
agent.innerHTML = browserData.agent = navigator.userAgent;

const now = new Date();
browserData.date = now.toISOString();
browserData.tzOffset = now.getTimezoneOffset();
if (FAILED) report(browserData);
localStorage.setItem(ID_KEY, guid);

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

function initEventSource() {
    if (eventSource) return sendSelfMessage(undefined, 'listing');

    eventSource = new EventSource(`/messages/${guid}`);

    // We will immediately be given a listing of currently connected peers. Save it for later
    function listingHandler(messageEvent) {
        const message = JSON.parse(messageEvent.data);
        console.log('listingHandler', message);
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
        {urls: 'stun:ice.highfidelity.com'},
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
function startSubtest(milliseconds, collector, key, reject) {
    setTimeout(_ => {
        if (collector[key] === undefined) {
            console.error("%s did not complete in %s ms.", key, milliseconds);
            collector[key] = FAIL_VALUE;
            reject(key + " timeout");
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
                    collector[bandwidthKey] = messageEvent.data.length * 8 / elapsed;
                    console.log(bandwidthKey, collector[bandwidthKey]);

                    // Cleanup
                    channel.onopen = channel.onmessage = null;
                    // On to the next...
                    resolve(collector);
                };
                // Send a data block and expect a message back.
                start = startSubtest(5000, collector, bandwidthKey, reject);
                send('data' + block);
            };
            // Send ping and expect a message back.
            start = startSubtest(5000, collector, pingKey, reject);
            send('ping');
        }
        var start = startSubtest(5000, collector, setupKey, reject);
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
                console.info('Finished %s %s.', label, peerId);
                return true;
            }
        }
        super.close();
        eventSource.removeEventListener('close', this.closeMessageHandler);
        if (kill1(testConnections, 'testing')) {
            report(this.results);
        } else { // We currently do not report our end of test.
            contribution.innerHTML = ` You have contributed to ${++contributionCount} other test${contributionCount === 1 ? '' : 's'} this session! Thank you!`;
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
                console.log('Got', event.data, 'from', this.peerId);
                switch (event.data.slice(0, 4)) {
                case 'ping':
                    // Server should not send other people's data, but the peer can.
                    channel.send(browserData.ip);
                    break;
                case 'data':
                    channel.send(data);
                    break;
                default:
                    console.error('Unrecognized data', event.data, 'from', this.peerId);
                }
            };
        };
        this[message.type](message.data); // And now act on whatever triggered our creation (e.g., offer).
    }
    close() {
        super.close();
        this.peer.removeEventListener('track', this.trackHandler);
        this.peer.ondatachannel = this.channel.onmessage = null;
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
            .then(stats => {
                stats.forEach(report => {
                    const kinds = mediaReportMap[report.type];
                    if (!kinds) return;
                    kinds[report.kind].forEach(key => connection.results[[report.type, report.kind, key].join('-')] = report[key]);
                });
                connection.channel.onmessage = null;
            })
            .catch(e => console.log('caught', e))
            .then(_ => connection.p2pSend('close', null))
            .then(_ => connection.close());
    }
    constructor(peerId) {
        super(peerId);
        this.initDataChannel(this.peer.createDataChannel(`${this.id} => ${this.peerId}`));
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
            console.info('Completed %s peer tests.', results.length);
            if (!results.length) report(browserData);
            userMessages.innerHTML = "Testing is complete. If you can,"
                + " <b>please leave this page up</b> so that other people can test with you at higher concurrency."
                + " (No futher webcam or audio data will be used, however.)";
            retest.disabled = false;
        })
}
doAllTests();

