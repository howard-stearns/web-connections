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
    const element = document.createElement('p');
    element.innerText = [...args].map(x => (typeof x === 'string') ? x : JSON.stringify(x)).join(' ');
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
var displaySize;
async function findFaces(start) {
    var groupResult, resizedDetections, timeout = setTimeout(_ => alert('Timeout waiting for faces to be computed!'), 5000);
    try {
        groupResult = await faceapi.detectAllFaces(webcamVideo, new faceapi.TinyFaceDetectorOptions({inputSize: 128}))
            .withFaceLandmarks(true)
            .withFaceDescriptors()
            .withFaceExpressions();
        faceapi.matchDimensions(videoOverlay, displaySize); // Clears overlay, so it has to be done each loop
        resizedDetections = faceapi.resizeResults(groupResult, displaySize);
        faceapi.draw.drawDetections(videoOverlay, resizedDetections);
        faceapi.draw.drawFaceExpressions(videoOverlay, resizedDetections, 0.05);
    } catch (e) {
        alert(`Error in computing faces: ${e.message || e}`);
    }
    clearTimeout(timeout);
    return [bestFace(resizedDetections), groupResult];
}

var lastInstruction = '', gotNeutral = false, gotExpression = false, gotFail = false, descriptor = false;
var captured;
async function webcamCapture(start) {
    const [face, raw] = await findFaces(start);
    const now = Date.now(), TIMEOUT_MS = 2000;
    var instruction = '';
    function expired(expires) {
        return expires && (now > expires);
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
            const MAX_DISTANCE = 0.4;
            gotFail = false;
            if (['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'].some(x => expressions[x] > 0.9)) {
                if (!gotExpression) {
                    var distance = 0;
                    if (descriptor) {
                        distance = faceapi.euclideanDistance(face.descriptor, descriptor);
                        console.info('expression distance:', distance);
                    } else {
                        descriptor = face.descriptor;
                    }
                    if (distance > MAX_DISTANCE) {
                        gotFail = now + TIMEOUT_MS;
                    } else {
                        gotExpression = now + TIMEOUT_MS;
                    }
                }
            } else if (expressions.neutral > 0.9) {
                if (!gotNeutral) {
                    var distance = 0;
                    if (descriptor) {
                        distance = faceapi.euclideanDistance(face.descriptor, descriptor);
                        console.info('neutral distance:', distance);
                    } else {
                        descriptor = face.descriptor;
                    }
                    if (distance > MAX_DISTANCE) {
                        gotFail = now + TIMEOUT_MS;
                    } else {
                        gotNeutral = now + TIMEOUT_MS;
                    }
                }
                if (!captured) {
                    const bigBox = bestFace(raw).detection.box;
                    captured = document.createElement("canvas");
                    captured.width = bigBox.width;
                    captured.height = bigBox.height;
                    captured.getContext('2d').drawImage(webcamVideo,
                                                        bigBox.left, bigBox.top, captured.width, captured.height,
                                                        0, 0, captured.width, captured.height);
                    /*
                    var snap = document.createElement("canvas");
                    snap.width = webcamVideo.videoWidth;
                    snap.height = webcamVideo.videoHeight;
                    snap.getContext('2d').drawImage(webcamVideo, 0, 0, snap.width, snap.height);
                    snap.getContext('2d').drawImage(videoOverlay, 0, 0, snap.width, snap.height);
                    statusBlock.appendChild(snap);*/
                }
            }
        }
    } else if (!gotFail) {
        gotFail = now + TIMEOUT_MS;
    }
    if (expired(gotFail)) {
        instruction = "Make sure there is enough light, and that you can see your face with a box in the center of the video";
    }
    if (instruction || gotFail) {
        captured = gotNeutral = gotExpression = descriptor = false;
        if (instruction) gotFail = false;
    } else if (!gotExpression && expired(gotNeutral)) {
        instruction = "Please smile, or make a face";
    } else if (!gotNeutral && expired(gotExpression)) {
        instruction = "Please have a neutral expression";
    }

    if (instruction && (instruction != lastInstruction) && !speechSynthesis.pending && !speechSynthesis.speaking) {
        speak(instruction);
        lastInstruction = instruction;
    }
    if (gotExpression && gotNeutral) {
        webcamStop();
    } else { // Throttled repeat
        const INTENDED_MAX_INTERVAL_MS = 1000, MIN_MS = 100, elapsed = now - start;
        console.log(elapsed, instruction, gotExpression, gotNeutral, gotFail);
        setTimeout(_ => webcamCapture(now), Math.max(MIN_MS, INTENDED_MAX_INTERVAL_MS - elapsed));
    }
}
const loadStart = Date.now();
const modelsTimeout = setTimeout(_ => alert("Unable to load AI models."), 5000);
var models = Promise.all([
    //faceapi.nets.ssdMobilenetv1.loadFromUri('/models'),
    faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
    faceapi.nets.faceLandmark68TinyNet.loadFromUri('/models'),
    faceapi.nets.faceRecognitionNet.loadFromUri('/models'),
    faceapi.nets.faceExpressionNet.loadFromUri('/models')
]).then(_ => {
    clearTimeout(modelsTimeout);
    console.log('model load:', Date.now() - loadStart);
});

// iOS can't handle playing music and processing video. It freezes.
var playMusic;//FIXME = !navigator.userAgent.includes('iPhone') && !navigator.userAgent.includes('iPad');
if (playMusic) music.src = "game-start.mp3";

async function webcamSetup(start) {
    console.log('starting setup');
    document.querySelector('.instructions').style.display = "none";
    if (playMusic) {
        music.loop = true;
        music.play();
    }
    speak("Let's go.");
    const loadFail = setTimeout(_ => alert('We were not able to access your webcam!'), 7000);
    await Promise.all([
        navigator.mediaDevices.getUserMedia({video: true})
            .then(stream => new Promise(resolve => {
                webcamVideo.srcObject = stream;
                webcamVideo.onloadedmetadata = _ => resolve(stream);
            }))
            .catch(e => alert('Unable to access to Webcam!')),
        models
    ]);
    models = null; // Won't actually get gc'd while face.api is using it, but we're living clean here.
    clearTimeout(loadFail);
    displaySize = { width: webcamVideo.offsetWidth, height: webcamVideo.offsetHeight };
    const now = Date.now();
    console.log('setup', now - start);
    webcamCapture(now);
}

async function webcamStop() {
    if (playMusic) music.pause();
    webcamVideo.srcObject.getTracks().forEach(track => track.stop());
    webcamVideo.srcObject = null;
    webcamVideo.parentElement.style.display = "none";
    speak("Thank you. Proof of unique human is complete");
    const snap = captured.toDataURL();
    log("All of the following would NOT be shown to users.");
    log("At this point we process the captured picture to compute a unique set of numbers that describe key features - a 'faceprint'.");
    log("IF IT FAILS, the registration would fail, and the user could try again.");
    log("When we were displaying the webcam to the user before, we used a smaller picture and analyzed it in real time as a small image.",
        "Now we want to analyze just one frame as accurately as we can.",
        "This could be done as a background service worker job on the user's machine, as the registration continues, or it could be done on our server.",
        "For now, we're doing it here in this browser.");
    log("For demonstration purposes, here are the results in progress...");
    var start = Date.now();
    statusBlock.appendChild(captured);
    
    await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri('/models'),
        faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
        //faceapi.nets.faceLandmark68TinyNet.loadFromUri('/models'),
        faceapi.nets.faceRecognitionNet.loadFromUri('/models')
        //faceapi.nets.ageGenderNet.loadFromUri('/models')
    ]);
    var loadTime = Date.now() - start;
    const final = await faceapi.detectSingleFace(captured/*, new faceapi.TinyFaceDetectorOptions({inputSize: 160})*/)
          .withFaceLandmarks(/*true*/)
          .withFaceDescriptor(),
          finals = [final];
    if (!final) {
        return alert('Detection failed');
    }
    faceapi.draw.drawDetections(captured, finals);
    faceapi.draw.drawFaceLandmarks(captured, finals);
    log("That detailed analysis took", Date.now() - start, "milliseconds, including", loadTime, "ms to load the models.");

    log("Now we compare the faceprint with every one that has been registered, finding the closest match.",
        "Here we are doing it on the server, one at a time.",
        "At scale we would need to be more clever.",
        "This is a good example of an 'embarassingly parallel' job that could be done quickly by contributed machines.",
        "Submitting...");
    start = Date.now();
    const data = JSON.stringify({
        descriptor: [...final.descriptor],
        image: snap
    });
    fetch('/submitFace', {
        method: 'post',
        headers: {'Content-Type': 'application/json'},
        body: data
    }).then((response, error) => {
        const fail = error || (!response.ok && new Error(response.statusText || 'undefined error'));
        if (fail) {
            console.error(fail);
            alert(fail.message);
            return;
        }
        log("That took", Date.now() - start, "milliseconds.");
        log("We'd have to pick a number for cutoff, but a starting guess is that anything above 0.5 is a different person.");
        log("Here is your face and the closest matches up to 0.5, and the closest match that is more than 0.5 (if any) for comparison.");
        response.json().then(data => {
            console.log(typeof data, data.length);
            data.forEach(({distance, image}) => {
                const pair = document.createElement("div"),
                      pic = document.createElement("img"),
                      txt = document.createElement("span");
                pair.classList.add('result');
                pic.src = image;
                txt.innerText = distance.toPrecision(2);
                pair.appendChild(pic);
                pair.appendChild(txt);
                statusBlock.appendChild(pair);
            });
        });
    });
    /*

    log("Distance from baseline is", faceapi.euclideanDistance(final.descriptor, baselineDescriptor));
    var sum = 0;
    for (let i = 0; i < 128; i++) {
        let difference = final.descriptor[i] - baselineDescriptor[i];
        sum += difference * difference;
    }
    log("Our compute", Math.sqrt(sum));
    log("We'd have to pick a number for cutoff, but a starting guess is that anything above 0.5 is a different person.");
    */
/*
const baselineDescriptor = [-0.0872991755604744,0.1978130042552948,0.05622096359729767,-0.05147629976272583,-0.08091461658477783,0.0026162806898355484,0.0011631660163402557,-0.11434108763933182,0.2020055651664734,-0.049668341875076294,0.15390661358833313,0.001009029452688992,-0.17533186078071594,-0.0005982344737276435,-0.09673643857240677,0.09405999630689621,-0.18815869092941284,-0.06801925599575043,-0.21334077417850494,-0.0867408737540245,0.06489378213882446,0.0680423453450203,0.04424647241830826,-0.03817345201969147,-0.10859360545873642,-0.3165833353996277,-0.04726405814290047,-0.08777382969856262,0.05521167442202568,-0.08550801873207092,0.08831815421581268,-0.04380621761083603,-0.22890494763851166,-0.07909692823886871,-0.05029910430312157,0.027787335216999054,-0.0853387638926506,-0.02952285297214985,0.18582043051719666,-0.01166035421192646,-0.15208283066749573,0.09681247919797897,0.0880419984459877,0.2810881435871124,0.25087156891822815,0.04878439009189606,-0.04231831058859825,-0.10861888527870178,0.12484056502580643,-0.26537466049194336,0.061285313218832016,0.16909457743167877,0.011104006320238113,0.08895526826381683,0.17142793536186218,-0.054235268384218216,0.04036150872707367,0.08651186525821686,-0.17533574998378754,0.01043714303523302,0.08909597247838974,0.045121148228645325,-0.012483890168368816,-0.057311322540044785,0.1339423656463623,0.06060067564249039,-0.06186707690358162,-0.05732344090938568,0.10795701295137405,-0.1844467967748642,-0.010601775720715523,-0.01412294153124094,-0.07607976347208023,-0.144331693649292,-0.31316253542900085,0.04775649681687355,0.49108290672302246,0.12189480662345886,-0.07851461321115494,0.03534594550728798,-0.07418230921030045,-0.09536478668451309,0.08006831258535385,-0.018360275775194168,-0.13013076782226562,-0.050047826021909714,-0.015610989183187485,0.12553508579730988,0.19055186212062836,-0.012259330600500107,0.008087514899671078,0.24573320150375366,0.02214597910642624,-0.09209241718053818,-0.005292202346026897,0.008631283417344093,-0.1234503909945488,0.025976750999689102,-0.16274075210094452,0.0568014420568943,0.0226176418364048,-0.10867784917354584,0.014444914646446705,0.08670741319656372,-0.2166207879781723,0.10261977463960648,0.05113257095217705,-0.047796230763196945,0.023058421909809113,0.014178343117237091,-0.17795875668525696,-0.04728301614522934,0.20716793835163116,-0.17946253716945648,0.21703824400901794,0.17194226384162903,-0.024114882573485374,0.08872876316308975,0.08423850685358047,0.06052352860569954,0.008474940434098244,0.07929914444684982,-0.11884019523859024,-0.061271846294403076,0.014457403682172298,-0.01780041493475437,0.007777481805533171,0.055991336703300476];
*/    
    /*
    const demo = document.createElement('p');
    demo.innerText = final.gender + ' age ' + final.age.toFixed();
    statusBlock.appendChild(demo);
    */
    // var img = document.createElement("img");
    // img.src = snap
    // statusBlock.appendChild(img);
    // console.log(img.src, final);
}
startButton.onclick = _ => webcamSetup(Date.now());
