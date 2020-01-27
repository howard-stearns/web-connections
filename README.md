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

