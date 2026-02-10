const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Multer setup for file upload
const storage = multer.diskStorage({
  destination: './bot-data/',
  filename: (req, file, cb) => {
    cb(null, 'eric.png');
  }
});
const upload = multer({ storage: storage });

let botProcess = null;
let botActive = false;

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Ensure bot-data directory exists
fs.ensureDirSync('./bot-data');

// Socket connection
io.on('connection', (socket) => {
  console.log('Client connected');
  
  socket.on('start-bot', async (data) => {
    if (botActive) {
      socket.emit('log', { type: 'error', msg: 'Bot already running!' });
      return;
    }

    const { adminUid, appState, photoBase64 } = data;
    
    try {
      // Save photo from base64
      const photoBuffer = Buffer.from(photoBase64.split(',')[1], 'base64');
      await fs.writeFile('./bot-data/eric.png', photoBuffer);
      
      // Save appstate
      await fs.writeJson('./bot-data/appstate.json', JSON.parse(appState));
      
      // Create bot script
      const botScript = `
const login = require("fca-prince-malhotra");
const fs = require("fs");
const io = require('socket.io-client');
const socket = io('http://localhost:3000');

const CONFIG = {
  LOCKED_PHOTO_PATH: "./bot-data/eric.png",
  PREFIX: "/",
  ADMIN_IDS: ["${adminUid}"],
  LOCKED_GROUPS: new Map()
};

socket.on('connect', () => {
  console.log('Bot connected to dashboard');
});

login({ appState: JSON.parse(fs.readFileSync("./bot-data/appstate.json", "utf8")) }, (err, api) => {
  if (err) {
    socket.emit('bot-error', err.message);
    process.exit(1);
  }

  const botID = api.getCurrentUserID();
  socket.emit('bot-log', { type: 'success', msg: '✅ Bot logged in: ' + botID });
  socket.emit('bot-log', { type: 'info', msg: '👤 Admin: ${adminUid}' });
  socket.emit('bot-log', { type: 'info', msg: '📸 Photo: eric.png loaded' });
  socket.emit('bot-log', { type: 'info', msg: '💡 Use /glock in any group to lock photo' });

  api.listenMqtt(async (err, event) => {
    if (err || !event) return;

    // /glock command
    if (event.type === "message" && event.body?.startsWith("/glock")) {
      const { threadID, senderID } = event;
      
      if (!CONFIG.ADMIN_IDS.includes(senderID)) {
        api.sendMessage("❌ Sirf admin!", threadID);
        return socket.emit('bot-log', { type: 'warn', msg: 'Unauthorized /glock by ' + senderID });
      }

      if (!fs.existsSync(CONFIG.LOCKED_PHOTO_PATH)) {
        api.sendMessage("❌ Photo file missing!", threadID);
        return socket.emit('bot-log', { type: 'error', msg: 'Photo file not found!' });
      }

      try {
        await api.changeGroupImage(fs.createReadStream(CONFIG.LOCKED_PHOTO_PATH), threadID);
        CONFIG.LOCKED_GROUPS.set(threadID, { locked: true, time: new Date().toLocaleString() });
        
        api.sendMessage("🔒 Group photo locked!\\nMain ab hamesha yahi photo laga dunga.", threadID);
        socket.emit('bot-log', { type: 'success', msg: '🔒 Group ' + threadID + ' locked' });

      } catch (error) {
        socket.emit('bot-log', { type: 'error', msg: 'Lock failed: ' + error.message });
      }
    }

    // /gcunlock command
    if (event.type === "message" && event.body?.startsWith("/gcunlock")) {
      const { threadID, senderID } = event;
      
      if (!CONFIG.ADMIN_IDS.includes(senderID)) {
        return api.sendMessage("❌ Sirf admin!", threadID);
      }

      CONFIG.LOCKED_GROUPS.delete(threadID);
      api.sendMessage("🔓 Group photo unlocked!", threadID);
      socket.emit('bot-log', { type: 'warn', msg: '🔓 Group ' + threadID + ' unlocked' });
    }

    // /gcstatus command
    if (event.type === "message" && event.body?.startsWith("/gcstatus")) {
      const { threadID } = event;
      const isLocked = CONFIG.LOCKED_GROUPS.has(threadID);
      
      if (isLocked) {
        api.sendMessage("🔒 Status: LOCKED\\nPhoto changes will be reverted.", threadID);
      } else {
        api.sendMessage("🔓 Status: UNLOCKED\\nUse /glock to lock.", threadID);
      }
    }

    // Auto-revert protection
    if (event.type === "event" && event.logMessageType === "log:thread-icon") {
      const { threadID, author } = event;
      
      if (!CONFIG.LOCKED_GROUPS.has(threadID)) return;
      if (author === botID) return;

      socket.emit('bot-log', { type: 'warn', msg: '🚨 Change detected in ' + threadID + ' by ' + author });

      try {
        await api.changeGroupImage(fs.createReadStream(CONFIG.LOCKED_PHOTO_PATH), threadID);
        api.sendMessage("🛡️ Photo protected! Reverted to locked image.", threadID);
        socket.emit('bot-log', { type: 'success', msg: '✅ Reverted: ' + threadID });

      } catch (error) {
        socket.emit('bot-log', { type: 'error', msg: 'Revert failed: ' + error.message });
      }
    }
  });
});
`;

      await fs.writeFile('./bot-data/bot-runner.js', botScript);
      
      socket.emit('bot-log', { type: 'info', msg: '🚀 Starting bot...' });
      
      botProcess = exec('cd bot-data && node bot-runner.js', {
        cwd: process.cwd()
      });

      botProcess.stdout.on('data', (data) => {
        socket.emit('bot-log', { type: 'info', msg: data.toString().trim() });
      });

      botProcess.stderr.on('data', (data) => {
        socket.emit('bot-log', { type: 'error', msg: data.toString().trim() });
      });

      botProcess.on('exit', (code) => {
        botActive = false;
        socket.emit('bot-status', { active: false });
        socket.emit('bot-log', { type: 'warn', msg: 'Bot exited with code ' + code });
      });

      botActive = true;
      socket.emit('bot-status', { active: true });

    } catch (error) {
      socket.emit('bot-log', { type: 'error', msg: 'Setup failed: ' + error.message });
    }
  });

  socket.on('stop-bot', () => {
    if (botProcess) {
      botProcess.kill();
      botProcess = null;
      botActive = false;
      socket.emit('bot-log', { type: 'warn', msg: '🛑 Bot stopped by user' });
      socket.emit('bot-status', { active: false });
    }
  });
});

server.listen(3000, () => {
  console.log('🚀 Server running on http://localhost:3000');
  console.log('📁 Create public folder and place index.html there');
});
