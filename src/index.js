'use strict';

/* This file has the following sections (which could, of course, be split into multiple files).
   APPLICATION LOGIC - independent of the UI
   UI LOGIC          - references UI elements (e.g., defined by id in the .html), other than that done by Face Logic
   GLOBALS           - UI constants whose initialization would be different with webpack, etc.
   UI INITIALIZATION - MDC object instantiation, and setting event handlers
 */

// APPLICATION LOGIC
import {
    configure,
    register, unregister, logIn, logOut, purchase, createInvite,
    EnergyMeter, RegistrationStatus, UserData, getUpdatedCredentials,
    getFace, abandonFace,
    updateUserStats // fixme
} from '@highfidelity/accounts';
//const ACCOUNTS = "http://localhost:8080";
const ACCOUNTS = "https://accounts.highfidelity.com:8080";

// There are two password-based login cycles to cover:
// 1. Ordinary login, starting with assumed credentials from getCredential 
//    getCredential will do the right thing: ask the user to actively select
//    a profile (with no password) if explicitly logged out, or if more than one to chose from.
//    Otherwise just do it and notify.
// 2. Before updating the user's (server-based) profile, starting with just an id
//    In this case, we DO want to ask for a password, labeled by a specific profile,
//    and we do NOT want to pick between profiles (which can happen with getCredential).
// In either case, we want to process the login results. But if the login fails (in either case), we want to let
// the password-request repeat (as in (2)) until success, or just ensure logOut if the user gives up.

function callLogIn() { // case 1, above
    const idAtStart = RegistrationStatus.hasRegistered();
    return logIn()
        .catch(e => confirmPassword(idAtStart, e))
        .then(c => !c && getUpdatedCredentials({}));
}

function gatherCredentialForConfirmation(id) {
    return gatherCredentialWithPassword([id], {
        forcePassword: true,
        forceDialog: true,
        label: "Confirm"
    });
}
function confirmPassword(id, e = null) { // case 2, above
    // id => gather credential => login => maybe loop
    if (e) console.warn(e);
    return gatherCredentialForConfirmation([id])
        .then(getUpdatedCredentials)
        .catch(e => confirmPassword(id, e))
}

// Asynchronously gets password and calls function({id, password}), resolving to that result.
function withPassword(requestedId, functionOfCredential) {
    // confirmPassword and call function.
    return confirmPassword(requestedId).then(credential => {
        if (!credential) return;
        const {id, password} = credential;
        if (id !== requestedId) return Promise.reject(new Error(`Changed user from ${requestedId} to ${id}.`));
        return functionOfCredential({id, password});
    });
}

async function callUnregister() {
    await initialSetUp;
    const id = RegistrationStatus.id();
    if (!id) return console.error('unregister should only be enabled for registered users.');
    withPassword(id, cred => unregister(cred).then(notifyLoggedOut));
}
function callPurchase({id, credits}) {
    return withPassword(id, credential => purchase(credential, credits));
}

// UI LOGIC

function useClass(element, className, isOn) {
    element.classList[isOn ? 'add' : 'remove'](className);
}

// FIXME: there are a couple of places where we should be doing MDCList.layout, but aren't. Should we use this?
function openDialog(dialogDomElement, onOpen=null, stack = false) {
    // Answer a promise that resolves to the action taken
    const dialog = new MDCDialog(dialogDomElement);
    // If the same dialog intermittently has buttons hidden, stack will fail unless turned off before opening.
    dialog.autoStackButtons = stack; 
    return new Promise(resolve => {
        const opened = onOpen && (_ => onOpen(dialog)),
              closed = event => {
                  resolve(event.detail.action);
                  if (onOpen) dialog.unlisten('MDCDialog:opened', opened);
                  dialog.unlisten('MDCDialog:closed', closed);
              };
        if (onOpen) dialog.listen('MDCDialog:opened', opened);
        dialog.listen('MDCDialog:closed', closed);
        dialog.open();
    });
}
function goIf(from, to = '') { // set hash only if current as specified
    if (location.hash === from) location.hash = to;
}

// Inititalizing MDC
function mapSelectedElements(ancestor, selector, callback) {
    ancestor.querySelectorAll(selector).forEach(callback);
}
// MDC objects are instantiated and saved so that mdcObjects.get(domElement) => MDC object.
const mdcObjects = new WeakMap();
function instantiateDescendents(ancestor, selector, constructor) {
    mapSelectedElements(ancestor, selector, e => mdcObjects.set(e, new constructor(e)));
}
function instantiateFields(ancestor) {
    instantiateDescendents(ancestor, '.mdc-text-field', MDCTextField),
    instantiateDescendents(ancestor, '.mdc-notched-outine', MDCNotchedOutline),
    instantiateDescendents(ancestor, '.mdc-floating-label', MDCFloatingLabel),
    instantiateDescendents(ancestor, '.mdc-text-field-helper-text', MDCTextFieldHelperText)
}
function instantiateAndLayoutLists(ancestor) {
    mapSelectedElements(ancestor, '.mdc-list', e => {
        const list = new MDCList(e);
        mdcObjects.set(e, list);
        list.layout();
    });
}
/*  The Beast
Given a list of one or more credential ids,
present the user with the credentials, and
conditionally require the user to enter the password for the selected credential.
Return the selected, completed credential, or falsey if the user cancels.

Requires that getDb(id) produce {id, name, iconURL, password (in some conditions)}.

This is used in two circumstances:

1. It implements the credentials.get UI for browsers that do not implement PasswordCredential.
   That is, pick from among multiple credentials, or at least be made aware of the one stored credential being used.
   If the user has explicitly signed out, then afterwards they have to explicitly pick or cancel, until they pick one.

2. Regardless of whether the user experiences the above on startup vs using a native PasswordCredential, we
   force the user to enter their (old) password before changing their profile. For example, they may
   have walked away from the machine without logging out, or they might not have noticed the current signin
   despite the pictures and confirmation for case (1). So before changing their profile, we force the
   user to enter their password, without autocomplete. This is the same UI as in the singlue user case of (1),
   because we want the user to be aware of the name, picture, and email that they are entering a password for.

Now, here is where it gets tricky. I think the best user experience is where (1) is simply our own implementation 
of what Chrome does fo PasswordCredential. That's what happens by default. However, to implement (1), we keep ALL of
the information in our own on-device per-site persistent storage, including the password, and we don't (yet) provide
a UI for a user to manage/delete saved data, the way that the Chrome browser does for saved password credentials.
Note that even if we did provide that, it would be in our app, not in the browser's "settings". It turns out that 
even in browsers that do not yet support the PasswordCredential API, they DO supply a similar separate password store.
However, they require that the user click a password form field to fill in the password. Javascript cannot reach in 
and grab the password (even for our own site) without the user clicking. So... there is an alternative implementation,
in which STORE_PASSWORDS, below, is false, in which we do not store passwords ourselves, but instead present the user
with the password field from (2), and let it autocomplete from the browser.
*/
const STORE_PASSWORDS = !location.search.includes('store-passwords=false');
async function gatherCredentialWithPassword(ids, {
    forcePassword = false,
    forceDialog = forcePassword,
    label = "Sign in",
    message = ''} = {}) {
    // FIXME: display message, if any (e.g., that the password entered was wrong)
    function getIconElement(avatar) { return avatar.querySelector('img'); }
    function getNameElement(avatar) { return avatar.querySelector('.mdc-list-item__primary-text'); }
    function getIdElement(avatar) { return avatar.querySelector('.mdc-list-item__secondary-text'); }
    const passwords = STORE_PASSWORDS && !forcePassword && [];
    if (!passwords && ids.length) forceDialog = true;
    var credential = {}, cleanup;
    console.log('gatherCredentialWithPasswords', ids, 'dialog:', forceDialog, 'password:', forcePassword,
                'passwords:', passwords, 'label/message:', label, message);

    // Two cases where we bail early.
    if (!ids.length) return;
    if ((ids.length === 1) && !forceDialog) { // No need for dialog. Just a snackbar notification.
        const cred = UserData.getCredential(ids[0]);
        if (cred.password) {
            cred.id = ids[0];
            signingIn__label.innerText = `Signing in as ${cred.id}`;
            signingInSnackbar.open()
            return cred;
        }
    }

    // Things we can set up before there is a dialog.
    selectUser__context.innerText = label;
    const accept = selectUser.querySelector('button[data-mdc-dialog-action="yes"]');
    if (passwords && (ids.length > 1)) {
        accept.classList.add('hidden');
    } else {
        accept.querySelector('.mdc-button__label').innerText = label;
        accept.disabled = ids.length > 1;
        accept.classList.remove('hidden');
    }
    // Kludge alert:
    // MDC listen/unlisten doesn't seem to work on this list (see cleanup), so
    // cons a new one.
    selectUser__list.innerHTML = '';        
    const list = selectUser__list.cloneNode(true);
    selectUser__list.parentNode.replaceChild(list, selectUser__list);

    const confirmation = await openDialog(selectUser, dialog => {
        const password = document.importNode(selectUserTemplate.content.lastElementChild, true),
              passwordIndex = ids.length,
              visibility = password.querySelector('button'),
              input = password.querySelector('input');
        function setCredentialFrom(index) {
            const selected = selectUser__list.children[index];
            credential = {
                id: getIdElement(selected).innerText, // FIXME coming up null in store-passwords=false
                name: getNameElement(selected).innerText,
                iconURL: getIconElement(selected).src,
                password: passwords ? passwords[index] : input.value,
                type: 'password'
            };
        }
        // Populate the users to select from.
        ids.forEach(id => {
            const data = UserData.getCredential(id);
            if (!data) return console.warn(`No data for ${id}.`);
            const {name, iconURL, password} = data;
            const avatar = document.importNode(selectUserTemplate.content.firstElementChild, true);
            getIconElement(avatar).src = iconURL;
            getNameElement(avatar).innerText = name;
            getIdElement(avatar).innerText = id;
            if (passwords) passwords.push(password);
            new MDCRipple(avatar);
            selectUser__list.appendChild(avatar);
        });
        visibility.onclick = togglePasswordVisibility;
        input.oninput = e => {
            accept.disabled = !credential.id;
            credential.password = e.target.value;
        }
        const nCredentials = selectUser__list.childElementCount;
        if (forceDialog && !nCredentials) {
            console.warn("No data for selecting credentials.");
            dialog.close();
            logOut({preventSilentAccess: false}).then(notifyLoggedOut);
        } else if (nCredentials === 1) {
            setCredentialFrom(0);
        }
        if (!passwords) {
            selectUser__list.appendChild(password);
        }
        const fields = instantiateFields(password);
        // Initialize the MDC list.
        instantiateAndLayoutLists(selectUser);
        function select({detail}) {
            if (detail.index === passwordIndex) return;
            accept.disabled = !input.value && !passwords;
            setCredentialFrom(detail.index);
            if (passwords) dialog.close('yes');
        }
        var selectMDC = mdcObjects.get(selectUser__list);
        selectMDC.listen('MDCList:action', select);
        cleanup = _ => selectMDC.unlisten('MDCList:action', select);
    });
    if (cleanup) cleanup();
    if (confirmation !== 'yes') return;
    return credential;
}

function reconcileLocalStorage(credential) {
    // If a native navigator.credentials produces a credential that isn't in or local storage, add it.
    // That way it will be available for password confirmation.
    if (!credential) {
        /*
        // Kludge alert:
        // It is possible that a security-consious user has opted out of the use of the browser's account storage,
        // and there's no way for us to know the difference between this vs simply not choosing from among multiple browser accounts!
        // But we can make a GUESS by comparing with our db:
        const ids = getIds();
        console.log('reconcileLocalStorage, ids:', ids);
        // A security-consious user would not share a browser with other users, so if there is EXACTLY one stored in our db,
        // it could be because the user opted out. Furthermore, if the user had not opted out (declined from multiple browser-stored
        // choices), there ids.length would be more than 1. Finally, note that the browser-storage will not give the user
        // a chance to decline if there's just one. So we KNOW that in this case, the user has opted out all along.
        //
        // I don't think this is the right thing for someone who has screwed things up by creating multiple registrations
        // in the same OS account, and yet opting out of the browser storage. Fortunately, our face id will prevent
        // people from accidentally doing that, so the failure case is a really twisted special special case that we simply don't support.
        if (ids.length === 1) {
            const cred = getDb(ids[0]);
            if (!cred) {
                console.warn(`Inconsistent db. No data for ${ids[0]}.`);
                return;
            }
            cred.id = ids[0];
            cred.type = 'password';
            return cred;
        }
        */
        return;
    }
    if (!UserData.getCredential(credential.id)) UserData.storeCredential(credential);
    return credential;
}
function filterDeletedCredential(credential) {
    // Don't allow credentials of accounts that have been deleted by the user.
    if (!credential) return;
    if (credential.name === DELETED_CREDENTIAL_PROPERTY_VALUE) return;
    return credential;
}


function notifyLoggedOut() {
    loggedOutSnackbar.open();
}
function noteChanges(changes) {
    console.log('changed:', ...changes);
    // FIXME: snackbar  is just confusing things. Rip it out, or make it clearer.
    /*
    if (!changes.length) return;
    const label = (changes.length > 1)
        ? changes.slice(0, -1).join(', ') + ' and ' + changes[changes.length - 1]
          : changes[0];
    changed__label.innerText = `Changed ${label}.`;
    changedSnackbar.open();
    */
}

function onRegistrationStatusChange(id) {
    const hasRegistered = RegistrationStatus.hasRegistered();
    share__fieldset.disabled = buyEnergy__fieldset.disabled = forgetMe.disabled = !id;
    const disabled = 'mdc-list-item--disabled';
    useClass(body, 'registered', id);
    // FIXME: there are places where we encourage people to register, that are visible when unregistered.
    // When you have already registered, we should either hide them, or change the to encourage signing in.
    // Exactly how to resolve this depends on whether there should be a "sign out" once signed in, or not.
    useClass(registerItem, 'hidden', hasRegistered);
    useClass(registerItem, disabled, id);
    useClass(logoutItem, disabled, !id);
    useClass(loginItem, disabled, id || !hasRegistered);
}
function announceArrival(hostname) {
    console.log('arrived at', hostname);
    guide.classList.add('hidden');
    arrived__label.innerText = hostname ? `You have arrived near ${hostname}.` : "You have arrived.";
    arrivedSnackbar.open();
}
function arriveName(name) {
    guide.classList.add('hidden');
    announceArrival(name);
}
function announceDeparted(hostname) {
    console.log(hostname, 'departed');
    arrived__label.innerText =`${hostname} is no longer present.`;
    arrivedSnackbar.open();
}
function announceSoldOut(hostname) {
    console.log(hostname, 'sold out');
    arrived__label.innerText =`The invitation from ${hostname} has exceeded capacity.`;
    arrivedSnackbar.open();
}
var fixmeDemoFollowId;
function onUserData(credential, destination, notedChanges) {
    var {name, iconURL, credits, strength, demoFollowName, demoFollowId, x, y, avatar} = credential;
    // Here we use avatar, rather than iconURL
    if (iconURL) profile__image.src = profilemenu__image.src = iconURL;
    if (name) demoYourOwnName.innerText = /* fixme remove <<that */profilemenu__name.innerText = name;
    if (strength) setCurrentStrength(strength);
    if (demoFollowName) { // FIXME remove
        demoHostname1.innerText = demoHostname2.innerText = demoHostname3.innerText = demoHostname4.innerText =  demoFollowName;
        fixmeDemoFollowId = demoFollowId;
    }
    useClass(guide, 'hidden', !destination);
    if (destination) {
        console.log('invite!', destination);
        switch (destination.reason) {
        case 'sold out':
            announceSoldOut(destination.name);
            guide.classList.add('hidden');
            return credential;
        case 'left':
            announceDeparted(destination.name);
            guide.classList.add('hidden');
            return credential;
        case 'arrived':
            announceArrival(destination.name);
            return credential;  // Bailing early - we're already there.
        }
        destinationHost.innerText = destination.name;
        destinationLocation.innerText = `${destination.x}, ${destination.y}`;
        yourLocation.innerText = `${x}, ${y}`;
        setTimeout(_ => location.hash = 'destinationGuide', 100);
    } else if (!credits) {
        setTimeout(_ => location.hash = 'mustRegister', 100);
    }
    noteChanges(notedChanges);
    return credential;
}
function onAppdrawerClosed() {
    const activeClass = 'mdc-list-item--activated',
          activeSelector = '.' + activeClass,
          activeElement = appdrawer.querySelector(activeSelector);
    if (activeElement) {
        activeElement.classList.remove(activeClass);
        activeElement.setAttribute('tabIndex', '-1');
    }
    navigationButton.blur();
    // FIXME mainContent.querySelector('input, button').focus();
    // Modal drawer will close when you click on scrim: fix hash without disrupting menu choices.
    goIf('#navigation');
}
function onRegistrationSubmit(e) {
    e.preventDefault();
    const data = {
        id: email.value,
        oldEmail: oldEmail.value,
        oldPassword: oldPassword.value,
        name: displayName.value,
        iconURL: face.value,
        avatar: face.value,
        strength: Number.parseInt(strength.value)
    };
    if (RegistrationStatus.id() || !registration.classList.contains('update')) {
        data.password = password.value; // Don't pass when updating an insecure "account"
    }

    register(data).catch(e => {
        const message = e.message || e;
        registrationFail.innerText = message;
        registrationFailSnackbar.open();
        if (message.includes('email')) {
            email.focus();
        } else if (message.includes('selfie') || message.includes('face')) {
            showFaceResult();
        }
    }).then(_ => location.hash = '');
}
function onBuyEnergy(e) {
    e.preventDefault();
    creditsDialog.close();
    callPurchase({id: RegistrationStatus.id(), credits: Number.parseInt(purchaseAmount.value)}).catch(console.error);
}

function onCopyUrl() {
    inviteUrl.select();
    inviteUrl.setSelectionRange(0, 99999);
    document.execCommand('copy');
    console.log('copying', inviteUrl.value, 'to clipboard');
}
const QR_CELL_SIZE = 7;
function showQR(url) {
    inviteUrl.value = url;
    qr.className = '';
    var generator = qrcode(0, 'H');
    generator.addData(url);
    generator.make();
    qr.innerHTML = generator.createImgTag(QR_CELL_SIZE);
}
function parsedNFollowers() { return Number.parseInt(nFollowers.value || "1"); }
function parsedFollowerCredits() { return Number.parseInt(followerCredits.value || "10"); }
function onShareSubmit(e) {
    e.preventDefault();
    // Do not close: let people use the url
    withPassword(RegistrationStatus.id(), credential => {
        credential.energy = parsedFollowerCredits();
        credential.followers = parsedNFollowers();
        createInvite(credential).then(link => {
            // FIXME how should this interact with back/forward button? How to get back to registerd-only?
            showQR(new URL(link, location.href));
            body.classList.add('shareAnyone');
        });
    });
}
function togglePasswordVisibility(e) {
    e.preventDefault();
    const icon = e.target, input = icon.previousElementSibling;
    if (input.type === 'password') {
        input.type = 'text';
        icon.innerText = "visibility_off"
    } else {
        input.type = 'password';
        icon.innerText = "visibility"
    }
}
function updateFaceResult() {
    face__image.src = face.value || '';
    useClass(face, 'transparent', face.value);
    useClass(face__image, 'hidden', !face.value);
}
function showFaceResult(e) {
    if (e) e.preventDefault();
    webcamDialog.open();
    console.log('fixme showFaceResult');
    getFace(webcamVideo, videoOverlay).then(dataUrl => {
        console.log("FIXME showFaceResult data:", !!dataUrl);
        if (webcamDialog.isOpen) webcamDialog.close();
        if (dataUrl) {
            face.value = dataUrl; // FIXME: in cleanup, pass this to updateFaceResult and have it do it. (But needs testing.)
            updateFaceResult();
        } else {
            face.removeAttribute('required'); // FIXME: this let's user skip security selfie
        }
        // FIXME: also put a transparent mask over input to block clicks so that no one messes up the text
        face.blur();
    });
}

var currentRegistrationDialog;
function closeRegistration() { currentRegistrationDialog && currentRegistrationDialog.close(); }
async function openRegistration(isUpdate) {
    await initialSetUp;
    const registered = RegistrationStatus.id();
    var credential = {};
    if (registered) {
        credential = await confirmPassword(registered)
    } else if (isUpdate) {
        credential = await getUpdatedCredentials({});
    }
    if (!credential) return;
    openDialog(registration, dialog => {
        face.value = credential.iconURL || '';
        displayName.value = credential.name || '';
        oldEmail.value = email.value = credential.id || '';
        oldPassword.value = password.value = credential.password || '';
        strength.value = currentStrength;

        // We don't want a value set in the password field when updating an unregistered "account", because
        // the browser will ask to save it (confusing everyone).
        if (registered || !isUpdate) {
            password.setAttribute('required', true);
        } else {
            password.removeAttribute('required');
        }
        // Get the user to at least try the security selfie (but we unrequire if they explicitly skip after trying).
        face.setAttribute('required', true);
        console.log("FIXME openRegistration setting face to be required:", face.hasAttribute('required'), `[${face.getAttribute('required')}]`, face);

        useClass(registration, 'update', isUpdate);
        register__submit.value = isUpdate ? "Update" : "Register";
        displayName.disabled = isUpdate && EnergyMeter.instance.currentEnergy < 12;
        // FIXME remove, unless we decide to prevent unregistered users from changing their strength: strength.disabled = !registered;

        const fields = instantiateFields(registration);
        const lists = instantiateAndLayoutLists(registration);
        updateFaceResult();
        currentRegistrationDialog = dialog;
        dialog.listen('MDCDialog:closed', _ => {
            currentRegistrationDialog = null;
            goIf('#registration');
        });
    });
}


// ENERGY STUFF

// var and setter in case we pull it into a module with an exposed live binding and setter.
var currentStrength = 1;
function setCurrentStrength(strength) { currentStrength = strength; }
var muted = false;
function setMuted(m) { muted = m; }

function toggleMuted() {
    setMuted(!muted);
    toggleTalking.innerText = muted ? "start talking" : "stop talking";
}

function formatCredits(energy) {
    return (energy > 1000) ? energy.toFixed() : (energy < 0.001 ? "0.000" : energy.toPrecision(3));
}
const MAX_STRENGTH = Number.parseInt(strength.getAttribute('max')); // Consume up to N times normal rate.
const ENERGY_INTERVAL_MS = 100; // How often do we sample energy use.
const UPDATES_PER_REPORT = 15 * 1000 / ENERGY_INTERVAL_MS;  // Every 15 seconds

const AVERAGE_ENERGY_UNITS_CONSUMED_PER_HOUR = 60;
const INTERVALS_PER_HOUR = 60 * 60 * 1000 / ENERGY_INTERVAL_MS;
const AVERAGE_ENERGY_UNITS_CONSUMED_PER_INTERVAL = AVERAGE_ENERGY_UNITS_CONSUMED_PER_HOUR / INTERVALS_PER_HOUR;
const LINEAR_CONSUMPTION_METER_AVERAGE = 0.5;
const LINEAR_CONSUMPTION_METER_UNITS = AVERAGE_ENERGY_UNITS_CONSUMED_PER_INTERVAL / LINEAR_CONSUMPTION_METER_AVERAGE;
// Sanity check: LINEAR_CONSUMPTION_METER_UNITS * LINEAR_CONSUMPTION_METER_AVERAGE * INTERVALS_PER_HOUR ~= AVERAGE_ENERGY_UNITS_CONSUMED_PER_HOUR

function getConsumption() { // simulated
    var meterThisPeriod = muted ? 0 : currentStrength * Math.random();
    return Math.max(0, Math.min(EnergyMeter.instance.currentEnergy, meterThisPeriod * LINEAR_CONSUMPTION_METER_UNITS));
}
     
function updateEnergyDisplay(consumptionThisPeriod, currentEnergy) {
    var scaledConsumption = (consumptionThisPeriod / LINEAR_CONSUMPTION_METER_UNITS) / MAX_STRENGTH;
    energyBarLinearProgress.progress = scaledConsumption;
    energy.innerText = formatCredits(currentEnergy);
}

function gotoHash() {
    const hash = location.hash;
    function is(nav) { return nav === hash; }
    function setSheet(nav, sheet) { const should = is(nav); if (should !== sheet.open) sheet.open = should; }
    function doDialog(nav, dialog) { is(nav) ? setTimeout(_ => dialog.open(),100) : dialog.close(); }
    setSheet('#navigation', appdrawerDrawer);
    setSheet('#profile', profileMenu);
    doDialog('#energy', creditsDialog);
    doDialog('#notImplementedIndependent', notImplementedIndependentDialog);
    doDialog('#notImplementedDependent', notImplementedDependentDialog);
    doDialog('#mustRegister', mustRegisterDialog);
    doDialog('#share', shareDialog);
    doDialog('#privacy', privacyDialog);
    doDialog('#destinationGuide', destinationGuideDialog);
    if (is('#registration')) {
        openRegistration()
    } else if (is('#changeInfo')) {
        openRegistration(true);
    } else {
        closeRegistration();
    }
    switch (location.hash) {
    case '#energy':
        energyAmount.innerText = formatCredits(EnergyMeter.instance.currentEnergy); // FIXME: Make more stand-alone, through an "on open" handler.
        break;
    case '#login':
        callLogIn().then(_ => location.hash = '');
        break;
    case '#logout':
        logOut({preventSilentAccess: true})
            .then(_ => location.hash = '');
        break;
    case '#createDemoLink':
        createInvite({id: fixmeDemoFollowId, password: fixmeDemoFollowId, energy: 20, followers: 100}).then(link => {
            demoLink.href = new URL(link, location.href);
            demoLink.innerText = demoHostPosition;
            location.hash = '';
        });
        break;
    case '#demo1':
        moveHost({x: 100, y: 100}, "demo link to position 1");
        break;
    case '#demo2':
        moveHost({x: 2000, y: 2000}, "demo link to position 2");
        break;
    case '#toggleTalking':
        toggleMuted();
        location.hash = '';
        break;
    case '#destinationGuide':
        guide.blur();
        break;
    }
}
async function moveHost(location, label) {
    // We want to move a usr who is not us - not something that a real app would need to do.
    // So this is pretty kludgy. First, we rely on updateUserStats() to not require password.
    // But that sets the current energy to the value for THAT user, so we'll want to set it back.
    var oldEnergy = EnergyMeter.instance.currentEnergy;
    await updateUserStats({id: fixmeDemoFollowId, location});
    EnergyMeter.instance.currentEnergy = oldEnergy;
    demoHostPosition = label;
    location.hash = '';
}
var demoHostPosition = "demo link to position 1";

// GLOBALS

// These would be declared differently with webpack, but still the same constants.
const MDCTopAppBar = mdc.topAppBar.MDCTopAppBar;
const MDCRipple = mdc.ripple.MDCRipple;
const MDCDrawer = mdc.drawer.MDCDrawer;
const MDCDialog = mdc.dialog.MDCDialog;
const MDCMenu = mdc.menu.MDCMenu;
const MDCList = mdc.list.MDCList;
const MDCSelect = mdc.select.MDCSelect;
const MDCTextField = mdc.textField.MDCTextField;
const MDCTextFieldIcon = mdc.textField.MDCTextFieldIcon;
const MDCTextFieldHelperText = mdc.textField.MDCTextFieldHelperText;
const MDCFloatingLabel = mdc.floatingLabel.MDCFloatingLabel;
const MDCNotchedOutline = mdc.notchedOutline.MDCNotchedOutline;
const MDCLinearProgress = mdc.linearProgress.MDCLinearProgress
const MDCSnackbar = mdc.snackbar.MDCSnackbar;

// UI INITIALIZATION

const topbarTopAppBar = new MDCTopAppBar(topbar);
const topbarRipple = new MDCRipple(topbar);
const navigationButonRipple = new MDCRipple(navigationButton);
const copyUrlRipple = new MDCRipple(copyUrl);
const appdrawerDrawer = new MDCDrawer(appdrawer);
const privacyDialog = new MDCDialog(privacy);
const shareDialog = new MDCDialog(share);
const destinationGuideDialog = new MDCDialog(destinationGuide);
const notImplementedIndependentDialog = new MDCDialog(notImplementedIndependent);
const notImplementedDependentDialog = new MDCDialog(notImplementedDependent);
const mustRegisterDialog = new MDCDialog(mustRegister);
const creditsDialog = new MDCDialog(credits);
const webcamDialog = new MDCDialog(webcam);
const profileRipple = new MDCRipple(profile);
const profileMenu = new MDCMenu(profilemenu);
const guideRipple = new MDCRipple(guide);

const energyBarLinearProgress = new MDCLinearProgress(energyBar);

const loggedOutSnackbar = new MDCSnackbar(loggedOut);
const changedSnackbar = new MDCSnackbar(changed);
const signingInSnackbar = new MDCSnackbar(signingIn);
const arrivedSnackbar = new MDCSnackbar(arrived);
const registrationFailSnackbar = new MDCSnackbar(registrationFail);

if (!window.speechSynthesis) alert('This browser does not support speech!');
if (!navigator.mediaDevices) alert('This browser does not support webcams!');
if ((location.protocol !== 'https:') && (location.hostname !== 'localhost')) alert('You must use https, not http!');

[
    [notImplementedIndependentDialog, 'MDCDialog:closed', '#notImplementedIndependent'],
    [notImplementedDependentDialog, 'MDCDialog:closed', '#notImplementedDependent'],
    [mustRegisterDialog, 'MDCDialog:closed', '#mustRegister'],
    [privacyDialog, 'MDCDialog:closed', '#privacy'],
    [shareDialog, 'MDCDialog:closed', '#share'],
    [destinationGuideDialog, 'MDCDialog:closed', '#destinationGuide'],
    [creditsDialog, 'MDCDialog:closed', '#energy'],    
    [profileMenu, 'MDCMenuSurface:closed', '#profile']
].forEach(([element, event, from, to = '']) => element.listen(event, _ => goIf(from, to)));

webcamDialog.listen('MDCDialog:closed', abandonFace);
destinationGuideDialog.listen('MDCDialog:closed', ({detail}) => (detail.action === 'yes') && RegistrationStatus.instance.teleport());
appdrawerDrawer.listen('MDCDrawer:closed', onAppdrawerClosed);
creditsDialog.listen('MDCDialog:opened', _ => {
    const fields = instantiateFields(credits);
    const lists = instantiateAndLayoutLists(credits);
});
shareDialog.listen('MDCDialog:opened', _ => {
    const fields = instantiateFields(share);
    const lists = instantiateAndLayoutLists(share);
    const href = new URL(location.href);
    href.hash = '';
    href.searchParams.delete('invite');
    showQR(href.href);
});
topbarTopAppBar.listen('MDCTopAppBar:nav', _ => location.hash = 'navigation');
loggedOutSnackbar.listen('MDCSnackbar:closed', ({detail}) => {
    if (detail.reason === 'action') location.hash = 'login';
});
nFollowers.onchange = followerCredits.onchange = _ => inviteTotal.innerText = parsedNFollowers() * parsedFollowerCredits();

[
    [profile, 'profile'],
    [guide, 'destinationGuide'],
    [energyBar, 'energy']
].forEach(([element, hash]) => element.addEventListener('click', _ => location.hash = hash));
[
    [passwordVisibility, togglePasswordVisibility],
    [faceCamera, showFaceResult],
    [face, showFaceResult],
    [forgetMe, callUnregister],
    [copyUrl, onCopyUrl],
    [buyEnergy__list, _ => {!RegistrationStatus.id() && (location.hash = 'registration');}],
    [registrationForm, onRegistrationSubmit, 'submit'],
    [share__form, onShareSubmit, 'submit'],
    [buyEnergy, onBuyEnergy, 'submit'],
    [window, gotoHash, 'hashchange']
].forEach(([element, operation, event = 'click']) => element.addEventListener(event, operation));

const initialSetUp = configure({
    updateEnergyDisplay, getConsumption, accountsUrl:ACCOUNTS,
    onRegistrationStatusChange, onUserData
}).then(callLogIn);
gotoHash();
