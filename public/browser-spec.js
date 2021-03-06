/*global describe, it, require*/
"use strict";

function uuidv4(label = '') { // Not crypto strong, but good enough for prototype.
    return label + 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}
function debug(...args) {
    console.error(...args);
    setTimeout(_ => alert([...args].map(x => (typeof x === 'object') ? JSON.stringify(x) : x).join(' ')), 0);
}

const CONFIGURATION = {
    iceServers: [
        {urls: [
            //'stun:turn.highfidelity.com:3478'
            'stun:stun.l.google.com:19302'
            //'stun:ice.highfidelity.com'
        ]},
        {urls: 'turn:turn.highfidelity.com:3478', username: 'clouduser', credential: 'chariot-travesty-hook'}
        //{urls: 'turn:numb.viagenie.ca', username: 'webrtc@live.com', credential: 'muazkh'}
    ]
    //, iceTransportPolicy: 'relay'
};


var currentSpecName;
jasmine.getEnv().addReporter({
    specStarted: function (spec) {
        currentSpecName = spec.fullName;
    }
});
function showError(label, code, name, message) {
    const string = [currentSpecName, label, code, name, message].join(' ');
    const div = document.createElement('div');
    div.innerHTML = string;
    errors.appendChild(div);
}

var masterStream, resolver;
const capture = videoElement.captureStream || videoElement.mozCaptureStream;
describe('Browser', function () {
    const protocol = (location.protocol === 'http:') ? 'ws:' : 'wss:';
    const wsSite = protocol + "//" + location.host;
    beforeAll(function (done) { // Give user a chance to push the startButton
        if (!!capture) {
            startButton.style.display = "block";
            startButton.onclick = function () {
                videoElement.loop = true;
                videoElement.muted = false;
                videoElement.volume = 0.0;
                videoElement.play();
                masterStream = capture.call(videoElement);
                resolver();
            };
            resolver = done;
        } else if (!navigator.mediaDevices) {
            done();
        } else {
            navigator.mediaDevices
                .getUserMedia({audio: true, video: true})
                .catch(_ => null)
                .then(mediaStream => masterStream = mediaStream)
                .then(done);
        }
    }, 10 * 1000);
    afterAll(function () {
        videoElement.pause();
    });
    var idA, idB;
    beforeEach(function () {
        idA = uuidv4(Math.random() < 0.5 ? 'A' : 'C'); // One is "polite" relatibe to idB, the other not.
        idB = uuidv4('B');
    });
    describe('p2pDispatch', function () {
        function makeDispatchSuite(dispatcherClass) {
            describe(dispatcherClass.name, function () {
                var dispatcherA, dispatcherB, receiverA, receiverB, events = ['foo', 'bar'];
                beforeEach(function (done) { // Wait for open before starting tests.
                    receiverA = {peerId: idB};
                    receiverB = {peerId: idA};
                    Promise.all([
                        (new dispatcherClass(idA, receiverA, events)).openPromise.then(a => dispatcherA = a),
                        (new dispatcherClass(idB, receiverB, events)).openPromise.then(b => dispatcherB = b)
                    ]).then(done);
                });
                afterEach(function () {
                    dispatcherA.close();
                    dispatcherB.close();
                });
                it('sends to self', function (done) {
                    const type = events[0], payload = 'payload';
                    receiverB.peerId = idB; // Enables sending to self.
                    receiverB[type] = data => {
                        expect(data).toBe(payload);
                        done();
                    };
                    dispatcherB.p2pSend(idB, type, payload);
                });
                it('send to other ids', function (done) {
                    const type = events[0], payload = 'payload'
                    receiverB[type] = data => {
                        expect(data).toBe(payload);
                        done();
                    };
                    dispatcherA.p2pSend(idB, type, payload);
                });
                it('delivers in order', function (done) {
                    var payloads = ['a', 'b', 'c', 'd', 'e', 'f'],
                        received = 0,
                        type = events[0];
                    receiverB[type] = data => {
                        expect(data).toBe(payloads[received++]);
                        if (received >= payloads.length) done();
                    };
                    payloads.forEach(p => dispatcherA.p2pSend(idB, type, p));
                });
                it('distinguishes by type', function (done) {
                    var payloadForFoo = 'payload 1', payloadForBar = 'payload 2';
                    Promise.all([
                        new Promise(resolve => { receiverB[events[0]] = resolve; }),
                        new Promise(resolve => { receiverB[events[1]] = resolve; })
                    ]).then(([answerA, answerB]) => {
                        expect(answerA).toBe(payloadForFoo);
                        expect(answerB).toBe(payloadForBar);
                        done();
                    });
                    dispatcherA.p2pSend(idB, events[0], payloadForFoo);
                    dispatcherA.p2pSend(idB, events[1], payloadForBar);
                });
                it('distinguishes by to', function (done) {
                    var payloadForA = 'payload 1', payloadForB = 'payload 2', type = events[0];
                    Promise.all([
                        new Promise(resolve => { receiverA[type] = resolve; }),
                        new Promise(resolve => { receiverB[type] = resolve; })
                    ]).then(([answerA, answerB]) => {
                        expect(answerA).toBe(payloadForA);
                        expect(answerB).toBe(payloadForB);
                        done();
                    });
                    dispatcherA.p2pSend(idB, type, payloadForB);
                    dispatcherB.p2pSend(idA, type, payloadForA);
                });
                it('distinguishes by from', function (done) {
                    var payloadFromX = 'payload 1', payloadFromB = 'payload 2', type = events[0];
                    var idX = uuidv4('X'), receiverAX = {peerId: idX};
                    Promise.all([
                        (new dispatcherClass(idA, receiverAX, events)).openPromise,
                        (new dispatcherClass(idX, {peerId: idA}, events)).openPromise
                    ]).then(([dispatcherAX, dispatcherXA]) => {
                        Promise.all([
                            new Promise(resolve => receiverA[type] = resolve),
                            new Promise(resolve => receiverAX[type] = resolve)
                        ]).then(([answerB, answerX]) => {
                            expect(answerB).toBe(payloadFromB);
                            expect(answerX).toBe(payloadFromX);
                            dispatcherXA.close();
                            dispatcherAX.close();                        
                            done();
                        });
                        dispatcherXA.p2pSend(idA, type, payloadFromX);
                        dispatcherB.p2pSend(idA, type, payloadFromB);
                    });
                });
                it('leaves nothing behind (and close can be called more than once)', function (done) {
                    const connection = dispatcherA.connection;
                    dispatcherA.close();
                    expect(dispatcherA.connection).toBeFalsy();
                    if (connection.readyState) {
                        expect(connection.onopen).toBe(null);
                        expect(connection.onclose).toBeFalsy(); // Doesn't ever exist on EventSource.
                        expect(connection.onerror).toBe(null);
                        // Alas, no way to confirm that any addEventListener's have been removed.
                        expect(connection.onmessage).toBe(null);
                        // If no failures, then there should not be anything holding the connection open.
                        expect(connection.readyState).toBeGreaterThanOrEqual(2); // WebSocket could be closing or closed
                    }
                    expect(Object.keys(receiverA).length).toBe(1); // peerId
                    done();
                });
            });
        }
        makeDispatchSuite(LoopbackDispatch);
        makeDispatchSuite(RandomDelayLoopbackDispatch);
        makeDispatchSuite(WebSocketDispatch);
        makeDispatchSuite(EventSourceDispatch);
        makeDispatchSuite(CroquetDispatch);
    });
    describe('signaling', function () {
        function makeSignalingSuite(peerClass) {
            describe(peerClass.name, function () {
                var rtcA, rtcB;
                beforeEach(function (done) {
                    Promise.all([ // Wait for open before starting tests.
                        (new peerClass(idA, idB, CONFIGURATION, {onerror: showError})).then(a => rtcA = a),
                        (new peerClass(idB, idA, CONFIGURATION, {onerror: showError})).then(b => rtcB = b)
                    ]).then(done);
                });
                afterEach(function () {
                    rtcA.close();
                    rtcB.close();
                });
                var label = "foo", payload = "ping";
                describe('lock', function () {
                    const pauseMs = 1000;
                    async function waits(resolve) {
                        await new Promise(resolve => setTimeout(resolve, pauseMs));
                        return resolve(1);
                    }
                    function resolves(resolve) {
                        setTimeout(_ => resolve(1), pauseMs);
			            return 1;
                    }
                    function rejects(_, reject) {
                        setTimeout(_ => reject(99), pauseMs);
			            return 1;
                    }
                    describe('acquire and releases', function () {
                        it('with waiting', function (done) {
                            rtcA.acquireLock(waits).then(x => {
                                expect(x).toBe(1);
                                done();
                            });
                        });
                        it('with resolution', function (done) {
                            rtcA.acquireLock(resolves).then(x => {
                                expect(x).toBe(1);
                                done();
                            });
                        });
                        it('with rejection', function (done) {
                            rtcA.acquireLock(rejects).catch(e => e).then(x => {
                                expect(x).toBe(99);
                                done();
                            });
                        });
                        it('times out', function (done) {
                            rtcA.acquireLock(resolves, 500).catch(e => e).then(x => {
                                expect(x).toBeFalsy();
                                done();
                            });
                        });
                    });
                    describe('queues in order', function () {
                        function testQueueing(connectionA, connectionB, done) {
                            var executingA = false, executingB = false;
			    // These two promises are overly complex because acquireLock had started with a different API.
			    // IWBNI we went back and simplified them.
                            Promise.all([
                                connectionA.acquireLock(async resolve => {
                                    var x;
                                    executingA = true;
                                    expect(executingB).toBeFalsy();
                                    x = await new Promise(resolve => waits(resolve));
                                    expect(x).toBe(1);
                                    executingA = false;
                                    expect(executingB).toBeFalsy();
                                    resolve('a');
                                }),
                                connectionB.acquireLock(resolve => {
                                    executingB = true;
                                    expect(executingA).toBeFalsy();
                                    new Promise(resolve => resolves(resolve)).then(x => {
                                        expect(x).toBe(1);
                                        executingB = false;
                                        expect(executingA).toBeFalsy();
                                        resolve('b');
                                    });
                                })
                            ]).then(([a, b]) => {
                                expect(a).toBe('a');
                                expect(b).toBe('b');
                                done();
                            });
                        }
                        it('orders on same side', function (done) {
                            testQueueing(rtcA, rtcA, done);
                        });
                        it('orders on other side', function (done) {
                            testQueueing(rtcA, rtcB, done);
                        });
                    });
                });
                describe('negotiation', function () {
                    describe('data', function () {
                        it('can send data on open', function (done) {
                            rtcB.peer.ondatachannel = event => {
                                const bChannel = event.channel;
                                expect(bChannel.label).toBe(label);
                                bChannel.onmessage = messageEvent => {
                                    expect(messageEvent.data).toBe(payload);
                                    done();
                                };
                            };
                            rtcA.createDataChannel(label).then(aChannel => {
                                expect(aChannel.label).toBe(label);
                                aChannel.send(payload);
                            });
                        });
                        it('can send data on channel', function (done) {
                            rtcB.peer.ondatachannel = event => {
                                const bChannel = event.channel;
                                // Note that the spec says that on 'datachannel', the
                                // channel might not actually be open. And indeed, on
                                // Safari, it isn't. One must wait for 'open'.
                                bChannel.onopen = _ => bChannel.send(payload);
                                expect(bChannel.label).toBe(label);
                            };
                            rtcA.createDataChannel(label).then(aChannel => {
                                aChannel.onmessage = messageEvent => {
                                    expect(aChannel.label).toBe(label);
                                    expect(messageEvent.data).toBe(payload);
                                    done();
                                };
                            });
                        });
                        it('can send through two data channels on open', function (done) {
                            const label2 = "bar", payload2 = "baz";
                            var nMessages = 2;
                            rtcB.peer.ondatachannel = event => {
                                const bChannel = event.channel;
                                bChannel.onmessage = messageEvent => {
                                    const thisPayload = (bChannel.label === label2) ? payload2 : payload;
                                    expect(messageEvent.data).toBe(thisPayload);
                                    if (--nMessages === 0) done();
                                };
                            };
                            rtcA.createDataChannel(label).then(aChannel1 => {
                                expect(aChannel1.label).toBe(label);
                                aChannel1.send(payload);
                            });
                            rtcA.createDataChannel(label2).then(aChannel2 => {
                                expect(aChannel2.label).toBe(label2);
                                aChannel2.send(payload2);
                            });
                        });
                    });
                    describe('glare situations', function () {
                        // These work on Firefox - but not Chrome or Safari - using the techniques from
                        // https://blog.mozilla.org/webrtc/perfect-negotiation-in-webrtc/
                        // Instead, we make them work everywhere using the acquireLock technique.
                        it('can create data channels from both sides', function (done) {
                            const label2 = "bar", payload2 = "baz"
                            Promise.all([
                                new Promise(resolve => {
                                    rtcA.peer.ondatachannel = event => {
                                        const aChannel = event.channel;
                                        expect(aChannel.label).toBe(label2);
                                        aChannel.onmessage = messageEvent => {
                                            expect(messageEvent.data).toBe(payload2);
                                            resolve();
                                        };
                                    };
                                }),
                                new Promise(resolve => {
                                    rtcB.peer.ondatachannel = event => {
                                        const bChannel = event.channel;
                                        expect(bChannel.label).toBe(label);
                                        bChannel.onmessage = messageEvent => {
                                            expect(messageEvent.data).toBe(payload);
                                            resolve();
                                        };
                                    };
                                })
                            ]).then(done);
                            rtcA.createDataChannel(label).then(aChannel => {
                                expect(aChannel.label).toBe(label);
                                aChannel.send(payload);
                            });
                            rtcB.createDataChannel(label2).then(bChannel => {
                                expect(bChannel.label).toBe(label2);
                                bChannel.send(payload2);
                            });
                        });

                        it('can prearrange data', function (done) {
                            const opts = {negotiated: true, id: 12}, payload2 = "pong";
                            Promise.all([
                                rtcA.createDataChannel(label, opts),
                                rtcB.createDataChannel(label, opts)
                            ]).then(([aChannel, bChannel]) => {
                                expect(aChannel.label).toBe(label);
                                expect(aChannel.id).toBe(opts.id);
                                expect(bChannel.label).toBe(label);
                                expect(bChannel.id).toBe(opts.id);
                                return Promise.all([
                                    new Promise(resolve => {
                                        aChannel.onmessage = event => resolve(event.data);
                                        aChannel.send(payload);
                                    }),
                                    new Promise(resolve => {
                                        bChannel.onmessage = event => resolve(event.data);
                                        bChannel.send(payload2);
                                    })
                                ]);
                            }).then(([aResult, bResult]) => {
                                expect(aResult).toBe(payload2);
                                expect(bResult).toBe(payload);
                                done();
                            });
                        });
                    });
                    describe('media', function () {
                        var stream = null
                        beforeEach(function () {
                            stream = masterStream && masterStream.clone();
                        });
                        afterEach(function () {
                            stream && stream.getTracks().forEach(track => track.stop());
                        });
                        afterAll(function () {
                            masterStream && masterStream.getTracks().forEach(track => track.stop());
                        });
                        function checkStream(done) {
                            if (masterStream) return true;
                            pending();
                            done();
                            return false;
                        }
                        it('can send media', function (done) {
                            if (!checkStream(done)) return;
                            var nTracks = stream.getTracks().length;
                            expect(nTracks).toBe(2);
                            Promise.all([
                                rtcA.addStream(stream),
                                new Promise(resolve => {
                                    rtcB.peer.ontrack = event => {
                                        const thisStream = event.streams[0],
                                              theseTracks = thisStream.getTracks();
                                        expect(thisStream.id).toBe(stream.id);
                                        if (--nTracks <= 0) resolve();
                                    };
                                    rtcA.peer.ontrack = event => fail("got track on sender");
                                })
                            ]).then(_ => setTimeout(done, 0));
                        });
                        it('can send media in both directions', function (done) {
                            if (!checkStream(done)) return;
                            const stream2 = stream.clone();
                            var n1 = stream.getTracks().length, n2 = stream2.getTracks().length;
                            expect(n2).toBe(2);
                            Promise.all([
                                new Promise(resolve => rtcA.peer.ontrack = e => {if (--n2 <= 0) resolve(e);}),
                                new Promise(resolve => rtcB.peer.ontrack = e => {if (--n1 <= 0) resolve(e);}),
                                rtcA.addStream(stream),
                                rtcB.addStream(stream2)
                            ]).then(events => {
                                expect(events[0].streams[0].id).toBe(stream2.id);
                                expect(events[1].streams[0].id).toBe(stream.id);
                                stream2.getTracks().forEach(track => track.stop());
                                done();
                            });
                        });
                        it('can send data and media', function (done) {
                            if (!checkStream(done)) return;
                            Promise.all([
                                new Promise(resolve => {
                                    rtcB.peer.ondatachannel = event => {
                                        const bChannel = event.channel;
                                        expect(bChannel.label).toBe(label);
                                        bChannel.onmessage = messageEvent => {
                                            expect(messageEvent.data).toBe(payload);
                                            resolve();
                                        };
                                    };
                                }),
                                new Promise(resolve => {
                                    rtcB.peer.ontrack = resolve;
                                }),
                                rtcA.createDataChannel(label).then(aChannel => {
                                    expect(aChannel.label).toBe(label);
                                    aChannel.send(payload);
                                }),
                                rtcA.addStream(stream)
                            ]).then(done);
                        });
                    });
                });
            });
        }
        makeSignalingSuite(LoopbackRTC);
        makeSignalingSuite(RandomDelayLoopbackRTC);        
        makeSignalingSuite(WebSocketRTC);
        makeSignalingSuite(EventSourceRTC);
        makeSignalingSuite(CroquetRTC);
    });
});
