'use strict';
const PORT = process.env.PORT || 8443;
const path = require('path');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const https = require('https'); // for forwarding to hifi-telemetric
const morgan = require('morgan')
const pseudo = require('./pseudo-request');
const pkg = require('./package.json');
const redis = process.env.REDIS_URL && require('redis').createClient(process.env.REDIS_URL);

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

const CREDITS_PER_MS = 1.667;
app.post('/upload', function (req, res) {
    //if ("FIXME skip") return res.end("{}");

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
            var code = 200;
            if (redis) {
                // We have a retest button, and of course browsers have reload. So no point in prohibiting
                // uploads that are "too soon". For a dead upload without actually being online, they'll only
                // get 2 credits anyway (at today's rate).
                const id = req.body.id,
                      registration = registrants[id],
                      equivalentStartTimeMs = registration && registration.startTime;
                if (!equivalentStartTimeMs) {
                    // Shouldn't happen, but if it does, we handled the data upload, but we can't
                    // credit the user because they're not connected/available. Page should be reloaded.
                    code = 205; 
                } else {
                    const sinceStart = Date.now() - equivalentStartTimeMs;
                    const accrued = sinceStart * CREDITS_PER_MS;
                    redis.hset(id, 'credits', Math.round(accrued), (error) => error && console.error(error));
                }
            }
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
function sendSSE(res, string, type = '') {
    // TODO: In production, we'll want send and keep track of message ids so that a reconnecting client can resync.
    if (type) res.write(`event: ${type}\n`); // Must be first if present
    const messageId = res.sseMessageId++;
    if (string) res.write(`data: ${string}\n`);
    res.write(`id: ${messageId}\n\n`); // Conventionally last, so that count isn't incremented until data is sent.
    res.flushHeaders();
    return messageId;
}
const HEARTBEAT_IS_PING_PONG = true;
function heartbeatSSE(res, comment = '') { // (posibly empty) comment forces open event on other end
    if (HEARTBEAT_IS_PING_PONG) {
        if (res.gotPong === false) { // undefined doesn't count
            console.info(`${new Date()}: No pong from ${res.guid} (${res.gotPong}), closing.`);
            return // FIXME! closeRegistrant(res); // We didn't get a pong from last ping. Kill 'em.
        }
        res.gotPong = false;
        sendSSE(res, JSON.stringify({type:'ping', to:res.guid, from:res.guid, data:HEROKU_PROXY_TIMEOUT_MS}), 'ping');
    } else {
        res.write(comment ? ':' + comment + '\n\n' : ':\n\n');
        res.flushHeaders();
    }
}
function listingData(req) {
    return {
        ip: req.ip,
        version: pkg.version,
        peers: Object.keys(registrants).filter(guid => guid.length === 36) // Filter in case we have "temp" guids for dual roles
    };
}
app.post('/message', function (req, res) {
    const clientPipe = registrants[req.body.to];
    var messageId = 0;
    if (!clientPipe) return res.status(404).send("Not found");
    if (req.body.type === 'listing') { // Hack special case
        req.body.data = listingData(req);
        req.rawBody = JSON.stringify(req.body);
    }
    req.originalUrl += `?from=${req.body.from}&to=${req.body.to}`;
    if (req.body.type) req.originalUrl += `&type=${req.body.type}`;
    if (req.body.type === 'pong') { // Another special case
        if (req.body.from !== req.body.to) return res.status(403).send("Forbidden from ponging someone else.");
        clientPipe.gotPong = true; // And don't sendSSE
    } else {
        messageId = sendSSE(clientPipe, req.rawBody, req.body.type);
    }
    res.writeHead(200, {"Content-Type": "application/json;charset=UTF-8"});
    res.end(JSON.stringify({id: messageId}));
});

var acceptingRegistrants = true; // Server.close doesn't shut out EventSource reconnects.
const SHUTDOWN_RETRY_TIMEOUT_MS = 30 * 1000;
function closeRegistrant(res, retryTimeout) {
    clearInterval(res.heartbeat);
    delete registrants[res.guid];
    res.originalRequest.method = 'DELETE'; // For logging purposes.
    if (retryTimeout) res.write(`retry: ${retryTimeout}\n\n`);
    res.end();
}

app.get('/messages/:id', function (req, res) {
    if (!acceptingRegistrants) return closeRegistrant(res, SHUTDOWN_RETRY_TIMEOUT_MS);
    const id = req.params.id;
    // TODO: reject requests that don't accept this content-type.
    const headers = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no'
    };
    if (req.httpVersion !== '2.0') {
        res.setHeader('Connection', 'keep-alive');
    }
    res.on('error', (err, ...args) => {
        console.error('captured sse error', err, ...args);
        closeRegistrant(res);
    });
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    res.setTimeout(0); // Or we could heartbeat before the default 2 minutes.
    res.writeHead(200, headers);
    res.sseMessageId = 0;
    res.guid = id;
    res.heartbeat = setInterval(_ => heartbeatSSE(res), HEROKU_PROXY_TIMEOUT_MS);
    res.originalRequest = req; // For logging when it closes.
    // We don't keep the time connected in redis, because we're keeping a socket with this ephemeral data anyway.
    // When the socket (entry in registrants) goes away, there's no need to reset that in a db.
    // Separately, the startTime is an equivalent startTime to make computation of new credits simple on /upload.
    if (redis) {
        redis.hget(id, 'credits', function (error, data) {
            if (error) {
                console.error(error);
            } else {
                const credits = parseInt(data || "0", 10);
                const now = Date.now();
                res.startTime = now - Math.round(credits / CREDITS_PER_MS);
            }
        });
    }
    pseudo.info(req);

    req.on('close', _ => {
        closeRegistrant(res)
    });

    // In this application, we tell each new registrant about all existing ones.
    // TODO: decide whether to do this in production. Separate method?
    // Note that, for now, we do not broadcast new registrants to existing ones. No need.
    sendSSE(res, JSON.stringify({from: id, to: id, data: listingData(req), type: 'listing'}), 'listing');
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

app.get('/stats/:id', function (req, res) {
    const id = req.params.id;
    res.writeHead(200, {"Content-Type": "application/json;charset=UTF-8"});
    if (!redis) return res.end("{}");
    // There's a temptation to avoid a second hit of redis and to instead get the equivalent
    // start time from resistrants. But this is more robust and flexible. E.g., this is independent
    // of whether/when the browser inits its SSE connection.
    redis.hget(id, 'credits', function (error, data) {
        if (error) return res.end(JSON.stringify({error: error}));
        res.end(JSON.stringify({
            credits: parseInt(data || '0', 10),
            rate: CREDITS_PER_MS
        }));
    });
});

const server = app.listen(PORT);

server.on('clientError', (err, socket) => {
    console.log('captured clientError', err);
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.on('error', (err, ...args) => {
    console.error('FIXME captured server error', err, ...args);
});

var turn = {stop: _ => null};
/* // Run a TURN server. Well, not on heroku as we get one port per app
const Turn = require('node-turn');
turn = new Turn({
    authMech: 'long-term', //'none',
    credentials: {test: 'winning'},
    debugLevel: 'ALL',
    listeningIps: ['127.0.0.1'],
    relayIps: ['127.0.0.1']
});
turn.start();
*/

var browser = {close: _ => Promise.resolve()};
/* // Run a client on the server so that there's always someone to play with. Well, not yet.
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
    turn.stop();
    Object.values(registrants).forEach(res => closeRegistrant(res, SHUTDOWN_RETRY_TIMEOUT_MS));
    browser.close();
    if (redis) redis.quit()
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
