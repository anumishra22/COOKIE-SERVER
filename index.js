const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" }
});

let botProcess = null;
let botActive = false;
let currentSocket = null;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure directories exist
fs.ensureDirSync('./bot-data');

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket connection
io.on('connection', (socket) => {
    console.log('✅ Client connected:', socket.id);
    currentSocket = socket;
    
    socket.emit('bot-log', { type: 'info', msg: '🟢 Connected to server' });

    socket.on('start-bot', async (data) => {
        console.log('🚀 Start bot request received');
        
        if (botActive) {
            socket.emit('bot-log', { type: 'error', msg: '❌ Bot already running!' });
            return;
        }

        const { adminUid, appState, photoBase64 } = data;
        
        // Validation
        if (!adminUid || !appState || !photoBase64) {
            socket.emit('bot-log', { type: 'error', msg: '❌ Missing required fields!' });
            return;
        }

        try {
            socket.emit('bot-log', { type: 'info', msg: '💾 Saving photo...' });
            
            // Save photo from base64
            const base64Data = photoBase64.replace(/^data:image\/\w+;base64,/, '');
            const photoBuffer = Buffer.from(base64Data, 'base64');
            await fs.writeFile('./bot-data/eric.png', photoBuffer);
            socket.emit('bot-log', { type: 'success', msg: '✅ Photo saved (eric.png)' });

            // Save appstate
            socket.emit('bot-log', { type: 'info', msg: '💾 Saving appstate...' });
            await fs.writeFile('./bot-data/appstate.json', appState);
            socket.emit('bot-log', { type: 'success', msg: '✅ AppState saved' });

            // Create bot script - NO socket.io-client, uses console.log
            socket.emit('bot-log', { type: 'info', msg: '📝 Creating bot script...' });
            
            const botScript = `const login = require("fca-prince-malhotra");
const fs = require("fs");

const CONFIG = {
  LOCKED_PHOTO_PATH: "./bot-data/eric.png",
  PREFIX: "/",
  ADMIN_IDS: ["${adminUid}"],
  LOCKED_GROUPS: new Map()
};

console.log("BOT_STARTING");

login({ appState: JSON.parse(fs.readFileSync("./bot-data/appstate.json", "utf8")) }, (err, api) => {
  if (err) {
    console.error("LOGIN_ERROR:", err.message);
    process.exit(1);
  }

  const botID = api.getCurrentUserID();
  console.log("BOT_LOGGED_IN:" + botID);
  console.log("BOT_READY");

  api.listenMqtt(async (err, event) => {
    if (err || !event) return;

    if (event.type === "message" && event.body?.startsWith("/glock")) {
      const { threadID, senderID } = event;
      
      if (!CONFIG.ADMIN_IDS.includes(senderID)) {
        api.sendMessage("❌ Sirf admin!", threadID);
        return console.log("UNAUTHORIZED_LOCK:" + senderID);
      }

      try {
        await api.changeGroupImage(fs.createReadStream(CONFIG.LOCKED_PHOTO_PATH), threadID);
        CONFIG.LOCKED_GROUPS.set(threadID, { locked: true, time: new Date().toLocaleString() });
        api.sendMessage("🔒 Group photo locked!\\nMain ab hamesha yahi photo laga dunga.", threadID);
        console.log("GROUP_LOCKED:" + threadID);
      } catch (error) {
        console.error("LOCK_FAILED:" + error.message);
      }
    }

    if (event.type === "event" && event.logMessageType === "log:thread-icon") {
      const { threadID, author } = event;
      if (!CONFIG.LOCKED_GROUPS.has(threadID)) return;
      if (author === botID) return;

      console.log("CHANGE_DETECTED:" + threadID + ":" + author);
      try {
        await api.changeGroupImage(fs.createReadStream(CONFIG.LOCKED_PHOTO_PATH), threadID);
        api.sendMessage("🛡️ Photo protected! Reverted to locked image.", threadID);
        console.log("PHOTO_REVERTED:" + threadID);
      } catch (error) {
        console.error("REVERT_FAILED:" + error.message);
      }
    }
  });
});`;

            await fs.writeFile('./bot-data/bot-runner.js', botScript);
            socket.emit('bot-log', { type: 'success', msg: '✅ Bot script created' });

            // Start bot using spawn (better than exec)
            socket.emit('bot-log', { type: 'info', msg: '🚀 Starting FCA bot...' });
            
            botProcess = spawn('node', ['bot-data/bot-runner.js'], {
                cwd: __dirname,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            // Handle stdout
            botProcess.stdout.on('data', (data) => {
                const lines = data.toString().trim().split('\n');
                lines.forEach(line => {
                    if (!line) return;
                    
                    // Parse special log formats
                    if (line.startsWith('BOT_LOGGED_IN:')) {
                        const botId = line.split(':')[1];
                        socket.emit('bot-log', { type: 'success', msg: '✅ Bot logged in: ' + botId });
                    } else if (line.startsWith('BOT_READY')) {
                        socket.emit('bot-log', { type: 'info', msg: '👤 Admin: ' + adminUid });
                        socket.emit('bot-log', { type: 'info', msg: '📸 Photo loaded: eric.png' });
                        socket.emit('bot-log', { type: 'info', msg: '💡 Use /glock in any group to lock photo' });
                    } else if (line.startsWith('GROUP_LOCKED:')) {
                        const threadId = line.split(':')[1];
                        socket.emit('bot-log', { type: 'success', msg: '🔒 Group ' + threadId + ' locked' });
                    } else if (line.startsWith('CHANGE_DETECTED:')) {
                        const parts = line.split(':');
                        socket.emit('bot-log', { type: 'warn', msg: '🚨 Change detected in ' + parts[1] + ' by ' + parts[2] });
                    } else if (line.startsWith('PHOTO_REVERTED:')) {
                        const threadId = line.split(':')[1];
                        socket.emit('bot-log', { type: 'success', msg: '✅ Reverted: ' + threadId });
                    } else if (line.startsWith('UNAUTHORIZED_LOCK:')) {
                        const userId = line.split(':')[1];
                        socket.emit('bot-log', { type: 'warn', msg: 'Unauthorized /glock by ' + userId });
                    } else {
                        socket.emit('bot-log', { type: 'info', msg: line });
                    }
                });
            });

            // Handle stderr
            botProcess.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) socket.emit('bot-log', { type: 'error', msg: msg });
            });

            // Handle errors
            botProcess.on('error', (err) => {
                socket.emit('bot-log', { type: 'error', msg: 'Process error: ' + err.message });
            });

            // Handle exit
            botProcess.on('exit', (code) => {
                botActive = false;
                socket.emit('bot-status', { active: false });
                socket.emit('bot-log', { type: 'warn', msg: 'Bot exited (code: ' + code + ')' });
            });

            botActive = true;
            socket.emit('bot-status', { active: true });
            socket.emit('bot-log', { type: 'success', msg: '🟢 Bot started successfully!' });

        } catch (error) {
            console.error('Setup error:', error);
            socket.emit('bot-log', { type: 'error', msg: '❌ Setup failed: ' + error.message });
        }
    });

    socket.on('stop-bot', () => {
        if (botProcess) {
            botProcess.kill();
            botProcess = null;
            botActive = false;
            socket.emit('bot-log', { type: 'warn', msg: '🛑 Bot stopped' });
            socket.emit('bot-status', { active: false });
        }
    });

    socket.on('disconnect', () => {
        console.log('❌ Client disconnected:', socket.id);
        currentSocket = null;
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('🚀 Server running on http://localhost:' + PORT);
});
