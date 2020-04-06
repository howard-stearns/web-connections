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
var lastInstruction = '';
var gotNeutral = false;
var gotExpression = false;
async function webcamCapture(start) {
    const groupResult = await faceapi.detectAllFaces(webcamVideo, new faceapi.TinyFaceDetectorOptions()).withFaceExpressions();
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
    if (resizedDetections.length) {
        const review = resizedDetections.concat();
        review.sort((a, b) => Math.sign(a.detection.score - b.detection.score));
        const box = review[0].detection.box;
        const margin = 10;
        if ((box.height < displaySize.height / 2)) {
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
            const expressions = review[0].expressions;
            if (['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'].some(x => expressions[x] > 0.05)) {
                if (!gotExpression) {
                    gotExpression= Date.now();
                    console.log('gotExpression');
                }
            } else if (expressions.neutral > 0.9) {
                if (!gotNeutral) {
                    gotNeutral = Date.now();
                    console.log('gotNeutral');
                }
            }
        }
    } else {
        instruction = "Please move back a bit";
    }
    if (instruction) {
        gotNeutral = gotExpression = false;
    } else if (!gotExpression && gotNeutral && ((Date.now() - gotNeutral) > 2000)) {
        instruction = "Please smile, or make a face";
    } else if (!gotNeutral && gotExpression && ((Date.now() - gotExpression) > 2000)) {
        instruction = "Please have a neutral expression";
    } else {
        console.log(gotNeutral && ((Date.now() - gotNeutral)), gotExpression && ((Date.now() - gotExpression)));
    }
    log(instruction);

    if (instruction && (instruction != lastInstruction) && !speechSynthesis.pending && !speechSynthesis.speaking) {
        var utterThis = new SpeechSynthesisUtterance(instruction);
        speechSynthesis.speak(utterThis);
        lastInstruction = instruction;
    }
    if (gotExpression && gotNeutral) {
        music.pause();
        webcamVideo.srcObject.getTracks().forEach(track => track.stop());
        webcamVideo.srcObject = null;
        webcamVideo.parentElement.style.display = "none";
        speechSynthesis.speak(new SpeechSynthesisUtterance("Thank you. Proof of unique human is complete"));
    } else {
        setTimeout(_ => webcamCapture(Date.now()), 1000 - (Date.now() - start));
    }
}
async function webcamSetup(start) {
    log('starting setup');
    startButton.style.display = "none";
    music.loop = true;
    music.play();
    await Promise.all([
        navigator.mediaDevices.getUserMedia({video: true})
            .then(stream => new Promise(resolve => {
                webcamVideo.srcObject = stream;
                setTimeout(_ => resolve(stream), 1000);
            })),
        //faceapi.nets.ssdMobilenetv1.loadFromUri('/models'),

        faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
        faceapi.nets.faceExpressionNet.loadFromUri('/models')
    ]);
    log('model', Date.now() - start);
    webcamCapture(Date.now());
}
startButton.onclick = _ => webcamSetup(Date.now());
