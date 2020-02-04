"use strict";
/*jslint node: true, nomen: true */
// Logs info to logger as if it was an http request. Must be configured to use an express logger (such as morgan).

var logger, defaultMethod;

// arg is {logger, method} or just logger
exports.configure = function configure(props) {
    logger = (typeof props === 'function') ? props : props.logger;
    defaultMethod = props.method || 'TRACE';
};
// arg is {url, statusCode, headers} (and may be side-effected!) or just url (where, in the style of most express stuff, url is really a pathname)
exports.info = function info(pseudoReq) {
    var req = (typeof pseudoReq === 'string') ? {url: pseudoReq} : pseudoReq,
        res = {statusCode: req.statusCode || 200, getHeader: _ => {}};
    req.method = req.method || defaultMethod;
    req.headers = req.headers || {};
    req.httpVersionMajor = req.httpVersionMinor = 1;
    logger(req, res, function () {
        // It's not reasonable to expect callers to know the internals of express/morgan machinery, so do that here.
        // morgan sets _startTime and _startAt when logger() is called, and then uses that at the end, after next() finishes.
        // So, our next() bashes in some new values.
        if (req.startTime) {
            req._startTime = new Date(req.startTime);
            req._startAt = process.hrtime();
            var now = Date.now(), elapsed = now - req.startTime;
            req._startAt[0] -= 1;  // Don't let nanoseconds go negative.
            req._startAt[1] += (1e9 - (elapsed * 1e6));
        }
    });
};
exports.error = function error(pseudoReq) {
    if (typeof pseudoReq === 'string') { pseudoReq = {url: pseudoReq}; }
    pseudoReq.statusCode = pseudoReq.statusCode || 500;
    exports.info(pseudoReq);
};

// Answer a set of headers (side-effecting optional headers if supplied), such that the morgan logger will indicate userIdentifier as the requesting user.
exports.logUser = function logUser(userIdentifier, headers = {}) { // BTW, isDev logging does not show user. Production logging does.
    headers.authorization = "Basic " + Buffer.from(userIdentifier + ':').toString('base64');
    return headers;
}

