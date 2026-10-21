// LAN discovery responder for the webOS app, run on the computer next to the streaming server.
//
// The TV asks "is a streaming server here?" with a small UDP datagram, sent as an IPv4 broadcast and
// to an IPv6 link-local multicast group, so it finds this computer on any network: a home router,
// a phone hotspot without IPv4, after the router hands out new addresses. This service answers with
// the ports of the streaming server and of the subtitle sync service, and with the addresses of this
// computer the TV can reach. The answer carries no secret. Only Node built-ins are used.
//
// Env: DISCOVERY_PORT (11479), DISCOVERY_GROUP6 (ff02::114), STREMIO_PORT (11480), SUBSYNC_PORT (11481)
'use strict';

const { execFileSync } = require('child_process');
const dgram = require('dgram');
const { isIP } = require('net');
const os = require('os');

const PORT = parseInt(process.env.DISCOVERY_PORT || '11479', 10);
const GROUP6 = process.env.DISCOVERY_GROUP6 || 'ff02::114';
const SERVER_PORT = parseInt(process.env.STREMIO_PORT || '11480', 10);
const SUBSYNC_PORT = parseInt(process.env.SUBSYNC_PORT || '11481', 10);
const QUERY = 'stremio-lan?';
const NAME = computerName();

function log(...args) {
    // Timestamped lines for the service log
    console.log(new Date().toISOString(), ...args);
}

function computerName() {
    // macOS keeps the name people gave the computer apart from the host name, which DHCP can set to a bare address
    let name = os.hostname();
    if (process.platform === 'darwin') {
        try {
            name = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim() || name;
        } catch (err) {
            log('computer name not read', err.message);
        }
    }
    // An address says nothing the TV does not already know, so the answer carries no name then
    return isIP(name) ? '' : name.replace(/\.local$/, '');
}

function reachableAddresses() {
    // Every address of this computer a TV on the same network can use: IPv4 and global or unique-local IPv6
    const found = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
        for (const net of list || []) {
            // Link-local IPv6 needs an interface name only the TV knows, so the TV takes it from the answer source instead
            if (net.internal || /^fe80:/i.test(net.address)) continue;
            found.push({ address: net.address, family: net.family === 4 || net.family === 'IPv4' ? 'IPv4' : 'IPv6', interface: name });
        }
    }
    return found;
}

function answer(socket, message, rinfo) {
    // Reply to a query only, straight to the asking TV
    if (message.toString('utf8') !== QUERY) return;
    const body = JSON.stringify({ service: 'stremio-lan', version: 1, name: NAME, port: SERVER_PORT, subsyncPort: SUBSYNC_PORT, addresses: reachableAddresses() });
    socket.send(body, rinfo.port, rinfo.address, (err) => {
        if (err) log('answer failed', rinfo.address, err.message);
    });
    log('answered', rinfo.address);
}

function joinGroup6(socket) {
    // The IPv6 group is joined on every interface with IPv6, since a computer can sit on several networks at once
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
        if (!(list || []).some((net) => !net.internal && (net.family === 6 || net.family === 'IPv6'))) continue;
        try {
            socket.addMembership(GROUP6, '::%' + name);
        } catch (err) {
            // An interface already in the group answers EADDRINUSE on every later pass
            if (err.code !== 'EADDRINUSE') log('group not joined on', name, err.message);
        }
    }
}

function start() {
    // One socket per address family; each keeps working when the other is missing on this network
    const udp4 = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp4.on('message', (message, rinfo) => answer(udp4, message, rinfo));
    udp4.on('error', (err) => log('IPv4 socket error', err.message));
    udp4.bind(PORT, () => log(`discovery listening on udp4 :${PORT}`));
    const udp6 = dgram.createSocket({ type: 'udp6', reuseAddr: true, ipv6Only: true });
    udp6.on('message', (message, rinfo) => answer(udp6, message, rinfo));
    udp6.on('error', (err) => log('IPv6 socket error', err.message));
    udp6.bind(PORT, () => {
        joinGroup6(udp6);
        // Networks come and go (a hotspot, the home router), so new interfaces join the group too
        setInterval(() => joinGroup6(udp6), 60000);
        log(`discovery listening on udp6 :${PORT}, group ${GROUP6}`);
    });
}

start();
