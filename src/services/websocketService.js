const { Server } = require('socket.io');
const redis = require('redis');

let io;
let subscriberClient;

async function setupWebSocketServer(httpServer) {
    // 1. Initialize Socket.io on the shared HTTP server
    io = new Server(httpServer, {
        cors: {
            origin: "*", // Adjust this in production to your React frontend URL
            methods: ["GET", "POST"]
        }
    });

    io.on('connection', (socket) => {
        console.log(`[Socket.io] New dashboard client connected: ${socket.id}`);

        socket.on('disconnect', () => {
            console.log(`[Socket.io] Client disconnected: ${socket.id}`);
        });
    });

    // 2. Setup a dedicated Redis subscriber client
    // Redis requires a separate connection exclusively for listening to Pub/Sub
    subscriberClient = redis.createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379'
    });

    subscriberClient.on('error', (err) => console.error('[Redis Subscriber Error]', err.message));

    try {
        await subscriberClient.connect();
        console.log('Redis Subscriber Client Connected for Dashboard Push Events');

        // 3. Listen to 'call_updates' emitted by redisService.js (for Gauges & Charts)
        await subscriberClient.subscribe('call_updates', (message) => {
            try {
                const data = JSON.parse(message);
                // 4. Instantly broadcast the AI insight out over the WebSockets
                io.emit('call_updated', data);
            } catch (err) {
                console.error('Error parsing PubSub message:', err.message);
            }
        });

        // 5. Listen to 'transcript_update' for lightning-fast Live Transcript streaming
        await subscriberClient.subscribe('transcript_update', (message) => {
            try {
                const data = JSON.parse(message);
                io.emit('transcript_update', data);
            } catch (err) {
                console.error('Error parsing Transcript message:', err.message);
            }
        });

    } catch (err) {
        console.error('Failed to connect Redis Subscriber:', err.message);
    }
}

function getIO() {
    if (!io) {
        throw new Error('Socket.io has not been initialized yet!');
    }
    return io;
}

module.exports = { setupWebSocketServer, getIO };
