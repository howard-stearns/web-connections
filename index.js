'use strict';
const PORT = process.env.PORT || 8443;
const path = require('path');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const https = require('https'); // for forwarding to hifi-telemetric
const morgan = require('morgan')
const pseudo = require('./pseudo-request');

process.title = "p2p-load-test";
const app = express();
const expressWs = require('express-ws')(app);
app.set('trust proxy', true);
const logger = morgan('common');
pseudo.configure(logger);

app.use(logger);
app.use(express.static('public'));
function rawBodySaver(req, res, buf, encoding) {
  if (buf && buf.length) {
    req.rawBody = buf.toString(encoding || 'utf8');
  }
}
app.use(bodyParser.json({verify: rawBodySaver}));
app.use(bodyParser.urlencoded({extended: true}));

app.post('/upload', function (req, res) {
    const forward = https.request({
        hostname: "hifi-telemetric.herokuapp.com",
        path: "/gimmedata",
        method: 'post',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': req.rawBody.length
        }
    }, forwardResponse => {
        forwardResponse.on('data', d => {
            const data = d.toString();
            // Good form to send content-type. E.g., because the client is using XMLHttpRequest
            // for MSIE compatability, Firefox will spit out a noisy error about the response not
            // being good XML (unless we declare the content-type).
            res.writeHead(200, {"Content-Type": "application/json;charset=UTF-8"});
            res.end(data);
        });
    });
    forward.on('error', e => console.error('forward', e));
    forward.end(req.rawBody);
});

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
function heartbeatSSE(res, comment = '') { // (posibly empty) comment forces open event on other end
    res.write(comment ? ':' + comment + '\n\n' : ':\n\n');
    res.flushHeaders();    
}
function listingData(req) {
    return JSON.stringify({ip: req.ip, peers: Object.keys(registrants)});
}
app.post('/message', function (req, res) {
    const clientPipe = registrants[req.body.to];
    if (!clientPipe) return res.status(404).send("Not found");
    if (req.body.type === 'listing') { // Hack special case
        req.rawBody = listingData(req);
    }
    req.originalUrl += `?from=${req.body.from}&to=${req.body.to}`;
    if (req.body.type) req.originalUrl += `&type=${req.body.type}`;
    const messageId = sendSSE(clientPipe, req.rawBody, req.body.type);
    res.writeHead(200, {"Content-Type": "application/json;charset=UTF-8"});
    res.end(JSON.stringify({id: messageId}));
});

function closeRegistrant(res) {
    clearInterval(res.heartbeat);
    delete registrants[res.guid];
    res.originalRequest.method = 'DELETE'; // For logging purposes.
    res.end();
}

var acceptingRegistrants = true; // Server.close doesn't shut out EventSource reconnects.
app.get('/messages/:id', function (req, res) {
    if (!acceptingRegistrants) return res.status(503).send("Not Available");
    const id = req.params.id;
    // TODO: reject requests that don't accept this content-type.
    const headers = {
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache'
    };
    res.writeHead(200, headers);
    res.setTimeout(0); // Or we could heartbeat before the default 2 minutes.
    res.sseMessageId = 0;
    pseudo.info(req);

    req.on('close', _ => closeRegistrant(res));

    // In this application, we tell each new registrant about all existing ones.
    // TODO: decide whether to do this in production. Separate method?
    // Note that, for now, we do not broadcast new registrants to existing ones. No need.
    sendSSE(res, listingData(req), 'listing');
    res.guid = id;
    res.heartbeat = setInterval(_ => heartbeatSSE(res), HEROKU_PROXY_TIMEOUT_MS);
    res.originalRequest = req; // For logging when it closes.
    registrants[id] = res;
});
const HEROKU_PROXY_TIMEOUT_MS = 10 * 1000;

const wsRegistrants = {};
app.ws('/:id', function (ws, req) {
    const id = req.params.id;
    wsRegistrants[id] = ws;
    pseudo.info(req);
    ws.on('message', function (data) {
        pseudo.info({url: `/${id}/.websocket`, method: 'PUT'});
        const message = JSON.parse(data);
        const destination = wsRegistrants[message.to];
        if (id !== message.from) {
            console.error(new Date(), 'WebSocket wrong origin', id, 'claimed', message.from);
            return ws.terminate();
        }
        if (!destination) return ws.terminate(); // Just close the connection, just as if client were directly connected to the destination.
        if (destination.readyState !== ws.OPEN) {
            destination.terminate();
            ws.terminate();
            return;
        }
        destination.send(data);
    });
    ws.on('close', function () {
        delete wsRegistrants[id];
        req.method = 'DELETE'; // For logging purposes
        pseudo.info(req);
    });
});

const server = app.listen(PORT);
var browser = {close: _ => Promise.resolve()};
/*
const puppeteer = require('puppeteer');
async function client() {
    browser = await puppeteer.launch({headless: true});
        const page = await browser.newPage();
    await page.goto(`http://localhost:${PORT}/`);
    page.on('console', msg => console.info('client:', msg.text()));
    await page.evaluate(() => window.isHeadless = true);
}
client();
*/

function shutdown(signal) {
    console.log('Received', signal);
    acceptingRegistrants = false
    server.close(_ => console.log('Closed server'));
    Object.values(registrants).forEach(res => closeRegistrant(res));
    browser.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
