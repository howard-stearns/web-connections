'use strict';
describe('Croquet p2p', function () {
    const dispatch = {}, id = 'xx', sessionName = 'testing36';
    var view;
    beforeAll(function (done) {
        CroquetSessionView.createPeer(sessionName, id, dispatch).then(peerView => {
            view = peerView;
            done();
        });
    });
    afterAll(function () {
        view.close();
    });
    describe('internal', function () {
        var root;
        beforeAll(function () {
            root = view.wellKnownModel('modelRoot');
        });
        describe('session model', function () {
            it('exists', function () {
                expect(root).toBeTruthy();
                expect(root instanceof CroquetSession).toBeTruthy();
            });
        });
        describe('peer model', function () {
            var peerModel;
            beforeAll(function () {
                peerModel = view.getPeerModel();
            });
            it('exists', function () {
                expect(peerModel instanceof CroquetPeer).toBeTruthy();
            });
            it('has peerId', function () {
                expect(peerModel.peerId).toBe(id);
            });
        });
        describe('peer view', function () {
            it('exists', function () {
                expect(view instanceof CroquetPeerView).toBeTruthy();
            });
            it('has peerId', function () {
                expect(view.peerId).toBe(id);
            });
            it('has rootView', function () {
                const root = view.rootView;
                expect(root instanceof CroquetSessionView).toBeTruthy();
            });
        });
    });
    describe('view interface', function () {
        it('send loopback', function (done) {
            const sentObject = {from: id, to: id, type: 'foo', data: 17};
            dispatch.p2pReceive = receivedObject => {
                ['from', 'to', 'type', 'data'].forEach(key => expect(receivedObject[key]).toBe(sentObject[key]));
                done();
            };
            view.sendObject(sentObject);
        });
        describe('second participant', function () {
            var view2, id2 = 'yy', dispatch2 = {};
            beforeAll(function (done) {
                CroquetSessionView.createPeer(sessionName, id2, dispatch2).then(peerView => {
                    view2 = peerView;
                    done();
                });
            });
            afterAll(function () {
                view2.close();
            });
            it('has separate view', function () {
                expect(view).not.toBe(view2);
            });
            it('has separate model', function () {
                expect(view.getPeerModel()).not.toBe(view2.getPeerModel());
            });
            it('adds and removes', function (done) {
                const id3 = 'zz', dispatch3 = {};
                CroquetSessionView.createPeer(sessionName, id3, dispatch3).then(view3 => {
                    expect(view.rootView.getPeerView(id3)).toBe(view3);
                    expect(view.rootView.getPeerModel(id3)).toBeTruthy();
                    expect(view.rootView.getPeerModel(id3).peerId).toBe(id3);
                    view3.close().then(_ => {
                        expect(view.rootView.getPeerView(id3)).toBeFalsy();
                        expect(view.rootView.getPeerModel(id3)).toBeFalsy();
                        done();
                    });
                });
            });
            it('send from other', function (done) {
                const sentObject = {from: id2, to: id, type: 'foo', data: 42};
                dispatch.p2pReceive = receivedObject => {
                    ['from', 'to', 'type', 'data'].forEach(key => expect(receivedObject[key]).toBe(sentObject[key]));
                    done();
                };
                view2.sendObject(sentObject);
            });
            it('send to other', function (done) {
                const sentObject = {from: id, to: id2, type: 'bar', data: 42};
                dispatch2.p2pReceive = receivedObject => {
                    ['from', 'to', 'type', 'data'].forEach(key => expect(receivedObject[key]).toBe(sentObject[key]));
                    done();
                };
                view.sendObject(sentObject);
            });
        });
    });
});
