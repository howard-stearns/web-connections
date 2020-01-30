'use strict';

// Basic info for reporting:
var FAILED = false;
var browserData = {
    promises: !!window.Promise,
    storage: !!window.localStorage,
    ws: !!window.WebSocket,
    sse: !!window.EventSource,
    rtc: !!window.RTCPeerConnection,
    data: window.RTCPeerConnection && !!new window.RTCPeerConnection().createDataChannel,
    av: navigator.mediaDevices && !!navigator.mediaDevices.getUserMedia
}

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
function report(data) {
    console.log("Test " + guid + (FAILED ? " failed: " : " passed:\n"), data);
    window.result = data;
    const keys = [
        "date","tzOffset", "concurrency", "peer",
        "wsSetup","wsPing","wsKbs",
        "sseSetup","ssePing","sseKbs",
        "dataSetup","dataPing","dataKbs",
        "mediaSeconds","mediaSetup",
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
}
Object.keys(browserData).forEach(function (key) {
    document.getElementById(key).checked = browserData[key];
    if (!browserData[key]) FAILED = true;
});
ourId.innerHTML = browserData.id = guid; 
agent.innerHTML = browserData.agent = navigator.userAgent;

const now = new Date();
browserData.date = now.toISOString();
browserData.tzOffset = now.getTimezoneOffset();
if (FAILED) report();
localStorage.setItem(ID_KEY, guid);

// Testing:

var block = '', blockSize = 1<<15; // 32k 1-byte chracters (UTF-8)
for (var i = 0; i < blockSize; i++) { block += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i % 26]; }
const protocol = (location.protocol === 'http:') ? 'ws:' : 'wss:';
const wsSite = protocol + "//" + location.host;
var eventSource;
const testConnections = {};
const respondingConnections = {};

class CommonConnection extends EventSourceRTC { // Connection to whatever we are testing with. Two subclasses, below.
    constructor(peerId) {
        super(eventSource, guid, peerId);
        eventSource.addEventListener('close', messageEvent => {
            // Either end can close, by sending a message. We use the signalling channel because
            // there no completely supported way to tell if an RTCPeerConnection or RTCDataChannel
            // has been closed.
            this.cleanup();
        });
    }
    initDataChannel(channel) {
        this.channel = channel;
        channel.onerror = e => console.error(e); // Alas, not widely supported.
    }
    cleanup() {
        const kill1 = (dictionary, label) => {
            const peerId = this.peerId;
            const connection = dictionary[peerId];
            if (connection) {
                delete dictionary[peerId];
                console.info('Finished %s %s.', label, peerId);
                return true;
            }
        }
        if (kill1(testConnections, 'testing')) {
            report(this.results);
        } else { // We currently do not report our end of test.
            kill1(respondingConnections, 'responding to');
        }
    }
}
class RespondingConnection extends CommonConnection { // If someone is starting a test with us, this is how we respond.
    // Our event source received an unhandled message from someone who has started signalling with us.
    constructor(message) {
        super(message.from);
        console.info('Starting response to', this.peerId);
        this.peer.addEventListener('track', event => this.channel.send(event.track.kind));
        this.peer.ondatachannel = event => {
            console.log('Got data channel for', this.peerId);
            const channel = event.channel;
            this.initDataChannel(channel);
            channel.onmessage = event => {
                console.log('Got', event.data, 'from', this.peerId);
                switch (event.data.slice(0, 4)) {
                case 'ping':
                    channel.send('pong');
                    break;
                case 'data':
                    channel.send(data);
                    break;
                default:
                    console.error('Unrecognized data', event.data, 'from', this.peerId);
                }
            };
        };
        this[message.type](message.data);
    }
}
class TestingConnection extends CommonConnection {
    static run(peerId) {
        const connection = testConnections[peerId] = new TestingConnection(peerId);
        const seconds = 10;
        return test('data', connection.channel,
                    data => connection.channel.send(data),
                    Object.assign({peer: peerId}, browserData))
            .then(collector => { // Now check video
                connection.results = collector;
                var start = Date.now();
                return new Promise(resolve => {
                    if (!stream) return resolve();
                    const key = 'mediaSetup';
                    collector.mediaSeconds = seconds;
                    connection.channel.onmessage = message => {
                        collector[key] = Date.now() - start;
                        console.log(key, collector[key]);
                        setTimeout(_ => resolve(), seconds * 1000); // Get 10 seconds of audio to collect stats on
                    };
                    // Now start the video
                    stream.getTracks().forEach(track => connection.peer.addTrack(track, stream));
                });
            })
            .then(_ => connection.peer.getStats())
            .then(stats => {
                stats.forEach(report => {
                    console.log(report);
                    const map = {
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
                    const kinds = map[report.type];
                    if (!kinds) return;
                    kinds[report.kind].forEach(key => connection.results[[report.type, report.kind, key].join('-')] = report[key]);
                });
                return connection.p2pSend('close', null);
            })
            .then(_ => connection.cleanup());
    }
    constructor(peerId) {
        super(peerId);
        this.initDataChannel(this.peer.createDataChannel(`${this.id} => ${this.peerId}`));
    }
}

// Returns a promise resolving to collector with results of setup, ping and bandwidth noted.
// We're relying on each "channel" having and onopen and onmessage.
function test(label, channel, send, collector) {
    const setupKey = label + 'Setup';
    const pingKey = label + 'Ping';
    const bandwidthKey = label + 'Kbs';
    var start = Date.now();
    return new Promise(resolve => {
        channel.onopen = _ => {
            // We're now setup.
            collector[setupKey] = Date.now() - start;
            console.log(setupKey, collector[setupKey]);
            channel.onmessage = _ => {
                // We got the ping.
                collector[pingKey] = Date.now() - start;
                console.log(pingKey, collector[pingKey]);
                channel.onmessage = messageEvent => {
                    // We got the data block.
                    const elapsed = Date.now() - start;
                    collector[bandwidthKey] = messageEvent.data.length * 8 / elapsed;
                    console.log(bandwidthKey, collector[bandwidthKey]);
                    // On to the next...
                    resolve(collector);
                };
                // Send a data block and expect a message back.
                start = Date.now();
                send('data' + block);
            };
            // Send ping and expect a message back.
            start = Date.now();
            send('ping');
        }
    });
}

var existingPeers, stream, webSocket;
new Promise(resolve => { // Ask for webcam
    if (!browserData.av) return resolve(false);
    userMessages.innerHTML = "Allowing webcam and microphone helps us to gauge media transfer. It will not be displayed or recorded anywhere, and will be turned off at the conclusion of testing."
    setTimeout(_ => {
        console.log('webcam timer went off');
        browserData.unresponsiveToMedia = true;
        resolve(false);
    }, 10 * 1000);
    navigator.mediaDevices.getUserMedia({video: true, audio: true}).then(resolve);
})
    .then(media => stream = media,
          error => console.error(error))
    .then(_ => {
        userMessages.innerHTML = "Thank you for sharing your computer" + (stream ? " and webcam.": ".") + " Testing...";
        webSocket = new WebSocket(`${wsSite}/${guid}`);
        return test('ws',
                    webSocket,
                    data => Promise.resolve(webSocket.send(JSON.stringify({to: guid, from: guid, data: data}))),
                    browserData);
    })
    .then(result => {
        console.log(result);
        webSocket.close();

        eventSource = new EventSource(`/messages/${guid}`)
        // We will immediately be given a listing of currently connected peers. Save it for later
        eventSource.addEventListener('listing', messageEvent => {
            existingPeers = JSON.parse(messageEvent.data);
            browserData.concurrency = existingPeers.length;
        });
        // We will now be reported to others, so respond if they start to connect to us.
        eventSource.addEventListener('offer', messageEvent => { // TBD: Could 'icecandidate' also come first sometimes?
            const message = JSON.parse(messageEvent.data);
            // This could be a renegotiation of something that already has it's own connection.
            if (respondingConnections[message.from]) return;
            // Create a responder and let it act on the offer.
            respondingConnections[message.from] = new RespondingConnection(message);
        });
        return result;
    })
    .then(result =>
          test('sse',
               eventSource,
               data => fetch('/message', {
                   method: 'post',
                   headers: {'Content-Type': 'application/json'},
                   body: JSON.stringify({to: guid, from: guid, data: data})
               }),
               result))
    .then(_ => Promise.all(existingPeers.map(TestingConnection.run)))
    .then(results => {
        stream.getTracks().forEach(track => track.stop());
        console.info('Completed %s tests.', results.length);
        if (!results.length) report(browserData);
        userMessages.innerHTML = "Testing is complete. If you can, <b>please leave this page up</b> so that other people can test to you with higher concurrency. (No futher webcam or audio data will be used, however.)"
    });

