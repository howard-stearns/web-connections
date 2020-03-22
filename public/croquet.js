'use strict';

// There is a lightweight db of models that is replicated the same in each browser.
// And there are different views within each browser.
// Croquet's job is manage messages published between the model and view (in either direction)
// such that the models stay in perfect sync, which it does very efficiently.
//
// In our case, we want messages to be delivered from a view in one browser to a different
// view that is likely (but not necessarilly) in a different browser. Croquet isn't really
// designed to do that. We send message from the view to the replicated model - which means
// the message go on the wire to each browser - and then only deliver them to the intended view.
// It's actually the same number of packets at the source and receiver if it was done "directly".
// (The extra cost is in a small number of packets being ignored in non-targetted browsers that
// weren't doing anything anyway, and in those packets hitting the local network of those
// non-targetted receivers. The benefit is that all of this done quite efficiently and reliably.)
//
// Thus the code here is best understood as low-level P2P networking machinery, to be maintained and
// tested separately from particular application uses.

// A lightweight db of all peers in this session, replicated in each browser.
class CroquetSession extends Croquet.Model {
    init(options) {
        super.init(options);
        this.peersByBrowser = new Map(); // map of browserId => (map of peerId => peer). See removeBrowser
        // 'view-join' and 'view-exit' are the events published by Croquet itself when a browser joins.
        this.subscribe(this.sessionId, 'view-join', this.addBrowser);
        this.subscribe(this.sessionId, 'view-exit', this.removeBrowser);
        // Not on the wire, but it's good form to do model side-effects through messages so that they're well-ordered.
        this.subscribe(this.sessionId, 'addPeer', this.addPeer);
        this.subscribe(this.sessionId, 'removePeer', this.removePeer);        
    }
    addBrowser(browserId) { // Browser joined. Make sure there's a place to note it's peers.
        this.peersByBrowser.set(browserId, new Map()); // to be populated by addPeer
    }
    addPeer({peerId, browserId}) { // db notes a peer, and publish a message for that browser to make the corresponding view.
        this.peersByBrowser.get(browserId).set(peerId, CroquetPeer.create({peerId}));
        this.publish(peerId, 'created');
    }
    removePeer({peerId, browserId}) {
        const peers = this.peersByBrowser.get(browserId);
        peers.get(peerId).destroy();
        peers.delete(peerId);
        this.publish(peerId, 'removed');
    }
    removeBrowser(browserId) { // When a browser disconnect, remove its peers
        const peers = this.peersByBrowser.get(browserId);
        for (let peerId of peers.keys()) this.publish(this.sessionId, 'removePeer', {peerId, browserId});
        this.peersByBrowser.delete(browserId);
    }
    getPeer(peerId, browserId) {
        return this.peersByBrowser.get(browserId).get(peerId);
    }
}
CroquetSession.register('croquet.js');
class CroquetPeer extends Croquet.Model {
    init(options) {
        super.init(options);
        const peerId = options.peerId;
        this.peerId = peerId;
        this.subscribe(peerId, 'wire', this.forwardToView);
    }
    forwardToView(messageString) {
        // Only the one browser that created this peer will have the view that subscribes to
        // 'dispatch' with this peerId as scoped to peerId.
        this.publish(this.peerId, 'dispatch', messageString);
    }
}
CroquetPeer.register('croquet.js');

class CroquetPeerView extends Croquet.View {
    constructor(peerId, rootView) {
        super();
        this.peerId = peerId;
        this.rootView = rootView;
        this.dispatchers = [];
        this.subscribe(this.peerId, 'dispatch', this.dispatch);
    }
    getPeerModel() {
        return this.rootView.getPeerModel(this.peerId);
    }
    sendObject(messageObject) {
        const string = JSON.stringify(messageObject),
              id = messageObject.to;
        if (this.peerId !== messageObject.from) {
            throw new Error(`Cannot send ${messageObject.type} to ${id} from ${messageObject.from} using ${this.peerId}.`);
        }
        this.publish(messageObject.to, 'wire', string);
    }
    dispatch(string) {
        const messageObject = JSON.parse(string);
        this.dispatchers.forEach(dispatcher => dispatcher.p2pReceive(messageObject));
    }
    close() {
        return new Promise(resolve => {
            this.subscribe(this.peerId, 'removed', _ => {
                this.unsubscribe(this.peerId, 'removed');
                this.detach();
                resolve();
            });
            this.publish(this.sessionId, 'removePeer', {peerId: this.peerId, browserId: this.viewId});
            delete this.rootView.peerViews[this.peerId];
        });
        // FIXME: IWBNI we terminated the session if we were the last one to leave, but that isn't supported yet by Croquet.
    }
}
class CroquetSessionView extends Croquet.View {
    constructor(model) {
        super(model);
        this.peerViews = {}; // Keeps them from being garbage collected.
    }
    getPeerModel(peerId) {
        return this.wellKnownModel('modelRoot').getPeer(peerId, this.viewId);
    }
    getPeerView(peerId) {
        return this.peerViews[peerId];
    }
    static ensureSession(sessionName) {
        // Answer a promise for the CroquetSessionView of the given name, creating it if necessary.
        // Currently, Croquet does not provide a way to terminate sessions, so we currently only allow
        // one sessionName, that ends when the browser is closed.
        const session = this.session;
        if (session) {
            if (session.name !== sessionName) {
                throw new Error(`Cannot (currently) create session ${sessionName} while ${session.name} exists.`);
            }
            return Promise.resolve(session);
        } else {
            return Croquet.startSession(sessionName, CroquetSession, CroquetSessionView).then(({view}) => {
                view.name = sessionName;
                this.session = view;
                return new Promise(resolve => {
                    view.subscribe(view.viewId, 'synced', isSynced => {
                        if (!isSynced) return;
                        view.unsubscribe(view.viewId, 'synched');
                        resolve(view);
                    });
                });
            });
        }
    }
    static createPeer(sessionName, peerId, dispatcher) {
        // Answer a CroquetPeerView with the given peerId and dispatch right away,
        // and also ensure the session. The CroquetPeerView will have an openPromise property,
        // whose value is a Promise that resolves to the view when it is ready for use.
        // This is done in two steps like this so that we can use it like WebSockets and EventSource
        // that get created right away and emit 'open' when they're actually ready.
        return new Promise(resolve => {
            this.serializedEnsureSession(sessionName).then(root => {
                root.subscribe(peerId, 'created', _ => {
                    root.unsubscribe(peerId, 'created');
                    const peer = new CroquetPeerView(peerId, root);
                    peer.dispatchers.push(dispatcher);
                    root.peerViews[peerId] = peer;
                    resolve(peer);
                });
                root.publish(root.sessionId, 'addPeer', {peerId, browserId: root.viewId});
            });
        });
    }
}
CroquetSessionView.serializedEnsureSession = serializePromises(sessionName => CroquetSessionView.ensureSession(sessionName));
class CroquetDispatch extends P2pDispatch {
    // FIXME: this works, but ONLY if the first use makes use of openPromise.
    // It does NOT currently support the other style, in which one can attach a dispatcher.connection.open immediately
    // after construction.
    constructor(id, receiver) {
        super(id, receiver);
        const dispatchers = this.addToDispatchers();
        if (dispatchers.length > 1) {
            this.connection = dispatchers[0].connection;
            this.connection.dispatchers.push(this);
            this.openPromise = Promise.resolve(this);
        } else {
            this.openPromise = CroquetSessionView.createPeer('rtcV0.0.12', id, this).then(peerView => {
                this.connection = peerView;
                return this;
            });
        }
    }
    closeSharedConnection() {
        this.connection.close();
    }
    sendObject(messageObject) {
        if (!this.connection) return Promise.resolve();
        return Promise.resolve(this.connection.sendObject(messageObject));
    }
}
CroquetDispatch.peers = {};

class CroquetRTC extends RTCSignalingPeer { }
CroquetRTC.dispatchClass = CroquetDispatch;
