'use strict';
const PORT = process.env.PORT || 8443;
const path = require('path');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');

process.title = "p2p-load-test";
const app = express();
const expressWs = require('express-ws')(app);
app.use(express.static('public'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));

/*
P2P Message Proxy
Every client connects with an id and can send typed events to any other id, through here.
The "obvious" way to do that is with WebSockets, e.g., client opens a new WebSocket for each
client it wants to send messages to, but that's not scalable for several reasons.
1. Browsers limit how many WebSockets can be opened, to about 200. We conceptually need a lot more,
   even for our initial tests. We could multiplex over a single socket, then the implementation ends
   up looking a lot like what's done below.
2. The Internet says that servers run into problems around 1000 open sockets per server instance,
   so we'll need some http/s/2 reverse-proxy support, such as NGINX. But once established, WebSocket
   is at the TCP level, and not handled by such proxies.
3. Support for WebSockets over cellular is dicey (and for good battery/network reasons), so we're
   likely to have to eventually use the Push API when it becomes supported, or carrier-specic pushes
   until then. At that point, it looks a lot like what's done below.
So...
I. Clients open new EventSource('/messages?id=whatever'), which is kept open and delivers a stream of
   event messages pushed by the server.
II. Clients can post individual messages to /message, specifying a to/from ids, message, and optional type.
   The server then delivers it to the appropriate event source (I).
   So, clients post to /message, and server pushes over the connection opened by the client hitting /messages.
III. In between, we multiplex at the server. Messages from any client to you appears only at your EventSource.
   A production environment will also need a message queue across server instances, which is not implemented
   in the following code, because we don't need it yet.
*/

const registrants = {};
function sendSSE(res, data, type = '') {
    // TODO: In production, we'll want send and keep track of message ids so that a reconnecting client can resync.
    if (type) res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    res.flushHeaders();
}
function heartbeatSSE(res, comment = '') {
    res.write(comment ? ':' + comment + '\n\n' : ':\n\n');
    res.flushHeaders();    
}
app.post('/message', function (req, res) {
    const clientPipe = registrants[req.body.to];
    if (!clientPipe) return routes['/404'](req, res);
    // Alas, the EventSource standard does not provide a 'scope' field with which the client
    // can direct the data to the right client-side target, so we have to embed that in data.
    const message = {from: req.body.from, data: req.body.data};
    sendSSE(clientPipe, message, req.body.type);
    res.end(); // TODO: When we do message ids, it would be nice to return that.
});

app.get('/messages', function (req, res) {
    const id = req.query.id;
    // SSE headers and http status to keep connection open
    // TODO: heartbeat
    // TODO: reject requests that don't accept this content-type.
    const headers = {
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache'
    };
    res.writeHead(200, headers);
    res.setTimeout(0); // Or we could heartbeat before the default 2 minutes.
    registrants[id] = res;

    req.on('close', () => {
        console.log(new Date(), 'SSE connection closed', id);
        delete registrants[id];
    });

    // In this application, we tell each new registrant about all existing ones.
    // TODO: decide whether to do this in production. Separate method?
    // Note that, for now, we do not broadcast new registrants to existing ones. No need.
    //sendSSE(res, Object.keys(registrants)); // FIXME: don't do while trying to debug, and don't do after we add id to registrants
    heartbeatSSE(res); // comment forces open event on other end
    
});

const wsRegistrants = {};
app.ws('/:id', function (ws, req) {
    const id = req.params.id;
    wsRegistrants[id] = ws;
    ws.on('message', function (data) {
        const message = JSON.parse(data);
        const destination = wsRegistrants[message.to];
        if (id !== message.from) {
            console.log(new Date(), 'WebSocket wrong origin', id, 'claimed', message.from);
            return ws.terminate();
        }
        console.log(new Date(), 'message', message.type || 'data', (destination ? 'ok' : 'missing'));
        if (!destination) return ws.terminate(); // Just close the connection, just as if client were directly connected to the destination.
        destination.send(data);
    });
    ws.on('close', function () {
        console.log(new Date(), 'WebSocket connection closed', id);
        delete wsRegistrants[id];
    });
});

app.listen(PORT);
