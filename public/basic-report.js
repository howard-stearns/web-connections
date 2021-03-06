'use strict';

// Basic info for reporting:
// Everything through the first call to report() on FAILED should work in IE9
var FAILED = false;
var dummy = window.RTCPeerConnection && new window.RTCPeerConnection();
var audioContext = window.AudioContext || window.webkitAudioContext || window.mozAudioContext || window.oAudioContext || window.msAudioContext;
var browserData = {
    promises: !!window.Promise,
    storage: !!window.localStorage,
    ws: !!window.WebSocket,
    sse: !!window.EventSource,
    s2t: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
    t2s: !!window.speechSynthesis,
    rtc: !!window.RTCPeerConnection,
    dchan: dummy && !!dummy.createDataChannel,
    av: !!navigator.mediaDevices && !!navigator.mediaDevices.getUserMedia,
    audioNode: !!audioContext
        && !!window.MediaStreamAudioDestinationNode && !!window.ChannelMergerNode && !!window.AudioWorkletNode
        && !!new audioContext().createChannelMerger
        && !!new audioContext().createMediaStreamDestination && !!new audioContext().createMediaStreamSource,
    capture: !!document.createElement('video').captureStream,
    webgl: !!document.createElement('canvas').getContext('webgl'),
    webgl2: !!document.createElement('canvas').getContext('webgl2')
}
dummy = null;

var loadStart, rate, currentCredits, creditsTimer;
function showCredits(number, element) {
    element.innerHTML = Math.floor(number).toLocaleString(undefined, {minimumIntegerDigits: 9});
}
function updateCredits() {
    if (!loadStart || !rate) return;
    const sinceStart = Date.now() - loadStart;
    const accrued = sinceStart * rate;
    showCredits(accrued, creditsEstimated);
}
function startCredits() {
    const now = Date.now();
    loadStart = now - Math.round(currentCredits / rate);
    creditsTimer = setInterval(updateCredits, 100);
}
function stopCredits() {
    clearInterval(creditsTimer);
}
function setCredits() {
    var xmlhttp = new XMLHttpRequest();
    xmlhttp.open("GET", "/stats/" + guid);
    xmlhttp.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
    xmlhttp.onload = function () {
        const data = JSON.parse(xmlhttp.response);
        rate = data.rate;
        currentCredits = data.credits;
        showCredits(currentCredits, creditsRecorded);
    };
    xmlhttp.send();
}

function uuidv4(label) { // Not crypto strong, but good enough for prototype.
    label = label || '';
    return label + 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Whenever this browser on this machine tests again, we want the same id.
// localStorage is NOT shared between different browsers on the same machine,
// but it is shared between tabs of the same browser.
var ID_KEY = 'guid';
var guid = window.localStorage && localStorage.getItem(ID_KEY);
if (!guid) {
    guid = uuidv4();
    if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().then(function (persistent) {
            if (persistent)
                console.log("Storage will not be cleared except by explicit user action");
            else
                console.log("Storage may be cleared by the UA under storage pressure.");
        });
    }
}
setCredits();

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
    console.info("Test " + guid + (FAILED ? " failed" : " passed"), data.peer || "");
    window.result = data;
    const keys = [
        "date","tzOffset", "ip", "peerIp",
        ["local-protocol", "local-candidateType", "local-address"],
        ["remote-protocol", "remote-candidateType", "remote-address"],
         "peer",
        "concurrency",
        "wsSetup","wsPing","wsKbs",
        "sseSetup","ssePing","sseKbs",
        "dataSetup","dataPing","dataKbs",
        "nTracks", "mediaSetup", "mediaRuntime",
        "outbound-rtp-audio-bytesSent","outbound-rtp-audio-nackCount","outbound-rtp-audio-packetsSent",
        "outbound-rtp-video-bitrateMean","outbound-rtp-video-bitrateStdDev","outbound-rtp-video-bytesSent","outbound-rtp-video-droppedFrames","outbound-rtp-video-framerateMean","outbound-rtp-video-framerateStdDev","outbound-rtp-video-framesEncoded","outbound-rtp-video-nackCount","outbound-rtp-video-packetsSent",
        "remote-inbound-rtp-audio-bytesReceived","remote-inbound-rtp-audio-jitter","remote-inbound-rtp-audio-packetsLost","remote-inbound-rtp-audio-packetsReceived","remote-inbound-rtp-audio-roundTripTime",
        "remote-inbound-rtp-video-bytesReceived","remote-inbound-rtp-video-jitter","remote-inbound-rtp-video-packetsLost","remote-inbound-rtp-video-packetsReceived","remote-inbound-rtp-video-roundTripTime"];
    const row = document.createElement('tr');
    keys.forEach(function (key) {
        const item = document.createElement('td');
        var value = Array.isArray(key) ? key.map(function (k) { return data[k]; }).join(' ') : data[key];
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
    const stringified = JSON.stringify(data);
    console.log('uploading', stringified);
    /* This is what we would want, but we still want to gather failure results from MSIE, which doesn't have fetch...
    fetch("/upload", {
        method: 'post',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(data)
    })
        .catch(error => console.error('post', error));
    */
    var xmlhttp = new XMLHttpRequest();
    xmlhttp.open("POST", "/upload");
    xmlhttp.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
    xmlhttp.onload = setCredits;
    xmlhttp.send(stringified);
}

Object.keys(browserData).forEach(function (key) {
    document.getElementById(key).checked = browserData[key];
    if (!browserData[key] && ['av', 't2s', 's2t', 'audioNode', 'capture', 'webgl', 'webgl2'].indexOf(key) < 0) {
        FAILED = true;
        browserData.concurrency = browserData.concurrency || 'missing:';
        browserData.concurrency += ' ' + key;
    }
});
ourId.innerHTML = browserData.id = guid; 
agent.innerHTML = browserData.agent = navigator.userAgent;

function setTimestamp() {
    const now = new Date();
    browserData.date = now.toISOString();
    browserData.tzOffset = now.getTimezoneOffset();
}
setTimestamp();

if (FAILED) {
    report(browserData);
    start.disabled = true;
    creditsEstimated.innerHTML = "This browser is not modern enough to be used."
}
localStorage.setItem(ID_KEY, guid);
