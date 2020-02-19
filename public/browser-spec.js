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
        //{urls: 'stun:ice.highfidelity.com'},
        {urls: [
            "stun:stun.l.google.com:19302",
        ]},
        {urls: 'turn:numb.viagenie.ca',
         credential: 'muazkh',
         username: 'webrtc@live.com'}
    ]
};


describe('browser side', function () {
    const protocol = (location.protocol === 'http:') ? 'ws:' : 'wss:';
    const wsSite = protocol + "//" + location.host;
    beforeAll(function (done) { // Give puppeteer a chance to hook into reporters.
        setTimeout(_ => done(), 1000);
    });
    describe('event source', function () {        
        var eventSource, eventHandler, secondSource;
        var target = uuidv4('sse-target-'), source = uuidv4('sse-source-'), type = 'foo';        
        beforeAll(function (done) { // Wait for open before starting tests.
            eventSource = new EventSource(`/messages/${target}`);
            eventSource.onopen = done;
        });
        afterEach(function () {
            eventSource.onmessage = null;
        });
        afterAll(function () {
            eventSource.close();
            secondSource.close();
        });
        function sendMessage(payload, type = '', to = target, from = source) {
            const body = {
                to: to,
                from: from,
                data: payload
            };
            if (type) body.type = type;
            return fetch('/message', {
                method: 'post',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(body)
            });
        }
        it('loops back messages', function (done) {
            const payload = 'payload1';
            eventSource.onmessage = event => {
                const message = JSON.parse(event.data);
                expect(message.data).toBe(payload);
                expect(message.from).toBe(source);
                done();
            };
            sendMessage(payload);
        });
        it('loops back events', function (done) {
            const payload = 'payload2';
            eventSource.onmessage = event => {
                fail(`Message delivered: '${event.data}'`);
            };
            eventSource.addEventListener(type, event => {
                const message = JSON.parse(event.data);
                expect(message.data).toBe(payload);
                expect(message.from).toBe(source);
                expect(event.type).toBe(type);
                done();
            }, {once: true});
            sendMessage(payload, type);
        });
        it('delivers in order', function (done) {
            var payloads = ['a', 'b', 'c', 'd', 'e', 'f'],
                received = 0,
                serialSend = serializePromises(sendMessage);
            eventSource.onmessage = event => {
                const message = JSON.parse(event.data);
                expect(message.data).toBe(payloads[received++]);
                if (received >= payloads.length) done();
            };
            payloads.forEach(p => serialSend(p));
        });
        it('distinguishes by id', function (done) {
            const secondId = uuidv4('sse-second-');
            const second = secondSource = new EventSource(`/messages/${secondId}`);
            second.onopen = _ => {
                Promise.all([
                    new Promise(resolve => {
                        second.onmessage = event => {
                            expect(JSON.parse(event.data).data).toBe('for2');
                            resolve();
                        };
                    }),
                    new Promise(resolve => {
                        eventSource.onmessage = event => {
                            expect(JSON.parse(event.data).data).toBe('for1');
                            resolve();
                        };
                    })
                ]).then(done);
                sendMessage('for1', null, target, secondId)
                sendMessage('for2', null, secondId, target)
            };
        });
    });
    describe('web socket', function () {
        var wsA, wsB, a = uuidv4('wsA-'), b = uuidv4('wsB-');
        beforeAll(function (done) { // Wait for open before starting tests.
            wsA = new WebSocket(`${wsSite}/${a}`);
            wsA.onopen = _ => {
                wsB = new WebSocket(`${wsSite}/${b}`);
                wsB.onopen = done;
            };
        });
        afterEach(function () {
            wsA.onmessage = wsB.onmessage = null;
        });
        afterAll(function () {
            wsA.close();
            wsB.close();
        });
        function sendMessage(payload, to, from, type = '') {
            const data = {from: from, to: to, data: payload};
            if (type) data.type = type;
            ((from === a) ? wsA : wsB).send(JSON.stringify(data));
        }
        it('loops back messages', function (done) {
            const payload = 'payload1';
            wsB.onmessage = event => {
                const message = JSON.parse(event.data);
                expect(message.data).toBe(payload);
                expect(message.from).toBe(a);
                done();
            };
            sendMessage(payload, b, a);
        });
        it('delivers in order', function (done) {
            var payloads = ['a', 'b', 'c', 'd', 'e', 'f'], received = 0;
            wsB.onmessage = event => {
                const message = JSON.parse(event.data);
                expect(message.data).toBe(payloads[received++]);
                if (received >= payloads.length) done();
            };
            payloads.forEach(p => sendMessage(p, b, a));
        });
        it('distinguishes by id', function (done) {
            Promise.all([
                new Promise(resolve => {
                    wsB.onmessage = event => {
                        const message = JSON.parse(event.data);
                        expect(message.data).toBe('for2');
                        expect(message.type).toBe('y');
                        expect(message.from).toBe(a);
                        resolve();
                    };
                }),
                new Promise(resolve => {
                    wsA.onmessage = event => {
                        const message = JSON.parse(event.data);
                        expect(message.data).toBe('for1');
                        expect(message.type).toBe('x');
                        expect(message.from).toBe(b);
                        resolve();
                    };
                })
            ]).then(done);
            sendMessage('for1', a, b, 'x');
            sendMessage('for2', b, a, 'y');
        });
    });
    
    describe('data stream signalling', function () {
        var connection1, connection2;
        var pipe1, pipe2;
        const id1 = uuidv4('data-1-');
        const id2 = uuidv4('data-2-');
        afterEach(function (done) {
            setTimeout(_ => {
                [connection1.peer, connection2.peer, pipe1, pipe2].forEach(o => o && o.close());
                done();
            }, 500);
        });
        function testDataStreams(thunks, peerClass, done) {
            function run(done) {
                const setupLabel = peerClass.name + ' data channel open';
                const pingLabel = peerClass.name + ' data ping roundtrip';
                connection1 = new peerClass(pipe1, id1, id2, CONFIGURATION);
                connection2 = new peerClass(pipe2, id2, id1, CONFIGURATION);
                connection1.peer.onclose = _ => console.log(connection1.id, 'closed');
                connection2.peer.onclose = _ => console.log(connection1.id, 'closed');
                connection2.peer.ondatachannel = event => {
                    const channel2 = event.channel;
                    console.log('channel2 got data channel');
                    channel2.onerror = e => debug('fixme channel2 error', e);
                    channel2.onopen = _ => console.log('fixme channel2 open');
                    channel2.onmessage = event => {
                        console.log('channel2 got', event.data);
                        expect(event.data).toBe('ping');
                        channel2.send('pong');
                    };
                };
                console.time(setupLabel);
                const channel1 = connection1.peer.createDataChannel('1:2', null);
                channel1.onopen = _ => {
                    console.timeEnd(setupLabel);
                    console.time(pingLabel)
                    channel1.send('ping');
                };
                channel1.onmessage = event => {
                    console.timeEnd(pingLabel);
                    console.log('channel1 got', event.data);
                    expect(event.data).toBe('pong');
                    console.log(peerClass.name, 'data finished');
                    done();
                };
                channel1.onerror = e => debug('fixme channel1 error', e);
            }
            return function (done) {
                console.log('start data', peerClass.name);
                if (thunks) {
                    pipe1 = thunks[0]();
                    pipe1.onopen = _ => {
                        pipe2 = thunks[1]();
                        pipe2.onopen = _ => run(done);
                    }
                } else {
                    run(done);
                }
            };
        }
        it('loopback', testDataStreams(null, LoopbackRTC));
        it('web socket', testDataStreams([_ => new WebSocket(`${wsSite}/${id1}`),
                                          _ => new WebSocket(`${wsSite}/${id2}`)],
                                         WebSocketRTC));
        it('event stream', testDataStreams([_ => new EventSource(`/messages/${id1}`),
                                            _ => new EventSource(`/messages/${id2}`)],
                                           EventSourceRTC));

    });
    describe('media stream signalling', function () {
        var connection1, connection2;
        var pipe1, pipe2;
        const id1 = uuidv4('media-1');
        const id2 = uuidv4('media-2');
        afterEach(function (done) {
            setTimeout(_ => {
                [connection1.peer, connection2.peer, pipe1, pipe2].forEach(o => o && o.close());
                done();
            }, 500);
        });
        function testMediaStreams(thunks, peerClass, done) {
            function run(done) {
                if (!(('mediaDevices' in navigator) &&
                      ('getUserMedia' in navigator.mediaDevices))) {
                    return done();
                }
                navigator.mediaDevices
                    .getUserMedia({video: true, audio: true})
                    .then(stream => {
                        if (!stream) return fail('No media stream');
                        const setupLabel = peerClass.name + ' media channel open';
                        const tracks = {};
                        var trackCount = 2;
                        connection1 = new peerClass(pipe1, id1, id2, CONFIGURATION);
                        connection2 = new peerClass(pipe2, id2, id1, CONFIGURATION);
                        connection1.peer.onclose = _ => console.log(connection1.id, 'closed');
                        connection2.peer.onclose = _ => console.log(connection1.id, 'closed');
                        function checkConnected() {
                            // Some browsers (firefox) don't define connectionState nor fire connectionstatechange.
                            if (['connected', undefined].includes(connection1.peer.connectionState)
                                && ['connected', undefined].includes(connection2.peer.connectionState)
                                && !trackCount) {
                                console.log(peerClass.name, 'media finished');
                                done();
                            }
                        }
                        connection1.peer.onconnectionstatechange = checkConnected;
                        connection2.peer.onconnectionstatechange = checkConnected;
                        
                        connection2.peer.addEventListener('track', event => {
                            const track = event.track,
                                  trackId = event.streams[0].id;
                            expect(trackId).toBe(tracks[track.kind]);
                            if (--trackCount <= 0) {
                                console.timeEnd(setupLabel);
                                checkConnected();
                            }
                        });

                        console.time(setupLabel);
                        stream.getTracks().forEach(track => {
                            tracks[track.kind] = stream.id; // Stream id is same at both ends. Track id is not.
                            connection1.peer.addTrack(track, stream);
                        });
                    },
                          error => { debug(error); done();});
            }
            return function (done) {
                console.log('start media', peerClass.name);
                if (thunks) {
                    pipe1 = thunks[0]();
                    pipe1.onopen = _ => {
                        pipe2 = thunks[1]();
                        pipe2.onopen = _ => run(done);
                    }
                } else {
                    run(done);
                }
            };
        }
        it('loopback', testMediaStreams(null, LoopbackRTC));
        it('web socket', testMediaStreams([_ => new WebSocket(`${wsSite}/${id1}`),
                                           _ => new WebSocket(`${wsSite}/${id2}`)],
                                          WebSocketRTC));
        it('event stream', testMediaStreams([_ => new EventSource(`/messages/${id1}`),
                                             _ => new EventSource(`/messages/${id2}`)],
                                            EventSourceRTC));
    });
});
