'use strict';

const MDCRipple = mdc.ripple.MDCRipple;
const MDCDialog = mdc.dialog.MDCDialog;


//MDCRipple.attachTo(infoButton);
const infoButtonRipple = new MDCRipple(infoButton);
infoButtonRipple.unbounded = true;
const startButtonRipple = new MDCRipple(infoButton);
const dialogDialog = new MDCDialog(infoDialog);

function initRing(circle, overallDiameter, strokeWidth, color) {    
    const parent = circle.parentElement;
    //const radius = circle.r.baseVal.value;
    const radius = (overallDiameter / 2) - (strokeWidth / 2);
    const circumference = radius * 2 * Math.PI;
    const center = parent.width.baseVal.value / 2;
    circle.dataset.circumference = circumference;
    circle.style.strokeDasharray = `${circumference} ${circumference}`;
    circle.style.strokeDashoffset = `${circumference}`;
    circle.setAttribute('cx', center);
    circle.setAttribute('cy', center);
    circle.setAttribute('r', radius);    
    circle.setAttribute('stroke-width', strokeWidth);
    circle.setAttribute('stroke', color);
}
initRing(outerBorder, 300, 2, "black");
initRing(retestCircle, 296, 18, "#6200ee");
initRing(middleBorder, 260, 2, "black");
initRing(testCircle, 256, 18, "#018786");
initRing(innerBorder, 220, 2, "black");

function setProgress(circle, percent) {
    const circumference = circle.dataset.circumference;
    const offset = circumference - percent / 100 * circumference;
    circle.style.strokeDashoffset = offset;
}
setProgress(outerBorder, 100);
setProgress(middleBorder, 100);
setProgress(innerBorder, 100);

var loadStart, rate = 1.667, currentCredits = 0, creditsTimer, accruedCredits = 0;
function updateCombined(addition) { // Add addition to 'Total contributions to date'.
    const current = parseInt(creditsCombined.innerHTML.replace(/,/g, ''));
    showCredits(current + addition, creditsCombined);
}
function showCredits(number, element) {
    element.innerHTML = Math.floor(number).toLocaleString(undefined, {minimumIntegerDigits: 9});
}
function updateCredits() { // Update accruedCredits based on loadStart, and display in 'Your credits after next job'.
    if (!loadStart || !rate) return;
    const sinceStart = Date.now() - loadStart;
    accruedCredits = sinceStart * rate;
    showCredits(accruedCredits, creditsEstimated);
}
function startCredits() { // Initialize loadStart based on currentCredits, and start updateCredits interval.
    const now = Date.now();
    loadStart = now - Math.round(currentCredits / rate);
    creditsTimer = setInterval(updateCredits, 100);
}
var lastCredits = 0;
// Update currentCredits in 'db' based on accruedCredits, and update displays for 'Your credits' and 'Total contributions to date'. 
function setCredits() {
    currentCredits = accruedCredits;
    showCredits(currentCredits, creditsRecorded);
    updateCombined(accruedCredits - lastCredits);
    lastCredits = accruedCredits;
}
var stop = false;
function runSomething(runtimeMs, circle, onEnd) {
    const runStart = Date.now();
    setProgress(circle, 0);
    const updater = setInterval(_ => {
        const elapsed = Date.now() - runStart;
        if (stop) {
            clearInterval(updater);
            clearInterval(creditsTimer);
            setProgress(testCircle, 0);
            setProgress(retestCircle, 0);
            statusDisplay.innerHTML = "&nbsp;"

            loadStart = 0;
            showCredits(currentCredits, creditsEstimated);
            return;
        }
        if (elapsed >= runtimeMs) {
            setProgress(circle, 100);
            clearInterval(updater);
            onEnd();
        } else {
            setProgress(circle, 100 * elapsed / runtimeMs);
        }
    }, 100);
}
function runTest() {
    if (!loadStart) startCredits();
    statusDisplay.innerText = "Contributing machine..."
    setProgress(retestCircle, 0);
    runSomething(12 * 1000, testCircle, awaitTest);
}
function awaitTest() {
    setCredits();
    statusDisplay.innerText = "Waiting for next job..."
    runSomething(15 * 1000, retestCircle, runTest);
}
function fakeTotals() {
    setTimeout(_ => {
        const noise = (Math.random() * 10) - 5;
        updateCombined((Math.random() < 0.2 ? 12 * 1000 * 1.667 : 30 * 60 * 1000 * 1.667) + noise);
        fakeTotals();
    }, Math.random() * 15 * 1000);
}
fakeTotals();

start.addEventListener('click', _ => {
    const label = start.querySelector('.mdc-fab__label');
    if (label.innerText === "START") {
        stop = false;
        runTest();
        label.innerText = "pause";
    } else {
        stop = true;
        label.innerText = "start";
    }
});

if ('screen' in window && 'orientation' in screen) {
    screen.orientation.lock("portrait").catch(console.log);
}

infoButton.addEventListener('click', _ => location.hash = "info");
next.addEventListener('click', _ => location.hash = "run");
infoDialog.addEventListener('MDCDialog:closed', _ => location.hash = "run");

function gotoPage(pageClass) {
    const surface = document.querySelector('.screen-transition__surface'),
          classes = surface.classList;
    var old, token;
    for (token of classes) {
        if (token.startsWith('screen-transition__surface--')) {
            old = token;
            break;
        }
    }
    classes.replace(old, pageClass);
}
function gotoIntro() {
    dialogDialog.close();
    gotoPage('screen-transition__surface--0');
}
function gotoRun() {
    dialogDialog.close();
    gotoPage('screen-transition__surface--1');
}
function gotoInfo() {
    gotoRun();
    dialogDialog.open();
    setTimeout(_ => infoButton.blur(), 100);
}

function gotoHash() {
    switch (location.hash) {
    case '#run':
        gotoRun();
        break;
    case '#info':
        gotoInfo();
        break;
    case '':
    case '#':
        gotoIntro();
        break;
    default:
        console.warn(`Unrecognized fragment identifier '${location.hash}'.`);
    }
}
gotoHash();
window.addEventListener('hashchange', gotoHash);
