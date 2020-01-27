/*global describe, it, require*/
"use strict";
const puppeteer = require('puppeteer');
const BASE = 'http://localhost:8443';
describe('browser', function () {
    var fail = true;
    beforeAll(async done => { // Give puppeteer a chance to hook into reporters.
        const browser = await puppeteer.launch({headless: false});
        const page = await browser.newPage();
        await page.goto(BASE + '/SpecRunner.html');
        page.on('console', msg => console.info(msg.text()));
        await page.exposeFunction('jasmineReporter', async status => {
            if (status.overallStatus === 'passed') {
                fail = false;
            } else if (status.failedExpectations.length) {
                console.error(status.failedExpectations);
            }
            console.info(__dirname, status.overallStatus);
            await browser.close();
            done();
        });
        await page.exposeFunction('specReporter', status => {
            if (status.status === 'failed') {
                console.error(status.fullName, status.failedExpectations.map(x => x.message));
            } else {
                console.info('ok: %s', status.description);
            }
        });
        await page.evaluate(() => {
            jasmine.getEnv().addReporter({
                specDone: window.specReporter,
                suiteDone: window.specReporter,
                jasmineDone: window.jasmineReporter
            });
        });
    });
    it('run', function () {
        expect(fail).toBeFalsy();
    });
});
