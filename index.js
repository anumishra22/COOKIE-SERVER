const path = require('path');
const express = require('express');
const login = require('biar-fca');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 5000;

let startTime = Date.now();
const tasks = new Map();
let globalSentCount = 0;

app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

async function sendMessageWithRetry(api, message, threadID, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await new Promise((resolve, reject) => {
                api.sendMessage(message, threadID, (err) => {
                    if (err) {
                        if (err.error === 1545041) reject(new Error('Not in group'));
                        else if (err.error === 1545020) reject(new Error('Message blocked'));
                        else reject(err);
                    } else resolve();
                });
            });
            return { success: true };
        } catch (err) {
            if (attempt === maxRetries) return { success: false, error: err };
            await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
}

async function runTask(taskId) {
    const task = tasks.get(taskId);
    if (!task || !task.running) return;

    try {
        const currentIndex = task.index;
        task.index = (task.index + 1) % task.messages.length;
        
        const hater = task.haters[Math.floor(Math.random() * task.haters.length)] || "";
        const message = `${hater} ${task.messages[currentIndex]}`.trim();

        // Typing indicator
        await new Promise((resolve) => {
            task.api.sendTypingIndicator(task.threadID, () => resolve());
        });
        await new Promise(r => setTimeout(r, 1000));

        const result = await sendMessageWithRetry(task.api, message, task.threadID);
        
        if (result.success) {
            globalSentCount++;
            task.ws.send(JSON.stringify({ 
                type: 'log', 
                message: `✅ [${task.threadID}] Line ${currentIndex + 1}/${task.messages.length}: "${message.substring(0, 30)}..."` 
            }));
        } else {
            task.ws.send(JSON.stringify({ 
                type: 'log', 
                message: `❌ Error: ${result.error?.message}` 
            }));
            
            // Stop if not in group
            if (result.error?.message === 'Not in group') {
                task.running = false;
                clearInterval(task.interval);
                tasks.delete(taskId);
            }
        }
    } catch (error) {
        task.ws.send(JSON.stringify({ type: 'log', message: `❌ Fatal: ${error.message}` }));
        clearInterval(task.interval);
        tasks.delete(taskId);
    }
}

const server = app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws) => {
    let currentTaskId = null;
    
    ws.on('message', async (msg) => {
        let data;
        try { data = JSON.parse(msg); } catch { return; }

        if (data.type === 'start') {
            // Validation
            if (!data.threadID || !data.cookieContent || !data.messageContent) {
                return ws.send(JSON.stringify({ type: 'log', message: '❌ Missing fields' }));
            }
            if (!data.delay || data.delay < 2) { // Minimum 2 seconds for groups
                return ws.send(JSON.stringify({ type: 'log', message: '❌ Delay minimum 2 sec' }));
            }

            let appState;
            try { appState = JSON.parse(data.cookieContent); } 
            catch { appState = data.cookieContent; }

            login({ appState }, async (err, api) => {
                if (err) return ws.send(JSON.stringify({ type: 'log', message: '❌ Login Failed' }));
                
                // Validate group
                try {
                    await new Promise((resolve, reject) => {
                        api.getThreadInfo(data.threadID.toString(), (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                } catch (e) {
                    return ws.send(JSON.stringify({ type: 'log', message: '❌ Invalid Group ID' }));
                }
                
                const taskId = uuidv4();
                currentTaskId = taskId;
                const messages = data.messageContent.split('\n').filter(l => l.trim());
                
                if (messages.length === 0) {
                    return ws.send(JSON.stringify({ type: 'log', message: '❌ No messages' }));
                }
                
                const task = {
                    api, 
                    ws, 
                    threadID: data.threadID.toString(),
                    haters: data.hatersName.split(',').map(h => h.trim()).filter(h => h),
                    messages: messages,
                    index: 0, 
                    running: true
                };
                
                tasks.set(taskId, task);
                
                ws.send(JSON.stringify({ 
                    type: 'log', 
                    message: `📋 Loaded ${messages.length} messages for group ${data.threadID}` 
                }));
                
                // Random delay to avoid spam detection
                const randomDelay = () => (data.delay * 1000) + (Math.random() * 3000);
                task.interval = setInterval(() => runTask(taskId), randomDelay());
                
                ws.send(JSON.stringify({ type: 'task_started', taskId }));
            });
        }

        if (data.type === 'monitor') {
            const diff = Math.floor((Date.now() - startTime) / 1000);
            const uptime = new Date(diff * 1000).toISOString().substr(11, 8);
            ws.send(JSON.stringify({
                type: 'monitor_data', 
                uptime,
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
    
    ws.on('close', () => {
        if (currentTaskId) {
            const task = tasks.get(currentTaskId);
            if (task) {
                clearInterval(task.interval);
                tasks.delete(currentTaskId);
                console.log(`Cleaned up task ${currentTaskId}`);
            }
        }
    });
});
