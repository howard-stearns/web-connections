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
    const element = document.createElement('div');
    element.innerText = [...args].map(JSON.stringify).join(' ');
    statusBlock.appendChild(element);
}
async function webcamCapture(start) {
    const groupResult = await faceapi.detectAllFaces(webcamVideo, new faceapi.TinyFaceDetectorOptions()).withFaceExpressions();
    log('groupResult', groupResult, Date.now() - start);
    //const displaySize = { width: webcamVideo.videoWidth, height: webcamVideo.videoHeight };
    const displaySize = { width: webcamVideo.width, height: webcamVideo.height };
    log('size', displaySize);
    faceapi.matchDimensions(videoOverlay, displaySize);
    const resizedDetections = faceapi.resizeResults(groupResult, displaySize);
    faceapi.draw.drawDetections(videoOverlay, resizedDetections);
    log('detections');
    faceapi.draw.drawFaceExpressions(videoOverlay, resizedDetections, 0.05);
    log('expressions');
    //webcamCapture(Date.now());
}
async function webcamSetup(start) {
    log('starting setup');
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
