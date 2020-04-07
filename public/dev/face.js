'use strict';
/*
console.log(faceapi.nets)

async function faceTest() {
    var start = Date.now();
    await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri('/models'),
        faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
        faceapi.nets.faceRecognitionNet.loadFromUri('/models')
    ]);
    console.log('model', Date.now() - start);
    const groupResult = await faceapi.detectAllFaces(group).withFaceLandmarks().withFaceDescriptors();
    console.log('groupResult', groupResult, Date.now() - start);
    const faceMatcher = new faceapi.FaceMatcher(groupResult)
    console.log('matcher', faceMatcher);

    const displaySize = { width: group.width, height: group.height };
    faceapi.matchDimensions(groupCanvas, displaySize);
    const resizedDetections = faceapi.resizeResults(groupResult, displaySize);
    faceapi.draw.drawDetections(groupCanvas, resizedDetections)


    const result = await faceapi.detectSingleFace(sheldonXpng).withFaceLandmarks().withFaceDescriptor();
    console.log('result', result, Date.now() - start);
    const bestMatch = faceMatcher.findBestMatch(result.descriptor);
    console.log(bestMatch.toString());
    groupResult.forEach(r => {
        const dist = faceapi.euclideanDistance(r.descriptor, result.descriptor);
        const box = r.detection.box;
        const text = [dist.toPrecision(2)];
        const anchor = box;
        const drawOptions = {
            anchorPosition: 'TOP_LEFT',
            backgroundColor: 'rgba(0, 0, 0, 0.5)'
        };
        const drawBox = new faceapi.draw.DrawTextField(text, anchor, drawOptions);
        drawBox.draw(groupCanvas);
    });
}    
//faceTest();
*/
function log(...args) {
    return;
    const element = document.createElement('div');
    element.innerText = [...args].map(JSON.stringify).join(' ');
    statusBlock.appendChild(element);
}

if (!window.speechSynthesis) { alert('This browser does not support speech!'); }
if (!navigator.mediaDevices) { alert('This browser does not support webcams!'); }

function speak(text) {
    var utterThis = new SpeechSynthesisUtterance(text);
    function onError(event) {
        alert(`Error while telling you "${text}": ${event.error}`);
    }
    utterThis.onerror = onError;
    utterThis.volume = 1;
    speechSynthesis.speak(utterThis);
}

function bestFace(detections) { // Return the highest scoring face from dections array.
    if (detections.length > 1) {
        review = review.concat(); // copy
        review.sort((a, b) => Math.sign(b.detection.score - a.detection.score)); // highest score first.
    }
    return detections[0];
}
var lastInstruction = '';
var gotNeutral = false, gotExpression = false, gotFail = false;
function foo() {
    console.log('start foo');
    return new Promise((resolve, reject) => setTimeout(_ => {console.log('resolving empty'); reject("hrs");}, 500));
}
async function webcamCapture(start) {
    var groupResult, timeout = setTimeout(_ => alert('Timeout waiting for faces to be computed!'), 5000);
    try {
        groupResult = await faceapi.detectAllFaces(webcamVideo, new faceapi.TinyFaceDetectorOptions({inputSize: 128})).withFaceExpressions();
    } catch (e) {
        alert(`Error in computing faces: ${e.message || e}`);
    }
    clearTimeout(timeout);
    log('groupResult', groupResult, Date.now() - start);
    const displaySize = { width: webcamVideo.offsetWidth, height: webcamVideo.offsetHeight };
    log('size', displaySize);
    faceapi.matchDimensions(videoOverlay, displaySize);
    const resizedDetections = faceapi.resizeResults(groupResult, displaySize);
    faceapi.draw.drawDetections(videoOverlay, resizedDetections);
    log('detections');
    faceapi.draw.drawFaceExpressions(videoOverlay, resizedDetections, 0.05);
    log('expressions');

    var instruction = '';
    const face = bestFace(resizedDetections), now = Date.now(), TIMEOUT_MS = 2000;
    function expired(value) {
        return value && ((now - value) > TIMEOUT_MS);
    }
    if (face) {
        const box = face.detection.box;
        const margin = 10;
        if (displaySize.height < displaySize.width
            ? (box.height < displaySize.height / 2)
            : (box.width < displaySize.width / 2)) {
            instruction = "Move closer, please";
        } else if (box.left < margin) {
            instruction = "Move left";
        } else if (box.top < margin) {
            instruction = "Move down";
        } else if (box.right > displaySize.width - margin) {
            instruction = "Move right";
        } else if (box.bottom > displaySize.height - margin) {
            instruction = "Move up";
        } else {
            const expressions = face.expressions;
            gotFail = false;
            if (['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'].some(x => expressions[x] > 0.05)) {
                if (!gotExpression) {
                    gotExpression = now;
                    console.log('gotExpression');
                }
            } else if (expressions.neutral > 0.9) {
                if (!gotNeutral) {
                    gotNeutral = now;
                    console.log('gotNeutral');
                }
            }
        }
    } else if (!gotFail) {
        gotFail = now;
        console.log('gotFail');
    }
    if (expired(gotFail)) {
        instruction = "Make sure there is enough light, and that you can see your face in the center of the video";
    }
    if (instruction) {
        gotNeutral = gotExpression = gotFail = false;
    } else if (!gotExpression && expired(gotNeutral)) {
        instruction = "Please smile, or make a face";
    } else if (!gotNeutral && expired(gotExpression)) {
        instruction = "Please have a neutral expression";
    } else {
        console.log('neutral:', gotNeutral && (now - gotNeutral), 'expression:', gotExpression && (now - gotExpression));
    }
    log(instruction);

    if (instruction && (instruction != lastInstruction) && !speechSynthesis.pending && !speechSynthesis.speaking) {
        speak(instruction);
    }
    lastInstruction = instruction;
    if (gotExpression && gotNeutral) {
        webcamStop();
    } else { // Throttled repeat
        const INTENDED_MAX_INTERVAL_MS = 1000, now = Date.now(), elapsed = now - start;
        setTimeout(_ => webcamCapture(now), INTENDED_MAX_INTERVAL_MS - elapsed);
    }
}
async function webcamSetup(start) {
    log('starting setup');
    document.querySelector('.instructions').style.display = "none";
    //music.loop = true;
    //music.play();
    speak("Thank you.");
    const loadFail = setTimeout(_ => alert(webcamVideo.srcObject
                                           ? 'Unable to load AI models.'
                                           : 'We were not able to access your webcam!'),
                                7000);
    await Promise.all([
        navigator.mediaDevices.getUserMedia({video: true})
            .then(stream => new Promise(resolve => {
                webcamVideo.srcObject = stream;
                webcamVideo.onloadedmetadata = _ => resolve(stream);
            }))
            .catch(e => alert('Unable to access to Webcam!')),
        //faceapi.nets.ssdMobilenetv1.loadFromUri('/models'),

        faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
        faceapi.nets.faceExpressionNet.loadFromUri('/models')
    ]);
    clearTimeout(loadFail);
    log('model', Date.now() - start);
    webcamCapture(Date.now());
}
function webcamStop() {
    //music.pause();
    webcamVideo.srcObject.getTracks().forEach(track => track.stop());
    webcamVideo.srcObject = null;
    webcamVideo.parentElement.style.display = "none";
    speak("Thank you. Proof of unique human is complete");
}
startButton.onclick = _ => webcamSetup(Date.now());
