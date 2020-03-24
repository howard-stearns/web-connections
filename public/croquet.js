'use strict';

// There is a lightweight db of models that is replicated the same in each browser.
// And there are different views within each browser.
// Croquet's job is manage messages published between the model and view (in either direction)
// such that the models stay in perfect sync, which it does very efficiently.
//
// In our case, we want messages to be delivered from a view in one browser to a different
// specific view that is likely (but not necessarilly) in a different browser. Croquet isn't really
// designed to do that. We send message from the view to the replicated model - which means
// the message go on the wire to each browser - and then only deliver them to the intended view.
// It's actually the same number of packets at the source and receiver as if it was done "directly".
// (The extra cost is in a small number of packets being ignored in non-targetted browsers that
// weren't doing anything anyway, and in those packets hitting the local network of those
// non-targetted receivers. The benefit is that all of this done quite efficiently and reliably.)
//
// Thus the code here is best understood as low-level P2P networking machinery, to be maintained and
// tested separately from particular application uses.


// MODELS - Replicated identically in each browser.

class CroquetSession extends Croquet.Model { // A lightweight db of all peers in this session.
    init(options) {
        super.init(options);
        this.peersByBrowser = new Map(); // map of browserId => (map of peerId => peer). See removeBrowser
        // 'view-join' and 'view-exit' are the events published by Croquet itself when a browser joins.
        this.subscribe(this.sessionId, 'view-join', this.addBrowser);
        this.subscribe(this.sessionId, 'view-exit', this.removeBrowser);
        // Published by our views to manage individual peerIds.
        this.subscribe(this.sessionId, 'addPeer', this.addPeer);
        this.subscribe(this.sessionId, 'removePeer', this.removePeer);        
    }
    addBrowser(browserId) { // Browser joined. Make sure there's a place to note it's peers.
        // There is a double layer because a single browser might have more than one peerId.
        this.peersByBrowser.set(browserId, new Map()); // to be populated by addPeer
    }
    addPeer({peerId, browserId}) { // db notes a peer, and publish a message for that browser to make the corresponding view.
        this.peersByBrowser.get(browserId).set(peerId, CroquetPeer.create({peerId}));
        this.publish(peerId, 'created');
        this.publish(this.sessionId, 'notifyAddPeer', peerId); // In case application view in another wants to know.
    }
    removePeer({peerId, browserId}) { // Remove that peer (by peerId) from the db replicated in each browser.
        const peers = this.peersByBrowser.get(browserId);
        peers.get(peerId).destroy();
        peers.delete(peerId);
        this.publish(peerId, 'removed');
        this.publish(this.sessionId, 'notifyRemovePeer', peerId); // In case application view in another wants to know.
    }
    removeBrowser(browserId) { // When a browser disconnect, remove all its peers.
        const peers = this.peersByBrowser.get(browserId);
        for (let peerId of peers.keys()) this.publish(this.sessionId, 'removePeer', {peerId, browserId});
        this.peersByBrowser.delete(browserId);
    }
    getPeer(peerId, browserId) { // Utility
        return this.peersByBrowser.get(browserId).get(peerId);
    }
}
CroquetSession.register('croquet.js');

// The CroquetSession has a single CroquetPeer for each peerId that is connected.
// Every browser gets a copy of the CroquetPeer (because Croquet models are identical in each browser).
// However, only the browser associated with the particular peerId will have an associated CroquetPeerView (below).
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


// VIEWS - Different instances and values in each browser.
//
// In many Croquet applications, views ARE the application code. In our case, we have
// standard code that does WebRTC with different kinds of pluggable signaling mechanisms.
// The CroquetPeerView is part of that mechanism, rather than the application itself.
// Thus these views might be thought of as controllers that manage the communication.

// An application creates a single CroquetPeerView for each peerId at which to receive P2P messages.
// Often, there will just be one such peerId per browser, but there could be more. (See use of dispatchers.)
// In any case, each peerId will have a CroquetPeerView only in the one browser that created that peerId.
// (Although... there could be monitoring browsers or some such that could also "T" the messages.)
class CroquetPeerView extends Croquet.View {
    constructor(peerId, rootView) {
        super();
        this.peerId = peerId;
        this.rootView = rootView;
        this.dispatchers = [];
        this.subscribe(this.peerId, 'dispatch', this.dispatch);
    }
    getPeerModel() { // Utility to get the PeerModel corresponding to this view's peerId.
        return this.rootView.getPeerModel(this.peerId);
    }
    sendObject(messageObject) { // Send {from, to, type, message} to any other peerId.
        const string = JSON.stringify(messageObject);
        if (messageObject.from !== this.peerId) {
            throw new Error(`Cannot send ${messageObject.type} to ${id} from ${messageObject.from} using ${this.peerId}.`);
        }
        // The CroquetPeer with the this specified peerId will receive this in each browser.
        this.publish(messageObject.to, 'wire', string);
    }
    dispatch(string) { // Invoke p2pReceive on each dispatcher (which in turn will either act on the message or not).
        const messageObject = JSON.parse(string);
        // There should be one or more dispatchers. (See CroquetDispatch, below.)
        this.dispatchers.forEach(dispatcher => dispatcher.p2pReceive(messageObject));
    }
    close() { // Remove all subscriptions and cleanup all views and replicated model for this peerId.
        return new Promise(resolve => {
            this.subscribe(this.peerId, 'removed', _ => {
                this.unsubscribe(this.peerId, 'removed');
                this.detach();
                resolve();
            });
            this.publish(this.sessionId, 'removePeer', {peerId: this.peerId, browserId: this.viewId});
            delete this.rootView.peerViews[this.peerId];
        });
        // FIXME: IWBNI we terminated the session if we were the last one to leave, but that isn't supported yet by
        // Croquet. The only way to end the session is to close the browser. (Conceptually, the CroquetSession model
        // never goes away within the Ether.)
    }
}
class CroquetSessionView extends Croquet.View {
    constructor(model) {
        super(model);
        this.peerViews = {}; // Keeps them from being garbage collected.
    }
    getPeerModel(peerId) { // Utlity to get any currently live peer model (not just ours).
        return this.wellKnownModel('modelRoot').getPeer(peerId, this.viewId);
    }
    getPeerView(peerId) { // Utility to get only peer views that are in our browser.
        return this.peerViews[peerId];
    }
    static ensureSession(sessionName) {
        // Answer a promise for the CroquetSessionView of the given name, creating it if necessary.
        // Currently, Croquet does not provide a way to terminate sessions, so we currently only allow
        // one sessionName in each browser, that ends (for us) when the browser is closed.
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
                        view.unsubscribe(view.viewId, 'synced');
                        resolve(view);
                    });
                });
            });
        }
    }
    static createPeer(sessionName, peerId, dispatcher) {
        // Answer a promise that resolves to CroquetPeerView with the given peerId and dispatch,
        // when it is ready for use, creating the session as needed.
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

// We have a number P2pDispatch classes that can be used for WebRTC signaling. This one uses a CroquetPeerView, above,
// as the p2p signaling channel. As with all P2pDispatch, you create one for each id/receiver pair corresponding
// to your end of an RTCPeerConnection (see CroquetRTC). The receiver is an objet with a peerId (identifying the peer at
// the other end of the p2p pairing, not this end!), and a method for each message.type. The receiver object will
// receive the messages from that peer.
class CroquetDispatch extends P2pDispatch {
    constructor(id, receiver) {
        // The CroquetDispatch will have an openPromise property, whose value is a Promise that resolves to the view
        // when it is ready for use.
        // This is done in two steps like in an (only partially successful) attempt to support
        // creation in the style of WebSockets, EventSource, and RTCDataChannel, in which the
        // channel gets created right away, and emits 'open' when it is actually ready. See CroquetDispatch.
        // In fact, this particular implementation only works when used with openPromise. (Not this.connection.onopen.)
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

// A wrapper for RTCPeerConnection that handles signaling using Croquet.
// Note that there is no need to set up a dedicated "signaling server", as this uses the Croquet reflector
// network.
class CroquetRTC extends RTCSignalingPeer { }
CroquetRTC.dispatchClass = CroquetDispatch;
