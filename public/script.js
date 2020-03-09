'use strict';

// References basic-report.js, but in a separate file so that obsolete browsers may still run that part
// despite syntax errors here.

// Communications:


var ourCurrentVersion, pingTimer, homeLine;
function sendSseMessage(data, type) { return homeLine.p2pSend(guid, type, data); }
const PING_TIMEOUT_MS = 15 * 1000;
function initEventSource() {
    // Server will timeout the connection, but a reload produce confusing results unless we play nice.
    function closeEventSource() {
        clearTimeout(pingTimer);
        if (homeLine) homeLine.close();
        homeLine = null;
    }
    function ping(data) {
        clearTimeout(pingTimer);
        pingTimer = setTimeout(_ => {
            console.warn('No SSE ping from server.');
            /* FIXME! closeEventSource();
            setTimeout(initEventSource, 3000);*/
        }, PING_TIMEOUT_MS);
        sendSseMessage(undefined, 'pong').catch(console.log);
    }
    // We will immediately be given a listing of currently connected peers. Save it for later
    function listing(data) {
        if (ourCurrentVersion && (ourCurrentVersion !== data.version)) {
            console.log('NEW VERSION', data.version);
            location.reload();
        }
        ourCurrentVersion = data.version;
        // Hitting refresh can sometimes allow our guid to still be registered.
        // We need two different EventSource to test loopback, but then we'd be registered twice and things would get weird.
        existingPeers = data.peers.filter(p => p !== guid);
        browserData.concurrency = existingPeers.length;
        browserData.ip = data.ip;
        updateTestingMessage();
    }
    // We will now be reported to others, so respond if they start to connect to us.
    function lockRequest(data, message) {
        // This could be a renegotiation of something that already has it's own RTC.
        if (RespondingRTC.existingInstance(message.from)) return;
        // Create a responder and let it act on the offer.
        return new RespondingRTC(message);
    }
    if (homeLine) return sendSseMessage(undefined, 'listing').then(_ => [homeLine, true]);
    window.addEventListener('beforeunload', closeEventSource);
    return new EventSourceDispatch(guid, {ping, listing, lockRequest}, ['ping', 'listing', 'lockRequest'], false)
        .then(d => [homeLine = d, false]);
}


// Testing:

var block = '', blockSize = 1<<15; // 32k 1-byte chracters (UTF-8)
for (var i = 0; i < blockSize; i++) { block += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i % 26]; }
var existingPeers = [], stream;
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
// We're relying on each kind of "channel" having and onopen and onmessage.
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
        if (skipSetup) channel.onopen(); // FIXME: we need to set onopen before creating channel
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
class CommonRTC extends EventSourceRTC { // RTC peer to whatever we are testing with. Two subclasses, below.
    constructor(peerId, ourId = guid) {
        return super(ourId, peerId, RTC_CONFIGURATION);
    }
    initDataChannel(channel) {
        this.channel = channel;
        channel.onerror = e => console.error(e); // Alas, not widely supported.
    }
}

class RespondingRTC extends CommonRTC { // If someone is starting a test with us, this is how we respond.
    static existingInstance(id) {
        return this.instances[id];
    }
    // Our event source received an unhandled message from someone who has started signaling with us.
    constructor(message) {
        super(message.from).then(that => {
            console.info('Starting response to', that.peerId);
            that.constructor.instances[that.peerId] = that; // Keep track for existingInstance.
            that.trackHandler = event => that.channel && that.channel.send(event.track.kind);
            that.peer.addEventListener('track', that.trackHandler);
            that.peer.ondatachannel = event => {
                console.log('Got data channel for', that.peerId);
                const channel = event.channel;
                that.initDataChannel(channel);
                channel.onmessage = event => {
                    const message = event.data,
                          key = message.slice(0, 4);
                    console.log('Got', key, 'from', that.peerId);
                    switch (key) {
                    case 'ping':
                        // Server should not send other people's data, but the peer can.
                        channel.send(browserData.ip);
                        break;
                    case 'data':
                        channel.send(message);
                        break;
                    default:
                        console.error('Unrecognized data', message, 'from', that.peerId);
                    }
                };
            };
            that[message.type](message.data); // And now act on whatever triggered our creation (e.g., offer).
            return that;
        });
    }
    close() {
        this.peer && this.peer.removeEventListener('track', this.trackHandler);
        this.peer && (this.peer.ondatachannel = null);
        this.channel && (this.channel.onmessage = null);
        delete this.constructor.instances[this.peerId];
        served.innerHTML = ++contributionCount;
        super.close();
    }
}
RespondingRTC.events = RTCSignalingPeer.events.concat('close');
RespondingRTC.instances = {};

var testSSE;
var testGUID = 'T' + guid;
class TestingRTC extends CommonRTC {
    static run(peerId) {
        return new TestingRTC(peerId, testGUID).then(rtc => {
            var mediaStartTime;
            rtc.results = Object.assign({peer: peerId}, browserData);
            return rtc.createDataChannel(`${rtc.id} => ${rtc.peerId}`, {}, {waitForOpen: false})
                .then(c => rtc.initDataChannel(c))
                .then(_ => testSetupPingBandwidth('data', rtc.channel,
                                                  data => rtc.channel.send(data),
                                                  rtc.results))
                .then(_ => rtc.testMedia())
                .then(_ => rtc.peer.getStats())
                .then(stats => rtc.reportMedia(stats))
                .then(_ => rtc.channel.onmessage = null)
                .catch(e => console.log('caught', e))
                .then(_ => rtc.p2pSend('close')) // Explicitly tell the RespondingRTC to go away
                .then(_ => rtc.close())
                .then(_ => report(rtc.results));
        });
    }
    signalingError(type, from, to, response) { // Can be overriden.
        console.error(type, from, to, response.status, response.url, response.statusText);
        this.channel.failReason = (response.status == 404) ? "peer offline" : response.statusText;
        return response;
    }
    testMedia() {
        const nTracksKey = 'nTracks';
        const setupKey = 'mediaSetup';
        const collector = this.results;
        var mediaStartTime
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
            collector[nTracksKey] = stream.getTracks().length;
            this.addStream(stream)
            var start = startSubtest(5000, collector, setupKey, reject);
        })
            .then(_ => stream && (collector.mediaRuntime = Date.now() - mediaStartTime))
            .catch(notarizeFailure(collector, setupKey));
    }
    reportMedia(stats) {
        var selected;
        stats.forEach(report => {
            if ((report.type === 'candidate-pair') && // find the selected report
                (report.selected || (report.nominated && ((report.state === 'succeeded') || report.writable)))) {
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
            const pairs = [];
            stats.forEach(r => {  // stats doesn't have .filter() on Edge
                if ((r.type === 'candidate-pair') && r.nominated) {
                    pairs.push(r);
                }
            });
            console.error('No selected candidate-pair report', pairs);
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

const RETEST_INTERVAL_MS = 30 * 60 * 1000; // Every half hour
var retestTimer;
function doAllTests() {
    retest.disabled = true;
    clearTimeout(retestTimer);
    if (FAILED) return console.error("Missing required functionality.");
    setTimestamp();
    obtainMediaStream(browserData.av, browserData, 'mediaSetup') // Just once...
        .then(media => stream = media) // ... and shared among each RTCPeerConnection
        .then(updateTestingMessage)
    
        .then(_ => new WebSocketDispatch(guid, {}, [], false))
        .then(wsDispatcher => 
            testSetupPingBandwidth('ws', wsDispatcher.connection,
                                   data => wsDispatcher.p2pSend(guid, undefined, data),
                                   browserData)
              .then(_ => wsDispatcher))
        .then(wsDispatcher => wsDispatcher.close())
    
        .then(initEventSource)
        .then(([dispatcher, reinited]) => testSetupPingBandwidth('sse', dispatcher.connection,
                                                                 sendSseMessage, browserData,
                                                                 !!reinited))
    
        .then(_ => Promise.all(existingPeers.map(TestingRTC.run)))
    
        .then(results => {
            stream && stream.getTracks().forEach(track => track.stop());
            console.info(`Completed ${results.length} peer tests.`);
            retestTimer = setTimeout(doAllTests, RETEST_INTERVAL_MS);
            if (!results.length) report(browserData);
            userMessages.innerHTML = "Testing is complete. If you can,"
                + " <b>please leave this page up</b> so that we can automaticall retest periodically,"
                + " and so other people can test with you at higher concurrency."
                + " Next test scheduled for " + new Date(Date.now() + RETEST_INTERVAL_MS);
            retest.disabled = false;
        })

}
window.onload = doAllTests;

