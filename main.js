"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const WebSocket = require("ws");
const fs = require("fs");
const https = require("https");
/**
 * Communication:
 *
 * Client:
 * connect setup message:
 *  {world: string, guild: number, player: number, connectionId: string, secret?: string}  // limits: world.length<5, guild & player: integer>=0
 * For each Message to send:
 *  {message: string, secretOnly?: boolean} // limit: message.length < 1024
 *
 * Server:
 * after connection setup message:
 *  {type: 'members', members:  {playerId: number, name: string, portrait: string, secretsMatch: boolean}[]} // list of playerID's in this chat-room and weather theire
 * on error/ping timeout:
 *  {type: 'error', error: string}
 *
 * on player join:
 *  {type: 'switch', player: number, name: string, portrait: string, time: number, secretsMatch: boolean} // player was in room and switched connection
 *  {type: 'join', player: number, name: string, portrait: string, time: number,secretsMatch: boolean} // player entered room
 * on player leave:
 *  {type: 'leave', player: number, time: number}
 * on players secretMatching changed:
 *  {type: 'secretChange', player: number, secretsMatch: boolean}
 *
 * on message:
 *  {type: 'message', message: string, from: number, time: number, secretOnly: boolean}
 *
 * on connection with other device:
 *  {type: 'disconnect', reason: string}
 */
const MIN_CONNECTION_ID_LENGTH = 12;
const MAX_CONNECTION_ID_LENGTH = 32;
const MAX_SECTRET_LENGTH = 32;
const MAX_MESSAGE_LENGTH = 1024;
const MAX_WORLD_NAME_LENGTH = 10;
const MAX_NAME_LENGTH = 32;
const MAX_PORTRAIT_LENGTH = 32;
const WEBSOCKET_SERVER_USE_HTTPS = false;
const WEBSOCKET_SERVER_CERTIFICAT_FILE = '/path/to/cert.pem';
const WEBSOCKET_SERVER_PRIVATE_KEY_FILE = '/path/to/key.pem';
const WEBSOCKET_SERVER_PORT = 9000;
function secretsMatch(state1, state2) {
    return state1.secret !== null && state1.secret === state2.secret;
}
function send(state, message) {
    const serialized = JSON.stringify(message);
    state.ws.send(serialized);
}
function sendOther(state, message, secretOnly = false) {
    if (!state.room)
        return;
    const serialized = JSON.stringify(message);
    for (let otherState of state.room) {
        if (otherState !== state && (!secretOnly || secretsMatch(state, otherState))) {
            otherState.ws.send(serialized);
        }
    }
}
function notifyOthersSecretMatchChange(state, oldSecret) {
    if (!state.room)
        return;
    for (let otherState of state.room) {
        if (otherState !== state &&
            otherState.secret !== null && // if otherState.secret === null then match is and was false
            (otherState.secret === oldSecret) !== (otherState.secret === state.secret)) {
            const message = {
                type: 'secretChange',
                player: state.player,
                secretsMatch: secretsMatch(state, otherState)
            };
            otherState.ws.send(JSON.stringify(message));
        }
    }
}
function sendMembers(state) {
    const members = [];
    if (state.room) {
        for (let otherState of state.room) {
            members.push({
                playerId: otherState.player,
                name: otherState.name,
                portrait: otherState.portrait,
                secretsMatch: secretsMatch(state, otherState)
            });
        }
    }
    send(state, { type: 'members', members });
}
/**
 * "rooms[world][guilde] = set of connections"
 * A map indexed by the world-name (ex: 'en1') possibly containing a map for this world.
 * The contained map is indexed by the guildID and maps to a set of connections which represent all the members of a "guilde chat".
 */
const rooms = new Map();
const wss = (() => {
    if (WEBSOCKET_SERVER_USE_HTTPS) {
        const server = https.createServer({
            cert: fs.readFileSync(WEBSOCKET_SERVER_CERTIFICAT_FILE),
            key: fs.readFileSync(WEBSOCKET_SERVER_PRIVATE_KEY_FILE)
        });
        const wss = new WebSocket.Server({ server });
        server.listen(WEBSOCKET_SERVER_PORT);
	console.log("Running WS Server as HTTPS");
        return wss;
    }
    else {
console.log("Running WS Server as HTTP");
        return new WebSocket.Server({ port: WEBSOCKET_SERVER_PORT });
    }
})();
wss.on('connection', function connection(ws) {
    const state = {
        ws: ws,
        status: 'new',
        world: '',
        guild: -1,
        player: -1,
        name: '',
        portrait: '',
        secret: null,
        connectionId: '',
        room: null,
        alive: true,
        pingInterval: null
    };
    ws.on('message', function incoming(message) {
        // only handle string messages
        if (typeof message !== 'string')
            return;
        if (state.status === 'connected') {
            const data = JSON.parse(message);
            // if (data.message === 'status') {
            // 	ws.send(JSON.stringify({id: state.player, message: JSON.stringify([...conns.entries()].map(([k,v]) => [k, [...v.entries()].map(([k,v]) => [k,[...v.values()].map(v=>({world:v.world, guild: v.guild, player: v.player}))])])) }));
            // }
            // update this clients secret if a new one was set
            if (data.secret === null || (typeof data.secret === 'string' &&
                data.secret.length <= MAX_SECTRET_LENGTH)) {
                const oldSecret = state.secret;
                state.secret = data.secret;
                sendMembers(state);
                notifyOthersSecretMatchChange(state, oldSecret);
            }
            // forward a message 
            if (typeof data.message === 'string' &&
                data.message.length <= MAX_MESSAGE_LENGTH &&
                (data.secretOnly === undefined || typeof data.secretOnly === 'boolean')) {
                const secretOnly = !!data.secretOnly;
                sendOther(state, {
                    type: 'message',
                    message: data.message,
                    from: state.player,
                    time: Date.now(),
                    secretOnly: secretOnly
                }, secretOnly);
            }
        }
        else if (state.status === 'new') {
            // if the connection is new only a setup-packet is expected
            const { world, guild, player, connectionId, secret, name, portrait } = JSON.parse(message);
            // check data and limit memory used
            // world
            if (typeof world !== 'string' ||
                world.length > MAX_WORLD_NAME_LENGTH) {
                console.log('Error in connection creation "world" ' + JSON.stringify(world), new Date().toString());
                state.status = 'error';
                send(state, { type: 'error', error: 'Invalid setup packet. "world" needs to be a string with up to ' + MAX_WORLD_NAME_LENGTH + ' characters.' });
                ws.close();
                return;
            }
            // connectionId
            if (typeof connectionId !== 'string' ||
                connectionId.length > MAX_CONNECTION_ID_LENGTH ||
                connectionId.length < MIN_CONNECTION_ID_LENGTH) {
                console.log('Error in connection creation "connectionId"', new Date().toString());
                state.status = 'error';
                send(state, { type: 'error', error: 'Invalid setup packet. "connectionId" needs to be a string with ' + MIN_CONNECTION_ID_LENGTH + ' to ' + MAX_CONNECTION_ID_LENGTH + ' characters.' });
                ws.close();
                return;
            }
            // guild
            if (!Number.isInteger(guild) ||
                guild < 0) {
                console.log('Error in connection creation "guild" ' + JSON.stringify(guild), new Date().toString());
                state.status = 'error';
                send(state, { type: 'error', error: 'Invalid setup packet. "guild" needs to be an integer >= 0' });
                ws.close();
                return;
            }
            // player
            if (!Number.isInteger(player) ||
                player < 0) {
                console.log('Error in connection creation "player" ' + JSON.stringify(player), new Date().toString());
                state.status = 'error';
                send(state, { type: 'error', error: 'Invalid setup packet. "player" needs to be an integer >= 0' });
                ws.close();
                return;
            }
            // name
            if (typeof name !== 'string' ||
                name.length > MAX_NAME_LENGTH) {
                console.log('Error in connection creation "name" ' + JSON.stringify(name), new Date().toString());
                state.status = 'error';
                send(state, { type: 'error', error: 'Invalid setup packet. "name" needs to be a string with up to ' + MAX_NAME_LENGTH + ' characters.' });
                ws.close();
                return;
            }
            // portrait
            if (typeof portrait !== 'string' ||
                portrait.length > MAX_PORTRAIT_LENGTH) {
                console.log('Error in connection creation "portrait" ' + JSON.stringify(portrait), new Date().toString());
                state.status = 'error';
                send(state, { type: 'error', error: 'Invalid setup packet. "portrait" needs to be a string with up to ' + MAX_PORTRAIT_LENGTH + ' characters.' });
                ws.close();
                return;
            }
            // secret
            if (secret != null && (typeof secret !== 'string' ||
                secret.length > MAX_SECTRET_LENGTH)) {
                console.log('Error in connection creation "secret"', new Date().toString());
                state.status = 'error';
                send(state, { type: 'error', error: 'Invalid setup packet. "secret" needs to be null/undefined or a string with up to ' + MAX_SECTRET_LENGTH + ' characters.' });
                ws.close();
                return;
            }
            // save setup data
            state.world = world;
            state.guild = guild;
            state.player = player;
            state.name = name;
            state.portrait = portrait;
            state.connectionId = connectionId;
            // set the secret if it was provided
            if (secret != null) {
                state.secret = secret;
            }
            // get the room/set of connections for this guilde
            let worldRooms = rooms.get(world);
            if (!worldRooms) {
                worldRooms = new Map();
                rooms.set(world, worldRooms);
            }
            let guildRoom = worldRooms.get(guild);
            if (!guildRoom) {
                guildRoom = new Set();
                worldRooms.set(guild, guildRoom);
            }
            guildRoom.add(state);
            state.room = guildRoom;
            state.status = 'connected';
            // disconnect any other connection of this player
            let switched = false;
            let isReconnect = false;
            let oldSecret = null;
            for (let otherState of guildRoom) {
                if (otherState !== state && otherState.player === player) {
                    send(otherState, { type: 'disconnect', reason: 'new device connected' });
                    otherState.status = 'disconnected';
                    state.room.delete(otherState);
                    if (otherState.connectionId == connectionId) {
                        isReconnect = true;
                        oldSecret = otherState.secret;
                    }
                    switched = true;
                    otherState.ws.close();
                }
            }
            // don't send any message if this is just a reconnect
            if (isReconnect) {
                notifyOthersSecretMatchChange(state, oldSecret);
            }
            else {
                for (let otherState of state.room) {
                    if (otherState !== state) {
                        send(otherState, {
                            type: switched ? 'switch' : 'join',
                            player: player,
                            name: name,
                            portrait: portrait,
                            time: Date.now(),
                            secretsMatch: secretsMatch(state, otherState)
                        });
                    }
                }
            }
            sendMembers(state);
        }
    });
    // Ping every minute. Close the connection if there is no response(Pong) since the last ping.
    ws.on('pong', function pong() {
        state.alive = true;
    });
    state.pingInterval = setInterval(function ping() {
        if (!state.alive) {
            send(state, { type: 'error', error: 'Ping Timeout' });
            ws.close();
        }
        else {
            state.alive = false;
            ws.ping();
        }
    }, 60000);
    // handle closing of the websocket and do proper cleanup
    ws.on('close', function close() {
        // clear ping-timer
        if (state.pingInterval != null) {
            clearInterval(state.pingInterval);
            state.pingInterval = null;
        }
        // if connection was setup, remove this connection
        // and remove any empty sets/maps to prevent any memory-leak
        if (state.room) {
            if (state.status === 'connected') {
                sendOther(state, { type: 'leave', player: state.player, time: Date.now() });
            }
            state.room.delete(state);
            if (state.room.size === 0) {
                const worldRooms = rooms.get(state.world);
                if (worldRooms != null) {
                    worldRooms.delete(state.guild);
                    if (worldRooms.size === 0) {
                        rooms.delete(state.world);
                    }
                }
            }
            state.room = null;
        }
    });
});
//# sourceMappingURL=main.js.map
