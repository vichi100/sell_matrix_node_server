require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);

const { setupDashboardRoutes } = require('./src/routes/dashboardRoutes');
const { setupTelnyxRoutes } = require('./src/routes/telnyxRoutes');
const { setupDeepgramWebSocket } = require('./src/services/deepgramService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Initialize Dashboard Routes and get the shared activeCalls Map
const dashboardModule = setupDashboardRoutes(telnyx);
app.use('/api', dashboardModule.router);

// Initialize Telnyx Webhook Routes
const telnyxRouter = setupTelnyxRoutes(telnyx, dashboardModule.activeCalls);
app.use('/api/telnyx', telnyxRouter);

// Basic health check route
app.get('/', (req, res) => {
    res.send('Telnyx Gateway is running!');
});

// Setup HTTP and WebSocket Servers
const server = http.createServer(app);
setupDeepgramWebSocket(server, dashboardModule.activeCalls);

server.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
