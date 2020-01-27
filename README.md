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

The test suite at /SpecRunner.html checks five things:
1. Do WebSockets work from the browser to the given server and back?
2. Does EventSource work from the given server to this browser?
3. Can an RTC dataChannel be established from this browser another peer in the same browser, using direct loopback signalling?
4. Can an RTC dataChannel be established from this browser another peer in the same browser, using WebSockets for signalling?
5. Can an RTC dataChannel be established from this browser another peer in the same browser, using EventSource (SSE) for signalling?

So far:

This is using the default ICE servers built into the browsers. Presumably does NOT include TURN.

These results repeat using two different hosts:
- [Azure using http (not https)](http://52.183.27.25:8443/SpecRunner.html)
- [Heroku using https](https://intense-savannah-20051.herokuapp.com/SpecRunner.html)

### Wifi client


### Wifi client

|            | Windows 10/Edge 79 | OSX 10.15/Safari 13 | iOS 13.3/Safari | Pixel Android 10/Chrome 79|
|------------|--------------------|---------------------|-----------------|---------------------------|
|WebSockets  |yes                 |yes                  |yes              |yes                        |
|EventSource |yes                 |yes                  |yes              |yes                        |
|rtc/loopback|yes                 |yes                  |yes              |yes                        |
|rtc/ws      |yes                 |yes                  |yes              |yes                        |
|rtc/SSE     |yes                 |yes                  |_not reliable_   |yes                        |

### Cellular client

|            | Windows 10/Edge 79 | OSX 10.15/Safari 13 | iOS 13.3/Safari | Pixel Android 10/Chrome 79|
|-----------:|:------------------:|:-------------------:|:---------------:|:-------------------------:|
|WebSockets  |?                   |yes                  |yes              |?                          |
|EventSource |?                   |yes                  |yes              |?                          |
|rtc/loopback|?                   |yes                  |*no*             |?                          |
|rtc/ws      |?                   |yes                  |*no*             |?                          |
|rtc/SSE     |?                   |yes                  |*no*             |?                          |

