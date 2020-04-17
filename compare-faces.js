'use strict';
const fs = require('fs');
const redis = process.env.REDIS_URL && require('redis').createClient(process.env.REDIS_URL);

function descriptorDistance(a, b) {
    var sum = 0;
    for (let i = 0; i < 128; i++) {
        let difference = a[i] - b[i];
        sum += difference * difference;
    }
    return Math.sqrt(sum);
}

//const FACE_CUTOFF = 0.5;
const FACE_CUTOFF = 0.57;
//const FACE_CUTOFF = 0.66;
function partitionFaces(faces) {
    // Get each {descriptor, image}, and partition them into
    // sets of the same user [ [{descriptor, image}, ...],  ... ]
    // This uses a hand-tuned global FACE_CUTOFF
    var sets = [];
    faces.forEach(face => {
        const {descriptor, image} = face;
        var matched = false;
        console.log('Comparing face against', sets.length, 'existing sets.');
        if (sets.length) {
            sets.forEach(set => {
                const [{descriptor:processed}] = set;
                const dist = descriptorDistance(descriptor, processed);
                if (dist < FACE_CUTOFF) {
                    //console.log('match:', dist);
                    matched = true;
                    set.push(face);
                }
            });
        }
        if (!matched) {
            sets.push([face]);
        }
    });
    return sets;
}

function computeMeansAndMaxes(sets) {
    // Compute for each set:
    // - A descriptor that is the avarage of the descriptors in the set.
    // - The maximum distance between any two descriptors in the set.
    // Also, compute the closest of any two pairs from any other set, and note which pairing it is.
    var means = [], maxDistances = [], closest = {distance: 1.0};
    sets.forEach((set, setIndex) => {
        var max = 0;
        var mean = Array(128).fill(0);
        set.forEach(({descriptor}, faceIndex) => {
            set.forEach(({descriptor:other}) => {
                let diff = descriptorDistance(descriptor, other);
                if (diff > max) max = diff;
            });
            descriptor.forEach((v, i) => mean[i] += v);
            sets.forEach((otherSet, otherSetIndex) => {
                if (otherSet === set) return;
                otherSet.forEach((otherFace, otherFaceIndex) => {
                    let diff = descriptorDistance(descriptor, otherFace.descriptor);
                    if (diff < closest.distance) closest = {distance: diff, a: [setIndex, faceIndex], b: [otherSetIndex, otherFaceIndex]};
                });
            });
        });
        mean.forEach((v, i) => mean[i] /= set.length);
        means.push(mean);
        maxDistances.push(max);
    });
    return [means, maxDistances, closest];
}

function computeClosestToMean(means, sets) {
    // For each set, find the picture from any other set that is the closest to this set's mean.
    var closestsToMean = [];
    means.forEach((mean, meanIndex) => {
        var closestOther = {distance: 1.0};
        sets.forEach((set, setIndex) => {
            if (meanIndex === setIndex) return;
            set.forEach(({descriptor}, faceIndex) => {
                let diff = descriptorDistance(mean, descriptor);
                if (diff < closestOther.distance) closestOther = {distance: diff, index: [setIndex, faceIndex]};
            });
        });
        closestOther.distance = Number.parseFloat(closestOther.distance.toPrecision(2));
        closestsToMean.push(closestOther);
    });
    return closestsToMean;
}

const category = 'faceTest0';
redis.lrange(category, 0, -1, function (error, data) {
    if (error) return console.error(error);

    console.log('Got', data.length, 'faces to process from redis.');
    const sets = partitionFaces(data.map(JSON.parse));
    console.log('Partitioned into ', sets.length, 'users, each of:',
                JSON.stringify(sets.map(u => u.length)));

    var [means, maxDistances, closest] = computeMeansAndMaxes(sets);
    var closestsToMean = computeClosestToMean(means, sets);

    const file = fs.createWriteStream('faces.html');
    file.on('error', function (err) {
        console.log(err);
    });
    
    file.write('<!DOCTYPE html><html lang="en"><body>\n');
    sets.forEach((set, setIndex) => {
        file.write('<div>\n');
        var closest = closestsToMean[setIndex];
        file.write('<p>User ' + setIndex
                   + ' -  Max distance within group: ' + maxDistances[setIndex].toPrecision(2)
                   + ". Closest other picture to this user's mean is user " + closest.index[0] + ", picture " + closest.index[1]
                   + " (difference " + closest.distance.toString() + ').</p>\n');
        set.forEach(({image}) => file.write('<img src="' + image + '"/>\n'));
        file.write('</div><hr>\n');
    });

    file.write('<p>Partitioned using a cutoff of ' + FACE_CUTOFF + '.</p>');
    maxDistances.sort();
    const distances = maxDistances.map(d => d.toPrecision(2)).join(' ');
    console.log('internal distances:', distances);
    file.write('<p>Max distances within a group, sorted: ' + distances + '</p>');

    console.log('closest:', closest);
    file.write('<p>Minimum distance between any pictures from different groups: ' + closest.distance.toPrecision(2) + ' ' + JSON.stringify(closest.a) + ' ' + JSON.stringify(closest.b) + '</p>');
    
    file.end('</body></html>\n');
    console.log('written');
    //console.log('distance check:', descriptorDistance(sets[1][1].descriptor, sets[8][1].descriptor));

    redis.quit();
});
