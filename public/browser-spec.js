/*global describe, it, require*/
"use strict";

function uuidv4() { // Not crypto strong, but good enough for prototype.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

describe('browser side', function () {
    beforeAll(function (done) { // Give puppeteer a chance to hook into reporters.
        setTimeout(_ => done(), 1000);
    });
    describe('event source', function () {
        var eventSource, eventHandler;
        var target='target', source='source', type='foo';        
        beforeAll(function (done) { // Wait for open before starting tests.
            eventSource = new EventSource(`/messages?id=${target}`);
            eventSource.onopen = done;
        });
        afterEach(function () {
            eventSource.onmessage = null;
        });
        function sendMessage(payload, type = '', to = target, from = source) {
            return fetch(`/message?to=${to}&from=${from}&data=${payload}${type ? `&type=${type}` : ''}`)
                .then(response => expect(response.status).toBe(200));
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
            const second = new EventSource('/messages?id=second');
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
                sendMessage('for1', null, target, 'second')
                sendMessage('for2', null, 'second', target)
            };
        });
    });
    describe('web socket', function () {
        var wsA, wsB
        beforeAll(function (done) { // Wait for open before starting tests.
            wsA = new WebSocket('ws://localhost:8443/A');
            wsA.onopen = _ => {
                wsB = new WebSocket('ws://localhost:8443/B');
                wsB.onopen = done;
            };
        });
        afterEach(function () {
            wsA.onmessage = wsB.onmessage = null;
        });
        function sendMessage(payload, to, from, type = '') {
            const data = {from: from, to: to, data: payload};
            if (type) data.type = type;
            ((from === 'A') ? wsA : wsB).send(JSON.stringify(data));
        }
        it('loops back messages', function (done) {
            const payload = 'payload1';
            wsB.onmessage = event => {
                const message = JSON.parse(event.data);
                expect(message.data).toBe(payload);
                expect(message.from).toBe('A');
                done();
            };
            sendMessage(payload, 'B', 'A');
        });
        it('delivers in order', async function (done) {
            var payloads = ['a', 'b', 'c', 'd', 'e', 'f'], received = 0;
            wsB.onmessage = event => {
                const message = JSON.parse(event.data);
                expect(message.data).toBe(payloads[received++]);
                if (received >= payloads.length) done();
            };
            for (const p of payloads) await sendMessage(p, 'B', 'A');
        });
        it('distinguishes by id', function (done) {
            Promise.all([
                new Promise(resolve => {
                    wsB.onmessage = event => {
                        const message = JSON.parse(event.data);
                        expect(message.data).toBe('for2');
                        expect(message.type).toBe('y');
                        expect(message.from).toBe('A');
                        resolve();
                    };
                }),
                new Promise(resolve => {
                    wsA.onmessage = event => {
                        const message = JSON.parse(event.data);
                        expect(message.data).toBe('for1');
                        expect(message.type).toBe('x');
                        expect(message.from).toBe('B');
                        resolve();
                    };
                })
            ]).then(done);
            sendMessage('for1', 'A', 'B', 'x');
            sendMessage('for2', 'B', 'A', 'y');
        });
    });
    
    describe('signalling', function () {
        // Base class to be completed by super that handles tramission of signals.
        // Given that, this will negotiate when adding a track or data channel, and renegotiate as needed.
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
                const timerLabel = peerClass.name + ' channel open';
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
                console.time(timerLabel);
                const channel1 = connection1.peer.createDataChannel('1:2', null);
                channel1.onopen = _ => {
                    console.timeEnd(timerLabel);
                    channel1.send('ping');
                };
                channel1.onmessage = event => {
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
        const protocol = (location.protocol === 'http:') ? 'ws:' : 'wss:';
        const wsSite = protocol + "//" + location.host;
        it('loopback', testDataStreams(null, LoopbackRTC));
        it('web socket', testDataStreams([_ => new WebSocket(`${wsSite}/${id1}`),
                                          _ => new WebSocket(`${wsSite}/${id2}`)],
                                         WebSocketRTC));
        it('event stream', testDataStreams([_ => new EventSource(`/messages?id=${id1}`),
                                            _ => new EventSource(`/messages?id=${id2}`)],
                                           EventSourceRTC));

    });
});
