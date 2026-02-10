const path = require('path');
const express = require('express');
const login = require('biar-fca'); // ✅ FIXED: fca library is usually a function itself
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 5000;

let startTime = Date.now();
const tasks = new Map();
let globalSentCount = 0;

// ✅ FIXED: Isse "Cannot GET /" wala error khatam ho jayega
app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

async function runTask(taskId) {
    const task = tasks.get(taskId);
    if (!task || !task.running) return;

    if (task.index >= task.messages.length) task.index = 0;
    
    const hater = task.haters[Math.floor(Math.random() * task.haters.length)] || "";
    const message = `${hater} ${task.messages[task.index]}`.trim();

    task.api.sendMessage(message, task.threadID, (err) => {
        if (!err) {
            task.index++;
            globalSentCount++;
            task.ws.send(JSON.stringify({ type: 'log', message: `✅ Line ${task.index} sent` }));
        } else {
            const errorMsg = err.errorDescription || err.message || "Unknown FB Error";
            task.ws.send(JSON.stringify({ type: 'log', message: `❌ Error: ${errorMsg}` }));
            console.error(`[Task ${taskId}] Send error:`, err);
        }
    });
}

const server = app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws) => {
    ws.on('message', async (msg) => {
        let data;
        try { data = JSON.parse(msg); } catch { return; }

        if (data.type === 'start') {
            let appState;
            try { appState = JSON.parse(data.cookieContent); } catch { appState = data.cookieContent; }

            // ✅ FIXED: wiegine is not a function error solved here
            login({ appState }, (err, api) => {
                if (err) return ws.send(JSON.stringify({ type: 'log', message: '❌ Login Failed: Check Cookies' }));
                
                const taskId = uuidv4();
                const task = {
                    api, ws, threadID: data.threadID,
                    haters: data.hatersName.split(','),
                    messages: data.messageContent.split('\n').filter(l => l.trim()),
                    index: 0, running: true
                };
                tasks.set(taskId, task);
                
                task.interval = setInterval(() => runTask(taskId), data.delay * 1000);
                ws.send(JSON.stringify({ type: 'task_started', taskId }));
            });
        }

        if (data.type === 'monitor') {
            const diff = Math.floor((Date.now() - startTime) / 1000);
            const uptime = new Date(diff * 1000).toISOString().substr(11, 8);
            ws.send(JSON.stringify({
                type: 'monitor_data', uptime,
                activeTasks: tasks.size,
                totalSent: globalSentCount
            }));
        }
        
        if (data.type === 'stop_by_id') {
            const task = tasks.get(data.taskId);
            if (task) {
                clearInterval(task.interval);
                tasks.delete(data.taskId);
                ws.send(JSON.stringify({ type: 'stopped', taskId: data.taskId }));
            }
        }
    });
});
