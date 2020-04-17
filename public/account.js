'use strict';

/* This file has the following sections (which could, of course, be split into multiple files).
   APPLICATION LOGIC - independent of the UI
   UI LOGIC          - references UI elements (e.g., defined by id in the .html)
   GLOBALS           - UI constants whose initialization would be different with webpack, etc.
   UI INITIALIZATION - MDC object instantiation, and setting event handlers
 */

// APPLICATION LOGIC

function getDb(key) {
    const value = localStorage.getItem(key); // FIXME use indexedDB
    if (value === undefined) return value;
    return JSON.parse(value);
}
function removeDb(key) {
    localStorage.removeItem(key);
}
function setDb(key, value) {
    localStorage.setItem(key, JSON.stringify(value)); // FIXME use indexedDB
}
function setDbSubkey(key, subkey, value) {
    const hash = getDb(key) || {};
    hash[subkey] = value;
    setDb(key, hash);
}
function pushDbIfNew(key, value) {
    const array= getDb(key) || [];
    if (array.includes(value)) return;
    array.push(value);
    setDb(key, array);
}
function getIds() {
    return getDb('ids') || [];
}
function storeLocalCredential(credential) {
    setDbSubkey(credential.id, 'iconURL', credential.iconURL);
    setDbSubkey(credential.id, 'name', credential.name);
    pushDbIfNew('ids', credential.id);
}

const dbVersion = 5;
if ((getDb('version') || 0) < dbVersion) {
    console.warn('Clearing local db.');
    localStorage.clear();
    setDb('version', dbVersion);
}

function service(url, data, defaultProperties = {}) {
    return fetch(url, {
        method: 'post',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
    })
        .then(response => response.json())
        .then(json => {console.log('server:', json); return json.error
              ? Promise.reject(new Error(json.error))
                       : Object.assign(defaultProperties, json)});
}

var isRegistered = false;

function unregisteredLogin() {
    // FIXME: do we have what we need in cookies? Do we need to contact the server again?
    setRegistered(false);
    return service('/login', {}, {  // UI should still work on failure.
        iconURL: "images/anonymous.jpg",
        name: "anonymous"
    });
}
function passwordLogin({id, password, name, iconURL}) {
    // Get decription key and update keys. Else reject.
    return service('/login', {id, password}, {iconURL, name, id, password})
}
function createOrUpdateRegistration(options) { // on server
    return service('/registration', options, options);
}
function handleSuccessfulLogin(user) {
    console.log('login result: FIXME update and merge', user);
    if (!user) return Promise.resolve();
    if (user.id) {
        function last(list) { return list[list.length - 1]; }
        let changes = [], email = last(user.emails), face = last(user.faces);
        function noteNew(newValue, key, label = key) {
            if (user[key] !== newValue) {
                if (label) changes.push(label);
                user[key] = newValue;
                return true;
            }
        }
        if (noteNew(email, 'id', 'email')) removeDb(user.id); // storeCredentials will restore.
        noteNew(user.displayName, 'name');
        noteNew(face, 'iconURL', false);
        // We can't make note of a new password, and we don't need to.
        noteChanges(changes);
    }
    setRegistered(user.id); // counting on user.id being falsey for unregistered users
    setupUser(user);
    setInterval(updateEnergy, 200);
    // FIXME: update keystore if needed
    if (!user.id) return user;
    return storeCredentials(user).then(_ => user);
}
function storeCredentials(options) {
    // We don't get to ask navigator.credentials how many accounts there are, or what their names/icons are,
    // so store them ourselves as well.
    storeLocalCredential(options);
    return setCredential(options);
}
function register(options) {
    return createOrUpdateRegistration(options)
        .then(handleSuccessfulLogin)
        .then(_ => setRegistered(options.id))
        .then(_ => location.hash = '');
}
function logOut({preventSilentAccess, notify} = {preventSilentAccess: false, notify: true}) {
    console.log('logOut: preventSilentAccess =', preventSilentAccess, 'notify =', notify);
    return unregisteredLogin()
        .then(handleSuccessfulLogin)
        .then(_ => location.hash = '')
        .then(_ => preventSilentAccess && preventSilentCredentialAccess())
        .then(_ => notifyLoggedOut(notify));
}

// There are two password-based login cycles to cover:
// 1. Ordinary login, starting with assumed credentials from getCredential 
//    If supported by the browser, getCredential will do the right thing: ask the user to actively select
//    a profile (with no password) if explicitly logged out, or if more than one to chose from. Otherwise
//    just do it and notify.
// 2. Before updating the user's (server-based) profile, starting with just an id
//    In this case, we DO want to ask for a password, labeled by a specific profile,
//    and we do NOT want to pick between profiles (which can happen with getCredential).
// In either case, we want to process the login results. But if the login fails (in either case), we want to let
// the password-request repeat (as in (2),) until success, or just ensure logOut if the user gives up.
function passwordLoginIf(credential) {
    if (!credential || (credential.type !== 'password')) return Promise.resolve();
    return passwordLogin(credential);
}
function confirmPassword(id, e = null) { // case 2, above
    if (e) console.warn(e);
    return gatherCredentialWithPassword([id], {
        forcePassword: true,
        forceDialog: true,
        label: "Confirm",
        message: e && e.message
    })
        .then(passwordLoginIf)
        .catch(e => confirmPassword(id, e))
}
function handleLoginResult(result, notify = false) {
    console.log('handleLoginResult', result, notify);
    if (result) return handleSuccessfulLogin(result);
    return logOut({preventSilentAccess: false, notify: notify});
}
function logIn() { // case 1, above, followed by handleLoginResults
    var id;
    return getCredential({
        password: true,
        mediation: "optional"
    })
        .then(credential => {
            id = credential && credential.id;
            return credential;
        })
        .then(passwordLoginIf)
        .catch(e => confirmPassword(id, e))
        .then(handleLoginResult);
}
const DELETED_CREDENTIAL_PROPERTY_VALUE = 'deleted';
async function unregister() {
    await initialSetUp;
    const id = isRegistered;
    if (!id) return console.error('unregister should only be enabled for registered users.');
    confirmPassword(id).then(credential => {
        if (!credential) return;
        service('/delete', credential)
        // We cannot delete from browser credentials, but we can render them obvious.
            .then(_ => setCredential({id, password: DELETED_CREDENTIAL_PROPERTY_VALUE,
                                      name: DELETED_CREDENTIAL_PROPERTY_VALUE}))
            .then(_ => removeDb(id))
            .then(_ => setDb('ids', getIds().filter(e => e !== id)))
            .catch(console.error) // FIXME: do better
            .then(_ => logOut({preventSilentAccess: true, notify: true}))
    });
}

// UI LOGIC

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
    instantiateDescendents(ancestor, '.mdc-floating-label', MDCFloatingLabel)
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
    message = ''}) {
    // FIXME: display message, if any (e.g., that the password entered was wrong)
    function getIconElement(avatar) { return avatar.querySelector('img'); }
    function getNameElement(avatar) { return avatar.querySelector('.mdc-list-item__primary-text'); }
    function getIdElement(avatar) { return avatar.querySelector('.mdc-list-item__secondary-text'); }
    const passwords = STORE_PASSWORDS && !forcePassword && [];
    if (!passwords && ids.length) forceDialog = true;
    var credential = {}, cleanup;
    console.log('gatherCredentialsWithPasswords', ids, 'dialog:', forceDialog, 'password:', forcePassword,
                'passwords:', passwords, 'label/message:', label, message);

    // Two cases where we bail early.
    if (!ids.length) return;
    if ((ids.length === 1) && !forceDialog) { // No need for dialog. Just a snackbar notification.
        const cred = getDb(ids[0]);
        cred.id = signingIn__secondary.innerHTML = ids[0];
        signingInSnackbar.open()
        return cred;
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
            const data = getDb(id);
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
            logOut({preventSilentAccess: false, notify: true});
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

// The PasswordCredential API is not implemented in Safari or Firefox yet.
// This uses the API when available, otherwise we recreate the same API, with similar UI.
function browserHasPasswordCredentialStore() {
    return 'PasswordCredential' in window;
}
function reconcileLocalStorage(credential) {
    // If a native navigator.credentials produces a credential that isn't in or local storage, add it.
    // That way it will be available for password confirmation.
    if (!credential) return;
    if (!getDb(credential.id)) storeLocalCredential(credential);
    return credential;
}
function filterDeletedCredential(credential) {
    // Don't allow credentials of accounts that have been deleted by the user.
    if (!credential) return;
    if (credential.name === DELETED_CREDENTIAL_PROPERTY_VALUE) return;
    return credential;
}

const PREVENT_SILENT_KEY = 'preventSilentAccess';
async function getCredential(options) {
    if (browserHasPasswordCredentialStore()) {
        return navigator.credentials.get(options)
            .then(filterDeletedCredential)
            .then(reconcileLocalStorage);
    } // Fake our own.
    if (!options.password || options.mediation !== "optional") {
        return Promise.reject(`Unsupported credential options: ${JSON.stringify(options)}.`);
    }
    var availableIdentities = getIds(),
        force = getDb(PREVENT_SILENT_KEY),
        credential = await gatherCredentialWithPassword(availableIdentities,
                                                        {forceDialog: force});
    if (credential) {
        setDb(PREVENT_SILENT_KEY, false);
        credential.type = 'password';
        return credential;
    }
}
function setCredential(credential) {
    if (browserHasPasswordCredentialStore()) {
        // The spec (and mozilla.org) says the following,
        // but the W3C examples say new PasswordCredential(options). Old?
        // Anyway, testing for the existence of the PasswordCredential class seems to work.
        return navigator.credentials
            .create({password: credential})
            .then(cred => navigator.credentials.store(cred));
    } // Fake our own.
    if (!credential.password) {
        return Promise.reject(`Unsupported credential options: ${JSON.stringify(credential)}.`);
    }
    // The caller, storeCredentials, has saved id, name, and iconURL. For now, we also save
    // password here, for use with STORE_PASSWORDS true. FIXME: if we decide to use the
    // STORE_PASSWORDS false case, this line should be removed.
    setDbSubkey(credential.id, 'password', credential.password); // see fixme in getCredential
    return Promise.resolve();
}
function preventSilentCredentialAccess() {
    if (browserHasPasswordCredentialStore()) {
        return navigator.credentials.preventSilentAccess();
    }
    setDb(PREVENT_SILENT_KEY, true);
    return Promise.resolve();
}

function notifyLoggedOut(notify) {
    if (!notify) return;
    loggedOutSnackbar.open();
}
function noteChanges(changes) {
    if (!changes.length) return;
    changed__secondary.innerText = (changes.length > 1)
        ? changes.slice(0, -1).join(', ') + ' and ' + changes[changes.length - 1]
        : changes[0];
    changedSnackbar.open();
}

function setRegistered(id) {
    isRegistered = id;
    forgetMe.disabled = !id;
    const disabled = 'mdc-list-item--disabled';
    if (id) {
        body.classList.add('registered');
        registerItem.classList.add(disabled);
        loginItem.classList.add(disabled);        
        logoutItem.classList.remove(disabled);
    } else {
        body.classList.remove('registered');
        registerItem.classList.remove(disabled);
        if (getIds().length) {
            loginItem.classList.remove(disabled);
        } else {
            loginItem.classList.add(disabled);
        }
        logoutItem.classList.add(disabled);
    }
}
function setupUser(credential) {
    profile__image.src = profilemenu__image.src = credential.iconURL;
    profilemenu__name.innerText = credential.name;
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
    register({
        id: email.value,
        oldEmail: oldEmail.value,
        oldPassword: oldPassword.value,
        name: displayName.value,
        iconURL: face.value,
        password: password.value
    });
}
function onBuyEnergy(e) {
    e.preventDefault();
    // FIXME increase energy
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
    if (face.value) {
        face.classList.add('transparent');
        face__image.classList.remove('hidden');
    } else {
        face.classList.remove('transparent');
        face__image.classList.add('hidden');
    }
}
function showFaceResult(e) {
    if (e) e.preventDefault();

    if (!face.value && !isRegistered) face.value = new URL("images/profile-1.jpeg", location.href).href;
    // FIXME: open camera, etc. For now, skipping that and showing a hardcoded result:

    updateFaceResult();
    face.blur();
    // FIXME: also put a transparent mask over input to block clicks so that no one messes up the text
}

var currentRegistrationDialog;
function closeRegistration() { currentRegistrationDialog && currentRegistrationDialog.close(); }
async function openRegistration() {
    var credential = {};
    await initialSetUp;
    if (isRegistered) {
        credential = await confirmPassword(isRegistered).then(handleLoginResult);
    }
    if (!credential) return;
    openDialog(registration, dialog => {
        face.value = credential.iconURL || '';
        displayName.value = credential.name || '';
        oldEmail.value = email.value = credential.id || '';
        oldPassword.value = password.value = credential.password || '';
        register__submit.value = isRegistered ? "Update" : "Register";
        const fields = instantiateFields(registration);
        const lists = instantiateAndLayoutLists(registration);
        if (face.value) {
            showFaceResult();
        } else {
            updateFaceResult();
        }
        currentRegistrationDialog = dialog;
        dialog.listen('MDCDialog:closed', _ => {
            currentRegistrationDialog = null;
            goIf('#registration');
        });
    });
}
const ENERGY_TIME = 5 * 60 * 1000;
const energyStart = Date.now();
const consumptionBuffer = Array(5).fill(0);
var currentEnergy = 1;
function average(array) {
    return array.reduce((acc, amount) => acc + amount, 0) / array.length;
}
function updateEnergy() {
    energyBarLinearProgress.buffer = currentEnergy = 1 - ((Date.now() - energyStart) / ENERGY_TIME);
    consumptionBuffer.shift();
    consumptionBuffer.push(0.75 * Math.random());
    energyBarLinearProgress.progress = average(consumptionBuffer);
}
function gotoHash(x) {
    const hash = location.hash;
    function is(nav) { return nav === hash; }
    function setSheet(nav, sheet) { const should = is(nav); if (should !== sheet.open) sheet.open = should; }
    function doDialog(nav, dialog) { is(nav) ? setTimeout(_ => dialog.open(),100) : dialog.close(); }
    setSheet('#navigation', appdrawerDrawer);
    setSheet('#profile', profileMenu);
    doDialog('#energy', creditsDialog);
    doDialog('#notImplementedIndependent', notImplementedIndependentDialog);
    doDialog('#notImplementedDependent', notImplementedDependentDialog);
    doDialog('#privacy', privacyDialog);
    is('#registration') ? openRegistration() : closeRegistration();
    switch (location.hash) {
    case '#energy':
        energyAmount.innerText = Math.round(currentEnergy * 100).toFixed();
        break;
    case '#login':
        logIn();
        location.hash = '';
        break;
    case '#logout':
        logOut({preventSilentAccess: true, notify: false});
        break;
    }
}


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
const appdrawerDrawer = new MDCDrawer(appdrawer);
const privacyDialog = new MDCDialog(privacy);
const notImplementedIndependentDialog = new MDCDialog(notImplementedIndependent);
const notImplementedDependentDialog = new MDCDialog(notImplementedDependent);
const creditsDialog = new MDCDialog(credits);
const profileRipple = new MDCRipple(profile);
const profileMenu = new MDCMenu(profilemenu);

const buyEnergyList = new MDCList(buyEnergy__list);

const selectedCardTextField = new MDCTextField(selectedCard__label);
const selectedCardNotchedOutline = new MDCNotchedOutline(selectedCard__outline);
const selectedCardFloatingLabel = new MDCFloatingLabel(selectedCard__floatingLabel);

const purchaseAmountTextField = new MDCTextField(purchaseAmount__label);
const purchaseAmountNotchedOutline = new MDCNotchedOutline(purchaseAmount__outline);
const purchaseAmountFloatingLabel = new MDCFloatingLabel(purchaseAmount__floatingLabel);

const energyBarLinearProgress = new MDCLinearProgress(energyBar);

const loggedOutSnackbar = new MDCSnackbar(loggedOut);
const changedSnackbar = new MDCSnackbar(changed);
const signingInSnackbar = new MDCSnackbar(signingIn);

[
    [notImplementedIndependentDialog, 'MDCDialog:closed', '#notImplementedIndependent'],
    [notImplementedDependentDialog, 'MDCDialog:closed', '#notImplementedDependent'],
    [privacyDialog, 'MDCDialog:closed', '#privacy'],
    [creditsDialog, 'MDCDialog:closed', '#energy'],
    [profileMenu, 'MDCMenuSurface:closed', '#profile']
].forEach(([element, event, from, to = '']) => element.listen(event, _ => goIf(from, to)));


appdrawerDrawer.listen('MDCDrawer:closed', onAppdrawerClosed);
topbarTopAppBar.listen('MDCTopAppBar:nav', _ => location.hash = 'navigation');
loggedOutSnackbar.listen('MDCSnackbar:closed', ({detail}) => {
    if (detail.reason === 'action') location.hash = 'login';
});

[
    [profile, 'profile'],
    [energyBar, 'energy']
].forEach(([element, hash]) => element.addEventListener('click', _ => location.hash = hash));
[
    [passwordVisibility, togglePasswordVisibility],
    [faceCamera, showFaceResult],
    [face, showFaceResult],
    [forgetMe, unregister],
    [registrationForm, onRegistrationSubmit, 'submit'],
    [buyEnergy, onBuyEnergy, 'submit'],
    [window, gotoHash, 'hashchange']
].forEach(([element, operation, event = 'click']) => element.addEventListener(event, operation));

const initialSetUp = logIn();
gotoHash(99);
