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

var isRegistered = false;

function unregisteredLogin() {
    // FIXME: do we have what we need in cookies? Do we need to contact the server again?
    setRegistered(false);
    return Promise.resolve({
        iconURL: "images/anonymous.jpg",
        name: "Teal-raptor-1234" // FIXME
    });
}
function passwordLogin({id, password, name, iconURL}) {
    // Get decription key and update keys. Else reject.
    console.info(`Pretending to login '${id}' / '${password}'.`);
    setRegistered(id);
    return Promise.resolve({iconURL, name, id, password});
}
function createOrUpdateRegistration(options) { // on server
    return Promise.resolve(options); // FIXME
}
function handleSuccessfulLogin(keysAndSuch) {
    return Promise.resolve(setupUser(keysAndSuch)); // FIXME: update keystore if needed
}
function storeCredentials(options) {
    console.log('options:', options);
    // We don't get to ask navigator.credentials how many accounts there are, or what their names/icons are,
    // so store them ourselves as well.
    setDbSubkey(options.id, 'iconURL', options.iconURL);
    setDbSubkey(options.id, 'name', options.name);
    pushDbIfNew('ids', options.id);
    return setCredential(options);
}
function register(options) {
    return createOrUpdateRegistration(options)
        .then(handleSuccessfulLogin)
        .then(storeCredentials)
        .then(_ => setRegistered(options.id))
        .then(_ => location.hash = '');
}
function logOut() {
    preventSilentCredentialAccess()
        .then(unregisteredLogin)
        .then(handleSuccessfulLogin);
}
function ensureCredentials() {
    return getCredential({
        password: true,
        mediation: "optional"
    })
        .catch(e => {console.error(e);})
        .then(credential => {
            console.log('stored credentials are:', credential);
            if (!credential) return unregisteredLogin();
            if (credential.type) {
                return passwordLogin(credential);
            }
            const message = `Unrecognized credential type ${credential.type}.`;
            return Promise.reject(message);
        });
}
function logIn() {
    ensureCredentials()
        .catch(console.error)
        .then(handleSuccessfulLogin)
}

// UI LOGIC

// FIXME: there are a couple of places where we should be doing MDCList.layout, but aren't. Should we use this?
function openDialog(dialogDomElement, onOpen=null) { // Answer a promise that resolves to the action taken
    const dialog = new MDCDialog(dialogDomElement);
    return new Promise(resolve => {
        if (onOpen) dialog.listen('MDCDialog:opened', _ => onOpen(dialog));
        dialog.listen('MDCDialog:closed', event => resolve(event.detail.action));
        dialog.open();
    });
}

function mapSelectedElements(ancestor, selector, callback) {
    ancestor.querySelectorAll(selector).forEach(callback);
}
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
/*
Given a list of one or more credential ids,
present the user with the credentials, and
require the user to enter the password for the selected credential.
Return the selected, completed credential, or falsey if the user cancels.

Requires that getDb(id) produce {id, name, iconURL}.

This is used in two circumstances:

1. It implements the credentials.get UI for browsers that do not implement PasswordCredential.
   That is, pick from among multiple credentials, or at least be made aware of the one stored credential being used.

   In browsers that implement PasswordCredential, the password may be stored with everything else, where
   it can be be reviewed and deleted by anyone with OS admin access to the browser.
   While we store the {id, name, iconURL} in local site storage (getDb), we don't want to be responsible 
   for storing passwords in such "plain sight". So we provide a password input field for the user to do so.
   IFF the user has previously saved the password with browser, AND forceConfirmation is not truthy,
   then we do allow this field to be autocompleted by the browser. (Otherwise, the user will have to type it.)

   Note that in cases where the password is autocompleted, the UI is nearly identical to that of the
   Chrome implementation of PasswordCredential, except:
    a. There is this extra password field that the user has to click in to autofill.
    b. In the special (but common) case of a single id, Chrome merely tells the user of the use of 
       that credential in a passing snackbar, rather than a modal dialog. We don't have that option because of (a).

2. Regardless of whether the user experience the above on startup, or used a native PasswordCredential, we
   force the user to enter their (old) password before changing their profile. For example, they may
   have walked away from the machine without logging out, or they might not have noticed the current signin
   despite the pictures and confirmation for case (1). So before changing their profile, we force the
   user to enter their password, without autocomplete. This is the same UI as in the singlue user case (1),
   because we want the user to be aware of the name, picture, and email that they are entering a password for.
*/ 
async function gatherCredentialWithPassword(ids, forceConfirmation = false, label = "Sign in") {
    function getIconElement(avatar) { return avatar.querySelector('img'); }
    function getNameElement(avatar) { return avatar.querySelector('.mdc-list-item__primary-text'); }
    function getIdElement(avatar) { return avatar.querySelector('.mdc-list-item__secondary-text'); }
    var credential = {};
    selectUser__context.innerText = label;
    const confirmation = await openDialog(selectUser, dialog => {
        const password = document.importNode(selectUserTemplate.content.lastElementChild, true),
              passwordIndex = ids.length,
              visibility = password.querySelector('button'),
              input = password.querySelector('input'),
              accept = selectUser.querySelector('button[data-mdc-dialog-action="yes"]');
        accept.querySelector('.mdc-button__label').innerText = label;
        function setCredential(index) {
            const selected = selectUser__list.children[index];
            credential = {
                id: getIdElement(selected).innerText,
                name: getNameElement(selected).innerText,
                iconURL: getIconElement(selected).src,
                password: input.value,
            };
        }
        // Populate the users to select from.
        selectUser__list.innerHTML = '';
        ids.forEach(id => {
            const {name, iconURL} = getDb(id);
            const avatar = document.importNode(selectUserTemplate.content.firstElementChild, true);
            getIconElement(avatar).src = iconURL;
            getNameElement(avatar).innerText = name;
            getIdElement(avatar).innerText = id;
            new MDCRipple(avatar);
            selectUser__list.appendChild(avatar);
        });
        visibility.onclick = togglePasswordVisibility;
        input.oninput = e => {
            accept.disabled = !credential.id;
            credential.password = e.target.value;
        }
        accept.disabled = true;
        if (forceConfirmation) {
            // Hmmm. MDN says this is bad, and indeed browsers don't listen to this for password fields
            // presumably because they want long passwords that no one can type. But then,
            // how do you avoid letting everyone on the computer see your password???
            input.setAttribute('autocomplete', 'off');
        }
        selectUser__list.appendChild(password);
        const fields = instantiateFields(password);
        if (ids.length === 1) {
            setCredential(0);
        }
        // Initialize the MDC list.
        instantiateAndLayoutLists(selectUser);
        mdcObjects.get(selectUser__list).listen('MDCList:action', ({detail}) => {
            if (detail.index === passwordIndex) return;
            accept.disabled = !input.value;
            setCredential(detail.index);
        });
    });
    if (confirmation !== 'yes') return;
    return credential;
}

// The PasswordCredential API is not implemented in Safari or Firefox yet.
// This uses the API when available, otherwise we recreate the same API, with similar UI.
function browserHasPasswordCredentialStore() {
    return 'PasswordCredential' in window;
}
const PREVENT_SILENT_KEY = 'preventSilentAccess';
async function getCredential(options) {
    if (browserHasPasswordCredentialStore()) {
        return navigator.credentials.get(options);
    } // Fake our own.
    if (!options.password || options.mediation !== "optional") {
        return Promise.reject(`Unsupported credential options: ${JSON.stringify(options)}.`);
    }
    var availableIdentities = getIds(),
        credential = await gatherCredentialWithPassword(availableIdentities,
                                                        (getDb(PREVENT_SILENT_KEY)
                                                         || availableIdentities.length > 1));
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
    // Let's assume, for now, that the caller has already put id into ids, and set name and iconURL for id.
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


function setRegistered(id) {
    isRegistered = id;
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
    console.log('close drawer, hash:', location.hash);
    if (location.hash === "#navigation") location.hash = '';
}
function onRegistrationSubmit(e) {
    e.preventDefault();
    register({
        id: email.value,
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
    console.log('updateFaceResult', face.value, face, face__image);
}
function showFaceResult(e) {
    if (e) e.preventDefault();

    console.log('showFaceResult', e, face.value, isRegistered, face__image.src);
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
    if (isRegistered) {
        credential = await gatherCredentialWithPassword([isRegistered], true, "Confirm");
        if (!credential) return;
        await passwordLogin(credential);
    }
    openDialog(registration, dialog => {
        face.value = credential.iconURL || '';
        displayName.value = credential.name || '';
        email.value = credential.id || '';
        password.value = credential.password || '';
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
            location.hash = '';
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
function gotoHash() {
    switch (location.hash) {
    case '#notImplementedIndependent':
        appdrawerDrawer.open = false;
        setTimeout(_ => notImplementedIndependentDialog.open(), 100);
        break;
    case '#notImplementedDependent':
        appdrawerDrawer.open = false;
        setTimeout(_ => notImplementedDependentDialog.open(), 100);
        break;
    case '#registration':
        setTimeout(openRegistration, 100);
        break;
    case '#energy':
        closeRegistration();
        energyAmount.innerText = Math.round(currentEnergy * 100).toFixed();
        setTimeout(_ => creditsDialog.open(), 100);
        break;
    case '#navigation':        
        appdrawerDrawer.open = true;
        notImplementedIndependentDialog.close();
        notImplementedDependentDialog.close();
        break;
    case '#profile':
        profileMenu.open = true;
        notImplementedIndependentDialog.close();
        notImplementedDependentDialog.close();
        break;
    case '#login':
        logIn();
        location.hash = '';
        break;
    case '#logout':
        logOut();
        location.hash = '';        
        break;
    case '':
    case '#':
        appdrawerDrawer.open = false;
        notImplementedIndependentDialog.close();
        notImplementedDependentDialog.close();
        closeRegistration();
        break;
    default:
        console.warn(`Unrecognized fragment identifier '${location.hash}'.`);
        location.hash = 'notImplementedDependent';
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

// UI INITIALIZATION

const topbarTopAppBar = new MDCTopAppBar(topbar);
const topbarRipple = new MDCRipple(topbar);
const navigationButonRipple = new MDCRipple(navigationButton);
const appdrawerDrawer = new MDCDrawer(appdrawer);
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

topbarTopAppBar.listen('MDCTopAppBar:nav', _ => location.hash = 'navigation');
profileMenu.listen('MDCMenuSurface:closed', _ => (location.hash === '#profile') && (location.hash = ''));
notImplementedIndependentDialog.listen('MDCDialog:closed', _ => location.hash = '');
notImplementedDependentDialog.listen('MDCDialog:closed', _ => location.hash = '');
creditsDialog.listen('MDCDialog:closed', _ => location.hash = '');
appdrawerDrawer.listen('MDCDrawer:closed', onAppdrawerClosed);

profile.addEventListener('click', _ => location.hash = 'profile');
energyBar.addEventListener('click', _ => location.hash = 'energy');
passwordVisibility.addEventListener('click', togglePasswordVisibility);
faceCamera.addEventListener('click', showFaceResult);
face.addEventListener('click', showFaceResult);
registrationForm.addEventListener('submit', onRegistrationSubmit);
buyEnergy.addEventListener('submit', onBuyEnergy);
window.addEventListener('hashchange', gotoHash);

gotoHash();
setInterval(updateEnergy, 200);
logIn();





/*
// UNUSED STUFF
const userId = "123";
const challengeFromServer = "something with time";
function charCode(oneCharString) { return oneCharString.charCodeAt(0); }

function getCredentials() {
    navigator.credentials.get({password: true}).then(console.log);
}

function createPasswordCredentials() {
    navigator.credentials.create({
        password: { // find out about this being a form
            id: "passwordId",
            name: "passwordUsername",
            password: "passwordPassword"
        }
    }).catch(e => {
        console.error(e);
        alert(e);
    }).then(r => {
        console.log(r);
    });
}
profileMenu.listen('MDCList:action', ({detail})  => {
    switch (detail.index) {
    case 2:
        setTimeout(_ => location.hash = 'registration', 100);
        break;
    default:
        location.hash = 'notImplementedDependent';
    }
});
*/
