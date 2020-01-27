/*global describe, it, require*/
"use strict";

function uuidv4() { // Not crypto strong, but good enough for prototype.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

describe('browser side', function () {
    const protocol = (location.protocol === 'http:') ? 'ws:' : 'wss:';
    const wsSite = protocol + "//" + location.host;
    beforeAll(function (done) { // Give puppeteer a chance to hook into reporters.
        setTimeout(_ => done(), 1000);
    });
    describe('event source', function () {        
        var eventSource, eventHandler;
        var target = uuidv4(), source = uuidv4(), type = 'foo';        
        beforeAll(function (done) { // Wait for open before starting tests.
            eventSource = new EventSource(`/messages?id=${target}`);
            eventSource.onopen = done;
        });
        afterEach(function () {
            eventSource.onmessage = null;
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
            }).then(response => expect(response.status).toBe(200));
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
        it('delivers in order', async function (done) {
            var payloads = ['a', 'b', 'c', 'd', 'e', 'f'], received = 0;
            eventSource.onmessage = event => {
                const message = JSON.parse(event.data);
                expect(message.data).toBe(payloads[received++]);
                if (received >= payloads.length) done();
            };
            for (const p of payloads) await sendMessage(p);
        });
        it('distinguishes by id', function (done) {
            const secondId = uuidv4();
            const second = new EventSource(`/messages?id=${secondId}`);
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
        var wsA, wsB, a = uuidv4(), b = uuidv4();
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
        it('delivers in order', async function (done) {
            var payloads = ['a', 'b', 'c', 'd', 'e', 'f'], received = 0;
            wsB.onmessage = event => {
                const message = JSON.parse(event.data);
                expect(message.data).toBe(payloads[received++]);
                if (received >= payloads.length) done();
            };
            for (const p of payloads) await sendMessage(p, b, a);
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
        const id1 = uuidv4();
        const id2 = uuidv4();
        afterEach(function () {
            if (pipe1) {
                pipe1.close();
                pipe1 = null;
            }
            if (pipe2) {
                pipe2.close();
                pipe2 = null;
            }
            if (connection1) {
                connection1.peer.close();
                connection1 = null;
            }
            if (connection2) {
                connection2.peer.close();
                connection2 = null;
            }
        });
        function testDataStreams(thunks, peerClass, done) {
            function run(done) {
                const setupLabel = peerClass.name + ' channel open';
                const pingLabel = peerClass.name + ' ping roundtrip';
                connection1 = new peerClass(pipe1, id1, id2);
                connection2 = new peerClass(pipe2, id2, id1);
                connection1.peer.onclose = _ => console.log(connection1.id, 'closed');
                connection2.peer.onclose = _ => console.log(connection1.id, 'closed');
                connection2.peer.ondatachannel = event => {
                    const channel2 = event.channel;
                    console.log('channel2 got data channel');
                    channel2.onerror = e => console.log('fixme channel2 error', e);
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
                    done();
                };
                channel1.onerror = e => console.log('fixme channel1 error', e);
            }
            return function (done) {
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
        it('event stream', testDataStreams([_ => new EventSource(`/messages?id=${id1}`),
                                            _ => new EventSource(`/messages?id=${id2}`)],
                                           EventSourceRTC));

    });
    describe('media stream signalling', function () {
        var connection1, connection2;
        var pipe1, pipe2;
        const id1 = uuidv4();
        const id2 = uuidv4();
        afterEach(function () {
            if (pipe1) {
                pipe1.close();
                pipe1 = null;
            }
            if (pipe2) {
                pipe2.close();
                pipe2 = null;
            }
            if (connection1) {
                connection1.peer.close();
                connection1 = null;
            }
            if (connection2) {
                connection2.peer.close();
                connection2 = null;
            }
        });
        function testDataStreams(thunks, peerClass, done) {
            function run(done) {
                if (!(('mediaDevices' in navigator) &&
                      ('getUserMedia' in navigator.mediaDevices))) {
                    return done();
                }
                navigator.mediaDevices
                    .getUserMedia({video: true, audio: true})
                    .then(stream => {
                        if (!stream) return fail('No media stream');
                        const setupLabel = peerClass.name + ' channel open';                        
                        const tracks = {};
                        var trackCount = 2;
                        connection1 = new peerClass(pipe1, id1, id2);
                        connection2 = new peerClass(pipe2, id2, id1);
                        connection1.peer.onclose = _ => console.log(connection1.id, 'closed');
                        connection2.peer.onclose = _ => console.log(connection1.id, 'closed');
                        connection2.peer.addEventListener('track', event => {
                            const track = event.track,
                                  trackId = track.id;
                            expect(track.id).toBe(tracks[track.kind]);
                            if (--trackCount <= 0) {
                                console.timeEnd(setupLabel);
                                done();
                            }
                        });
                        console.time(setupLabel);
                        stream.getTracks().forEach(track => {
                            tracks[track.kind] = track.id;
                            connection1.peer.addTrack(track, stream);
                        });
                    },
                          error => { console.log(error); done();});
            }
            return function (done) {
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
        it('event stream', testDataStreams([_ => new EventSource(`/messages?id=${id1}`),
                                            _ => new EventSource(`/messages?id=${id2}`)],
                                           EventSourceRTC));

    });
});
