# Web Connections

A test bed for investigating p2p connectivity between web pages

## status

initial PoC development

## synopsis

1. The server offers a Progress Web App (an installable Web page) that registers itself and can connect to any other such registered page.
2. The two pages try to create a WebRTC data connection to each other, and measure performance.
3. The data is reported to the server, where results may be viewed.

## components

- signalling, using a WebSocket server or a EventSource
- registration
- test
- data collection
- data display

## Results So Far

The test suite at /SpecRunner.html checks eight things:
1. Do WebSockets work from the browser to the given server and back?
2. Does EventSource work from the given server to this browser?
3. Can an RTC dataChannel be established from this browser to another peer in the same browser, using direct loopback signalling?
4. Can an RTC dataChannel be established from this browser to another peer in the same browser, using WebSockets for signalling?
5. Can an RTC dataChannel be established from this browser to another peer in the same browser, using EventSource (SSE) for signalling?
6. - 8. Same three questions for RTC media streams.

So far:

This is using the default ICE servers built into the browsers. Presumably does NOT include TURN.

These results repeat using two different hosts:
- [Azure using http (not https)](http://52.183.27.25:8443/SpecRunner.html)
- [Heroku using https](https://intense-savannah-20051.herokuapp.com/SpecRunner.html)

### Wifi client

|              | Windows 10/Edge 79 | OSX 10.15/Safari 13 | iOS 13.3/Safari  | Pixel Android 10/Chrome 79|
|--------------|--------------------|---------------------|------------------|---------------------------|
|WebSockets    |yes                 |yes                  |yes               |yes                        |
|EventSource   |yes                 |yes                  |yes               |yes                        |
|data/loopback |yes                 |yes                  |yes               |yes                        |
|data/ws       |yes                 |yes                  |yes               |yes                        |
|data/SSE      |yes                 |yes                  |_NOT RELIABLE_    |yes                        |
|media/loopback|?(2)                |yes                  |yes (1)           |yes                        |
|media/ws      |?(2)                |yes                  |yes (1)           |yes                        |
|media/SSE     |?(2)                |yes                  |_NOT RELIABLE_ (1)|yes                        |

### Cellular client

|              | Windows 10/Edge 79 | OSX 10.15/Safari 13 | iOS 13.3/Safari  | Pixel Android 10/Chrome 79|
|-------------:|:------------------:|:-------------------:|:----------------:|:-------------------------:|
|WebSockets    |? - please try      |yes                  |yes               |? - please try             |
|EventSource   |? links above       |yes                  |yes               |?   links above            |
|data/loopback |? while tethered    |yes                  |**NO**            |?   and tell me            |
|data/ws       |? and tell me       |yes                  |**NO**            |?   what you get           |
|data/SSE      |? what you get      |yes                  |**NO**            |?                          |
|media/loopback|?                   |yes                  |yes (1)           |yes                        |
|media/ws      |?                   |yes                  |yes (1)           |yes                        |
|media/SSE     |?                   |yes                  |_NOT RELIABLE_ (1)|yes                        |

1. Media streams are not allowed at all for http (non-https) sites on ios, so this isn't tested on Azure.
2. I don't have a camera on my Windows box, and so could test media streams.