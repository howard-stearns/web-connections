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
const uuidv4  = require('uuid/v4');
const { uniqueNamesGenerator, adjectives, colors, animals } = require('unique-names-generator');
const tfjs = require('@tensorflow/tfjs-node'); // Speeds up tensorflow (for face-api)
const faceapi = require('face-api.js');
const { Canvas, Image, ImageData, loadImage } = require('canvas');
const { lock } = require('ki1r0y.lock');

process.title = "p2p-load-test";
const app = express();
const expressWs = require('express-ws')(app);
app.set('trust proxy', true);
const logger = morgan('common');
pseudo.configure(logger);
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });
const namesConfig = {
    dictionaries: [adjectives, colors, animals],
    style: 'capitol'
};

if (redis) redis.on('error', console.error);

function promiseLock(key, thunk) {
    // A wrapper around lock, but:
    // - thunk must return a promise.
    // - handles the calling of unlock automatically, when thunk resolves.
    // - itself returns a promise that resolves to whatever thunk resolves to
    return new Promise((resolve, reject) => {
        lock(key, unlock => {
            thunk().then(result => {
                unlock();
                resolve(result);
            }, rejection => {
                unlock();
                reject(rejection);
            });
        });
    });
}

// Low-level wrapers around the db.
const dbdir = path.join(__dirname, 'db');
fs.mkdir(dbdir, e => e && (e.code !== 'EEXIST') && console.error(e));
function dbPath(key) { return path.join(dbdir, key); }
function makeResolver(resolve, reject, datafier) {
    return (e, data) => {
        if (e && (e.code !== 'ENOENT')) return reject(e);
        resolve(!e && datafier && datafier(data));
    };
}
const fakeDb = {};
function fakeDbSet(key, val) {
    fakeDb[key] = val;
    return new Promise((resolve, reject) => fs.writeFile(dbPath(key), JSON.stringify(val), makeResolver(resolve, reject)));
}
function fakeDbGet(key) {
    const cached = fakeDb[key];
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve, reject) => fs.readFile(dbPath(key), makeResolver(resolve, reject, JSON.parse)));
}
function fakeDbDelete(key) {
    delete fakeDb[key];
    return new Promise((resolve, reject) => fs.unlink(dbPath(key), makeResolver(resolve, reject)));
}

function getDbString(id) { return fakeDbGet(id); }
function setDbString(id, value) { return fakeDbSet(id, value); }
function removeDbString(id) { return fakeDbDelete(id); }

async function addToDbSet(set, element) {
    var ids = await fakeDbGet(set);
    if (!ids) ids = [];
    if (!ids.includes(element)) {
        ids.push(element);
        await fakeDbSet(set, ids);
    }
}
async function removeFromDbSet(set, element) {
    var ids = await fakeDbGet(set);
    if (!ids) ids = [];
    ids.splice(ids.indexOf(element), 1);
    await fakeDbSet(set, ids);
}
async function iterDbSet(set, func) { // wait for func(element) of each member of the set (unless error along the way)
    var ids = await fakeDbGet(set);
    if (!ids) return;
    for (const id of ids) {
        await func(id);
    }
}

async function addToDbOrderedSet(set, element) {
    var ids = await fakeDbGet(set);
    if (!ids) ids = [];
    if (!ids.includes(element)) {
        ids.push(element);
        await fakeDbSet(set, ids);
    }
}
function getDbOrderedSet(set) {
    return fakeDbGet(set);
}
function removeDbOrderedSet(set) {
    return fakeDbDelete(set);
}

function subListKey(uid, subkey) {
    return `${uid}:${subkey}List`;
}
function isSubList(uid, value) {
    if (typeof value !== 'string') return false;
    if (!value.startsWith(uid)) return false;
    return value.endsWith('List');
}
async function getDbHash(uid) {
    const raw = await fakeDbGet(uid);
    if (!raw) return Promise.resolve(); // NOT an empty hash!
    const hash = Object.assign({}, raw);
    for (const [key, val] of Object.entries(hash)) {
        if (isSubList(uid, val)) {
            hash[key] = await getDbOrderedSet(val);
        }
    }
    return hash
}
async function removeDbHash(uid) {
    const raw = await fakeDbGet(uid);
    if (!raw) return;
    for (const [key, val] of Object.entries(raw)) {
        if (isSubList(uid, val)) await removeDbOrderedSet(val);
    }
    await fakeDbDelete(uid);
}
async function setDbHash(uid, hash) {
    const raw = Object.assign({}, hash);
    for (const [key, val] of Object.entries(raw)) {
        if (!Array.isArray(val)) continue;
        const subkey = subListKey(uid, key);
        val.forEach(async element => { await addToDbOrderedSet(subkey, element); });
        raw[key] = subkey;
    }
    fakeDbSet(uid, raw);
}

// Higher level operations on our specific db
// FIXME: there are opportunities for optimization here:
// - where we get whole objects to operate on, and then store the whole object;
// - where we read parts of a compound object to find out what type of operation to do.
/*
In database:
userid => {displayName, credits, strength, passwordHash, meanDescriptor, emails, faces, descriptor, keypairs}
email1 => userid; email2 => userid; ...
*/
function trimUser(user) { // What gets returned to user. FIXME: determine the minimum needed.
    const cred = Object.assign({}, user);
    cred.faces = cred.faces.slice(-1);
    if (!cred.strength) cred.strength = 1;
    return updateCredits(user);
}

function listify(entry, existingKey, existing) {
    var list = existing[existingKey];
    if (!list) {
        list = existing[existingKey] = [];
    }
    if (list.includes(entry)) return;
    list.push(entry);
}
function makeTransformer(existingKey) {
    return (entry, existing) => listify(entry, existingKey, existing);
}
const transformers = {
    email: makeTransformer('emails'),
    oldEmail: _ => {},
    face: makeTransformer('faces'),
    credits: (entry, existing) => { existing.credits = (existing.credits || 1) + entry; }, // FIXME!!
    energy: (entry, existing) => { existing.credits = entry; }
};

function passwordFail(user, options) {
    // Subtle: 'auth' in options is true if password is supplied at all, even as undefined.
    if (('auth' in options) && (user.password !== options.auth)) {
        // FIXME message?
        throw new Error("Password does not match.");
    }
}
function elide(string, nchars = 5) {
    if (string.length <= nchars) return string;
    return string.slice(0, nchars) + '...';
}
function elideParts(email, separator = '@', nchars = 5) {
    return email.split(separator).map(s => elide(s, nchars)).join(separator);
}

// Descriptors, and lists of descriptors, are stores in the database as json (to avoid complications of nexted values).
async function matchesOtherFaceFail(userid, options) {
    if (!options.descriptor) return null;
    await iterDbSet('ids', uid => {
        return getDbHash(uid).then(user => {
            if (!user || !user.meanDescriptor || uid === userid) return;
            const otherDescriptor = JSON.parse(user.meanDescriptor);
            const difference = descriptorDistance(options.descriptor, otherDescriptor);
            const id = user.emails[user.emails.length - 1];
            pseudo.info({url: `/intraUser?distance=${Math.round(difference * 100)}&id=${id}`});
            // FIXME message?
            if (difference < 0.50) {
                throw new Error(`Your face is already registered under another email. ${difference.toFixed(2)} from ${elideParts(id)}.`);
            }
        });
    });
}
function mismatchedFaceFail(user, options) {
    // Fails if given an empty options.descriptor. OK if not asked to check descriptor.
    if (!('descriptor' in options)) return;
    // FIXME message?
    if (!options.descriptor) return Promise.reject(new Error("Security selfie is not clear."));
    if (user.meanDescriptor) {
        const mean = JSON.parse(user.meanDescriptor);
        const meanDifference = descriptorDistance(mean, options.descriptor);
        pseudo.info({url: `/interUser?distance=${Math.round(meanDifference * 100)}`});
        // FIXME message?
        if (meanDifference > 0.52) throw new Error(`Your face is wrong. ${meanDifference.toFixed(2)} from previous registration. And you're old.`);
    }
}
function updateMeanDescriptor(user, options) {
    if (!options.descriptor) return;
    const mean = Array(128).fill(0);
    const descriptors = user.descriptors ? JSON.parse(user.descriptors) : [];
    descriptors.push(options.descriptor)
    descriptors.forEach(d => d.forEach((v, i) => mean[i] += v));
    mean.forEach((v, i) => mean[i] /= descriptors.length);
    user.meanDescriptor = JSON.stringify(mean);
    user.descriptors = JSON.stringify(descriptors);
}

// Only the top level operations get locks, on email, and for get/set also on userid. (Nothing nested.)
async function setUser(data, options) {
    const emailPointersToUpdate = [];
    const emailKey = data.oldEmail || data.email;
    var userid = await getDbString(emailKey);
    if (!userid) {  // Add pointer from email.
        userid = uuidv4();
        emailPointersToUpdate.push(emailKey);
    }
    const locks = [userid, emailKey];
    if (data.oldEmail && data.oldEmail !== data.email) locks.push(data.email);
    return promiseLock(locks, async _ => {
        var creditChange = 0;
        if (data.oldEmail && data.email && !await getDbString(data.email)) { // Add additonal pointer if email changed.
            emailPointersToUpdate.push(data.email);
        }
        var user = await getDbHash(userid);
        if (user) {
            await passwordFail(user, options);
            await mismatchedFaceFail(user, options);
            if (user.displayName !== data.displayName) creditChange = Math.max(-user.credits, -10);
        } else {
            await matchesOtherFaceFail(userid, options);
            user = {};
        }
        // Can't be done before security checks, else people could steal addresses.
        await addToDbSet('ids', userid);
        await Promise.all(emailPointersToUpdate.map(key => setDbString(key, userid)));
        updateMeanDescriptor(user, options);
        updateCredits(user);
        user.credits += creditChange;
        user.updated = Date.now();
        Object.keys(data).forEach(key => {
            const f = transformers[key] || ((entry, existing) => existing[key] = entry);
            f(data[key], user);
        });
        await setDbHash(userid, user);
        // Return whole user so callers can update. (Future uses might make optional.)
        return user;
    });
}
function getUser(email, options) {
    return getDbString(email).then(userid => {
        if (!userid) return Promise.reject(new Error(`No such email: ${email}.`));
        return promiseLock([email, userid], _ => {
            return getDbHash(userid).then(async user => {
                if (!user) throw new Error(`No user for email: ${email}.`);
                passwordFail(user, options)
                return user;
            });
        });
    });
}
function deleteUser(email, options) {
    return getUser(email, options)
        .then(user => promiseLock(email, _ => {
            return getDbString(email).then(userid => {
                return Promise.all(user.emails.map(id => removeDbString(id)))
                    .then(_ => removeDbHash(userid))
                    .then(_ => removeFromDbSet('ids', userid))
                    .then(_ => ({}));
            });
        }));
}


app.use(logger);
app.use(express.static('public'));
function rawBodySaver(req, res, buf, encoding) {
  if (buf && buf.length) {
    req.rawBody = buf.toString(encoding || 'utf8');
  }
}
app.use(bodyParser.json({verify: rawBodySaver, limit: '50mb'}));
app.use(bodyParser.urlencoded({extended: true}));

function jsonHead(res) {
    res.writeHead(200, {"Content-Type": "application/json;charset=UTF-8"});
}

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
            jsonHead(res);
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
            return closeRegistrant(res); // We didn't get a pong from last ping. Kill 'em.
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
    jsonHead(res);
    res.end(JSON.stringify({id: messageId}));
});

const FACE_CUTOFF = 0.5;
function descriptorDistance(a, b) {
    var sum = 0;
    for (let i = 0; i < 128; i++) {
        let difference = a[i] - b[i];
        sum += difference * difference;
    }
    return Math.sqrt(sum);
}
app.post('/submitFace', function (req, res) {
    const category = 'faceTest0';
    function check(error) {
        if (!error) return;
        res.status(500).send(error.message);
        return true;
    }
    function compare(faces) {
        const matches = [];
        // Compute distance for each face
        faces.forEach(({descriptor, image}) => {
            matches.push({
                distance: descriptorDistance(req.body.descriptor, descriptor),
                image
            });
        });
        // Sort and find where to cut off.
        matches.sort((a, b) => Math.sign(a.distance - b.distance)); // lowest score first.
        var index = matches.findIndex(m => m.distance > 0.5);
        if (index < 0) index = matches.length;
        // Give answer.
        const results = matches.slice(0, 1 + index);
        jsonHead(res);
        res.end(JSON.stringify(results));
    }
    redis.rpush(category, req.rawBody, function (error, data) {
        if (check(error)) return;
        redis.lrange(category, 0, -1, function (error, data) {
            if (check(error)) return;
            compare(data.map(JSON.parse));
        });
    });
});

const models = Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromDisk('public/models'),
    faceapi.nets.faceLandmark68Net.loadFromDisk('public/models'),
    //faceapi.nets.faceLandmark68TinyNet.loadFromDisk('public/models'),
    faceapi.nets.faceRecognitionNet.loadFromDisk('public/models')
    //faceapi.nets.ageGenderNet.loadFromDisk('public/models')
]);

async function computeDescriptor(url) {
    const start = Date.now();
    await models;
    const captured = await loadImage(url);
    const final = await faceapi.detectSingleFace(captured)
          .withFaceLandmarks()
          .withFaceDescriptor();
    if (!final) {
        pseudo.info({url: `/failedComputeDescriptor?bytes=${url.length}`});
        // FIXME message?
        return Promise.reject(new Error("Security selfie is not clear."));
    }
    return [...final.descriptor]; // spread to a normal array
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const STIPEND_PER_DAY = 60;
const DECAY_PER_DAY = -0.5;
const DECAY_COMPOUNDINGS_PER_DAY = 1;
function computeCreditsOnInterval(principle, ms) {
    const t = ms / MILLISECONDS_PER_DAY;
    const rateAtCompounding = DECAY_PER_DAY / DECAY_COMPOUNDINGS_PER_DAY; // r/n in financial formulas
    const nCompoundings = DECAY_COMPOUNDINGS_PER_DAY * t;                // n*t in financial formulas
    const compoundGrowth = Math.pow(1 + rateAtCompounding, nCompoundings); // (1 + r/n)^(nt)
    const compoundInterestForPrinciple = principle * compoundGrowth;
    const futureValueOfASeries = STIPEND_PER_DAY * (compoundGrowth - 1) / rateAtCompounding;
    return compoundInterestForPrinciple + futureValueOfASeries;
}

// FIXME NOT USED YET: const MINIMUM_OFFLINE_TIME = 20 * 1000; // /reportEnergy is every 15 seconds.
// Pending credits (purchases, stipend, and decay) are only updated when the user has been offline.
function updateCredits(user) {
    const now = Date.now();
    if (!('credits' in user)) {
        cred.credits = STIPEND_PER_DAY;
        cred.updated = now;
    }
    const elapsed = now - user.creditsUpdated;
    const principle = ('credits' in user) ? user.credits : 60;
    // FIXME: If you buy credits and those are not applied until you are offline, or if you can by while
    // offline through another interface, then we need to to divide elapsed into 1+ nPurchases, and compute
    // compoundCreditsOnInterval with the previous principle (including purchases) and the elapsed
    // for that principle to the next.
    if (elapsed > 100) user.credits = computeCreditsOnInterval(principle, elapsed);
    console.log('updateCredits', user.displayName, principle, user.credits);
    return user;
}

function promiseResponse(res, promise) {
    return promise
        .catch(e => {
            console.debug(e); // FIXME: remove
            return {error: e.message || e};
        })
        .then(data => {
            jsonHead(res);
            res.end(JSON.stringify(data));
        });
}
app.post('/registration', function (req, res) {
    // Explicitly deconstruct and reconstruct the credential, so that we don't accidentally include, e.g., credits.
    const {id, oldEmail, name, iconURL, password, oldPassword, strength} = req.body;
    promiseResponse(res,
                    computeDescriptor(iconURL).then(descriptor => {
                        return setUser({email:id, oldEmail, displayName:name, face:iconURL, password, strength},
                                       {auth: oldPassword || password, descriptor: descriptor})
                            .then(trimUser);
                    }));
});
app.post('/login', function (req, res) {
    const {id, password} = req.body;
    promiseResponse(res,
                    id
                    ? getUser(id, {auth: password}).then(trimUser)
                    : Promise.resolve({name: uniqueNamesGenerator(namesConfig), strength: 1, credits: 10}));
});
app.post('/delete', function (req, res) {
    const {id, password} = req.body;
    promiseResponse(res, deleteUser(id, {auth: password}));
});

app.post('/purchase', function (req, res) {
    const {id, password, credits} = req.body;
    promiseResponse(res, setUser({email:id, credits}, {auth: password}));
});

app.post('/reportEnergy', function (req, res) {
    // FIXME: should check that this is coming from our server (e.g., audio mixer).
    const {id, energy} = req.body;
    promiseResponse(res, setUser({email:id, energy}, {}));
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
