'use strict';
const PORT = process.env.PORT || 8443;
const http = require('http');
const path = require('path');
const fs = require('fs');
const url = require('url');
const WebSocket = require('ws');


process.title = "p2p-load-test";

// The node-static package does this better, but we don't need that here.
const mime = {
    ".htm": "text/html",
    ".html": "text/html",
    ".js": "application/javascript"
};
function serveStatic(pathname, req, res) {
    fs.readFile(__dirname + "/public" + pathname, function (err, data) {
        if (err) return routes['/404'](req, res);
        res.writeHead(200, {'Content-Type': mime[path.extname(pathname)] || 'text/plain'});
        res.end(data);
    })
}

// The express framework has much more general ways to do this, but we don't need that either.
const routes = {};
function router(req, res) {
    const parsed = req.parsedUrl = url.parse(req.url, true); // Set in req to make it vailable to handlers.
    const pathname = parsed.pathname,
          handler = routes[pathname];
    console.log(new Date(), pathname, (handler ? 'code' : 'static'));
    if (handler) return handler(req, res);
    serveStatic(pathname, req, res);
}


routes['/404'] = function (req, res) {
    console.log(req.url, 'not found');
    res.writeHead(404, {'Content-Type': 'text/plain'});
    res.end("Not found: " + req.url);
};
routes['/'] = function (req, res) {
    serveStatic('/index.html', req, res);
};


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
routes['/message'] = function (req, res) {
    // TODO: Handle posted form encoding instead of just query params
    const query = req.parsedUrl.query;
    const clientPipe = registrants[query.to];
    if (!clientPipe) return routes['/404'](req, res);
    // Alas, the EventSource standard does not provide a 'scope' field with which the client
    // can direct the data to the right client-side target, so we have to embed that in data.
    const message = {from: query.from, data: query.data};
    sendSSE(clientPipe, message, query.type);
    res.end(); // TODO: When we do message ids, it would be nice to return that.
};

routes['/messages'] = function (req, res) {
    const id = req.parsedUrl.query.id;
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
    
}

const server = http.createServer(router);

const wss = new WebSocket.Server({ server });
const wsRegistrants = {};
wss.on('connection', function (ws, req) {
    const parsed = url.parse(req.url);
    const id = parsed.pathname.slice(1);
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

server.listen(PORT);
