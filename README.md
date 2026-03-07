# Telnyx Real-time NodeJS Express Gateway

This is a real-time Node.js Express gateway for a telephony AI application using Telnyx. It listens for incoming Telnyx calls via webhooks, answers them, and streams the call audio to a local WebSocket server.

## Features
- Express API server
- Telnyx Webhook handling (`call.initiated` and `call.answered`)
- WebSocket server to receive streaming audio chunks

## Prerequisites
- Node.js installed
- A [Telnyx](https://telnyx.com/) account and an active phone number pointing to your webhook URL.
- [ngrok](https://ngrok.com/) to expose your local server to the Internet.

## Setup Instructions

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure Environment Variables:**
   Copy `.env.example` to `.env` and configure your API keys and endpoints:
   ```bash
   cp .env.example .env
   ```
   Provide your `TELNYX_API_KEY` and your updated `NGROK_URL` (starting with `wss://`).

3. **Start the server:**
   - For production:
     ```bash
     npm start
     ```
   - For local development (auto-restarts on save) DEBUG Mode:
     ```bash
     npm run dev
     ```
   - To force stop the server (if it gets stuck in the background):
     ```bash
     npm run stop
     ```

4. **Expose your server to the Internet (for Local Webhook Testing):**
   Telnyx requires a public `https://` URL to send webhook events perfectly. The easiest way to get one without making an account is using **Pinggy**.
   In a new terminal window, run:
   ```bash
   ssh -p 443 -R0:localhost:3000 a.pinggy.io
   ```
   **Output:** It will give you an `http://...pinggy.link` URL. 

5. **Update Telnyx portal & Config:**
   - Create a Call Control Application in your Telnyx Portal.
   - Set the Webhook URL to `https://<your-pinggy-url>/api/telnyx/webhook`.
   - Update your `.env` file's `WEBSOCKET_URL` to the forwarding URL created by pinggy (e.g., `wss://<your-pinggy-url>/media-stream`).
   - Assign your Telnyx phone number to this Call Control application.

## Testing
Call your Telnyx phone number. Your server terminal should show `Call initiated...`, `Call answered...`, and shortly after, `Receiving audio chunk...` as the WebRTC stream connects to your WebSocket.


###### Local debug #######

1. Start the actual server (Terminal 1)
Make sure you are in the project directory, then run:

bash
npm run dev
2. Start the tunneling service (Terminal 2)
In a completely separate terminal tab, run:

bash
ssh -p 443 -R0:localhost:3000 a.pinggy.io
3. Update Configuration
Grab the http://...pinggy.link URL it prints out, and:

Put https://<that-url>/api/telnyx/webhook in your Telnyx Webhook portal.
Put WEBSOCKET_URL=wss://<that-url>/media-stream in your 

.env
 file.
Once you save the 

.env
 file, nodemon instantly restarts your server, and you're ready to receive calls! Let me know if you run into any other issues!

 ####