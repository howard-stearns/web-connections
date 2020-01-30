'use strict';
const PORT = process.env.PORT || 8443;
const path = require('path');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');

process.title = "p2p-load-test";
const app = express();
const expressWs = require('express-ws')(app);
app.set('trust proxy', true);
app.use(express.static('public'));
function rawBodySaver(req, res, buf, encoding) {
  if (buf && buf.length) {
    req.rawBody = buf.toString(encoding || 'utf8');
  }
}
app.use(bodyParser.json({verify: rawBodySaver}));
app.use(bodyParser.urlencoded({extended: true}));

/*
P2P Message Proxy
Every client connects with an id and can send typed events to any other id, through here.
I. Clients open new EventSource('/messages/someId'), which is kept open and delivers a stream of
   event messages pushed by the server.
II. Clients can post individual messages to /message, specifying a to/from ids, message, and optional type.
   The server then delivers it to the appropriate event source (I).
   So, clients post to /message, and server pushes over a connection opened by the client hitting /messages.
III. In between, we multiplex at the server. Messages from any client to you appears only at your EventSource.
   A production environment will also need a message queue across server instances, which is not implemented
   in the following code, because we don't need it yet.
*/

const registrants = {};
function sendSSE(res, data, type = '') {
    // TODO: In production, we'll want send and keep track of message ids so that a reconnecting client can resync.
    if (type) res.write(`event: ${type}\n`); // Must be first if present
    const messageId = res.sseMessageId++;
    res.write(`data: ${data}\n`);
    res.write(`id: ${messageId}\n\n`); // Conventionally last, so that count isn't incremented until data is sent.
    res.flushHeaders();
    return messageId;
}
function heartbeatSSE(res, comment = '') {
    res.write(comment ? ':' + comment + '\n\n' : ':\n\n');
    res.flushHeaders();    
}
app.post('/message', function (req, res) {
    const clientPipe = registrants[req.body.to];
    if (!clientPipe) return res.status(404).send("Not found");
    // Alas, the EventSource standard does not provide a 'scope' field with which the client
    // can direct the data to the right client-side target, so we have to embed that in data.
    console.log(new Date(), `sse message ${clientPipe.sseMessageId} ${JSON.stringify(req.body.data).slice(0, 100)}...`);
    const messageId = sendSSE(clientPipe, req.rawBody, req.body.type);
    res.end(JSON.stringify({id: messageId}));
});

app.get('/messages/:id', function (req, res) {
    const id = req.params.id;
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
    res.sseMessageId = 0;

    req.on('close', () => {
        console.log(new Date(), 'SSE connection closed', id);
        delete registrants[id];
    });

    // In this application, we tell each new registrant about all existing ones.
    // TODO: decide whether to do this in production. Separate method?
    // Note that, for now, we do not broadcast new registrants to existing ones. No need.
    sendSSE(res, JSON.stringify({ip: req.ip, peers: Object.keys(registrants)}), 'listing');
    //heartbeatSSE(res); // comment forces open event on other end
    registrants[id] = res;
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
        console.log(new Date(), 'ws message', message.type || 'data', (destination ? 'ok' : 'missing'));
        if (!destination) return ws.terminate(); // Just close the connection, just as if client were directly connected to the destination.
        if (destination.readyState !== ws.OPEN) {
            destination.terminate();
            ws.terminate();
            return;
        }
        destination.send(data);
    });
    ws.on('close', function () {
        console.log(new Date(), 'WebSocket connection closed', id);
        delete wsRegistrants[id];
    });
});

app.listen(PORT);
