require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);

const { setupDashboardRoutes } = require('./src/routes/dashboardRoutes');
const { setupTelnyxRoutes } = require('./src/routes/telnyxRoutes');
const { setupDeepgramWebSocket } = require('./src/services/deepgramService');
const { setupSonioxWebSocket } = require('./src/services/sonioxService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Initialize Dashboard Routes
const dashboardModule = setupDashboardRoutes(telnyx);
app.use('/api/dashboard', dashboardModule.router);

// Initialize Telnyx Webhook Routes
const telnyxRouter = setupTelnyxRoutes(telnyx);
app.use('/api/telnyx', telnyxRouter);

// Basic health check route
app.get('/', (req, res) => {
    res.send('Telnyx Gateway is running!');
});

// Setup HTTP and WebSocket Servers
const server = http.createServer(app);

// Configure Transcription Provider
const transcriber = process.env.TRANSCRIPT_PROVIDER || 'deepgram';
if (transcriber === 'soniox') {
    setupSonioxWebSocket(server);
} else {
    setupDeepgramWebSocket(server);
}

server.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
    console.log(`Transcription Provider: ${transcriber.toUpperCase()}`);
});
