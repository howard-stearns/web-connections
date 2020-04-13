'use strict';

// These would be different with webpack.
const MDCTopAppBar = mdc.topAppBar.MDCTopAppBar;
const MDCRipple = mdc.ripple.MDCRipple;
const MDCDrawer = mdc.drawer.MDCDrawer;
const MDCDialog = mdc.dialog.MDCDialog;
const MDCMenu = mdc.menu.MDCMenu;
const MDCList = mdc.list.MDCList;
const MDCTextField = mdc.textField.MDCTextField;
const MDCTextFieldIcon = mdc.textField.MDCTextFieldIcon;
const MDCTextFieldHelperText = mdc.textField.MDCTextFieldHelperText;
const MDCFloatingLabel = mdc.floatingLabel.MDCFloatingLabel;
const MDCNotchedOutline = mdc.notchedOutline.MDCNotchedOutline;
const MDCLinearProgress = mdc.linearProgress.MDCLinearProgress

if (!('credentials' in navigator)) alert('Browser does not support credentials!');

var isRegistered = false;

function ensureUnregisteredLogin() {
    // FIXME: do we have what we need in cookies? Do we need to contact the server again?
    return Promise.resolve({
        iconURL: "images/anonymous.png",
        name: "Teal-raptor-1234" // FIXME
    });
}

function passwordLogin({id, password, name, iconURL}) {
    // Get decription key and update keys. Else reject.
    console.info(`Pretending to login '${id}' / '${password}'.`);
    setRegistered(true);
    return Promise.resolve({iconURL, name, id, password});
}

function ensureCredentials() {
    return navigator.credentials.get({
        password: true,
        mediation: "optional"
    }).then(credential => {
        console.log('stored credentials are:', credential);
        if (!credential) return ensureUnregisteredLogin();
        if (credential.type) {
            return passwordLogin(credential);
        }
        const message = `Unrecognized credential type ${credential.type}.`;
        return Promise.reject(message);
    });
}
function createOrUpdateRegistration(options) { // on server
    return Promise.resolve(options); // FIXME
}
function handleLogin(keysAndSuch) {
    return setupUser(keysAndSuch); // FIXME: update keystore if needed
}
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

function storeCredentials(options) {
    console.log('options:', options);
    // We don't get to ask navigator.credentials how many accounts there are, or what their names/icons are,
    // so store them ourselves as well.
    setDbSubkey(options.id, 'iconURL', options.iconURL);
    pushDbIfNew('ids', options.id);
    navigator.credentials
    // The spec (and mozilla.org) says the following,
    // but the W3C examples say new PasswordCredential(options). Old?
        .create({password: options})
        .then(cred => {
            console.log('credentials:', cred);
            return navigator.credentials.store(cred);
        });
}

function register(options) {
    return createOrUpdateRegistration(options)
        .then(handleLogin)
        .then(storeCredentials)
        .then(_ => location.hash = '');
}

const topbarTopAppBar = new MDCTopAppBar(topbar);
const topbarRipple = new MDCRipple(topbar);
const navigationButonRipple = new MDCRipple(navigationButton);
const appdrawerDrawer = new MDCDrawer(appdrawer);
const notImplementedIndependentDialog = new MDCDialog(notImplementedIndependent);
const notImplementedDependentDialog = new MDCDialog(notImplementedDependent);
const creditsDialog = new MDCDialog(credits);
const registrationDialog = new MDCDialog(registration);
const profileRipple = new MDCRipple(profile);
const profileMenu = new MDCMenu(profilemenu);

const loginPrivateList = new MDCList(loginPrivate__list);
const loginPublicList = new MDCList(loginPublic__list);

const emailTextField = new MDCTextField(email__label);
const emailNotchedOutline = new MDCNotchedOutline(email__outline);
const emailFloatingLabel = new MDCFloatingLabel(email__floatingLabel);

const passwordTextField = new MDCTextField(password__label);
const passwordNotchedOutline = new MDCNotchedOutline(password__outline);
const passwordFloatingLabel = new MDCFloatingLabel(password__floatingLabel);

const faceTextField = new MDCTextField(face__label);
const faceNotchedOutline = new MDCNotchedOutline(face__outline);
const faceFloatingLabel = new MDCFloatingLabel(face__floatingLabel);

const buyEnergyList = new MDCList(buyEnergy__list);

const selectedCardTextField = new MDCTextField(selectedCard__label);
const selectedCardNotchedOutline = new MDCNotchedOutline(selectedCard__outline);
const selectedCardFloatingLabel = new MDCFloatingLabel(selectedCard__floatingLabel);

const purchaseAmountTextField = new MDCTextField(purchaseAmount__label);
const purchaseAmountNotchedOutline = new MDCNotchedOutline(purchaseAmount__outline);
const purchaseAmountFloatingLabel = new MDCFloatingLabel(purchaseAmount__floatingLabel);

const displayNameTextField = new MDCTextField(displayName__label);
const displayNameNotchedOutline = new MDCNotchedOutline(displayName__outline);
const displayNameFloatingLabel = new MDCFloatingLabel(displayName__floatingLabel);

const energyBarLinearProgress = new MDCLinearProgress(energyBar);

function setRegistered(on) {
    isRegistered = on;
    if (on) {
        body.classList.add('registered');
    } else {
        body.classList.remove('registered');
    }
}
function setupUser({iconURL, name, id, password:savedPassword}) {
    face.value = profile__image.src = profilemenu__image.src = iconURL;
    displayName.value = profilemenu__name.innerText = name;
    email.value = id;
    password.value = savedPassword;

    // Update which menu items are enabled.
    if ((getDb('ids') || []).length > 1) {
        switchUsers.classList.remove('mdc-list-item--disabled');
    }
    return {iconURL, name, id, password:savedPassword};
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
    if (password.type === 'password') {
        password.type = 'text';
        passwordVisibility.innerText = "visibility_off"
    } else {
        password.type = 'password';
        passwordVisibility.innerText = "visibility"
    }
}
function showFaceResult(e) {
    e.preventDefault();
    // FIXME: open camera, etc. For now, skipping that and showing a hardcoded result:
    const url = new URL("images/profile-2.jpeg", location.href).href; // FIXMEn
    faceTextField.focus();
    face.classList.add('transparent');
    face__image.src = face.value = url;
    face__image.classList.remove('hidden');
    face.blur();
    // FIXME: also put a transparent mask over input to block clicks so that no one messes up the text
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
        setTimeout(_ => registrationDialog.open(), 100);
        break;
    case '#energy':
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
    case '':
    case '#':
        appdrawerDrawer.open = false;
        notImplementedIndependentDialog.close();
        notImplementedDependentDialog.close();
        registrationDialog.close();
        break;
    default:
        console.warn(`Unrecognized fragment identifier '${location.hash}'.`);
        location.hash = 'notImplementedDependent';
    }
}

topbarTopAppBar.listen('MDCTopAppBar:nav', _ => location.hash = 'navigation');
profileMenu.listen('MDCMenuSurface:closed', _ => (location.hash === '#profile') && (location.hash = ''));
notImplementedIndependentDialog.listen('MDCDialog:closed', _ => location.hash = '');
notImplementedDependentDialog.listen('MDCDialog:closed', _ => location.hash = '');
registrationDialog.listen('MDCDialog:closed', _ => location.hash = '');
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
// Go ahead and log in!
ensureCredentials()
    .catch(console.error)
    .then(setupUser)

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
