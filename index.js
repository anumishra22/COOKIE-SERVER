const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store active sessions
const sessions = new Map();

// Parse cookies from string
function parseCookies(cookieString) {
    const cookies = {};
    if (!cookieString) return cookies;
    
    cookieString.split(';').forEach(cookie => {
        const [name, value] = cookie.trim().split('=');
        if (name && value) {
            cookies[name.trim()] = value.trim();
        }
    });
    return cookies;
}

// Extract fb_dtsg from cookies or make request to get it
async function getFbDtsg(cookies) {
    try {
        const cookieString = Object.entries(cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');

        const response = await axios.get('https://www.facebook.com/', {
            headers: {
                'Cookie': cookieString,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        // Extract fb_dtsg from response
        const match = response.data.match(/"DTSGInitialData",\[\],{"token":"([^"]+)"/);
        if (match) return match[1];

        const match2 = response.data.match(/name="fb_dtsg" value="([^"]+)"/);
        if (match2) return match2[1];

        return null;
    } catch (error) {
        console.error('Error getting fb_dtsg:', error.message);
        return null;
    }
}

// Send message to Facebook thread
async function sendMessage(cookies, threadId, message, fbDtsg) {
    try {
        const cookieString = Object.entries(cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');

        const formData = new FormData();
        formData.append('fb_dtsg', fbDtsg);
        formData.append('body', message);
        formData.append('send', 'Send');
        formData.append('thread_id', threadId);
        formData.append('__user', cookies.c_user || '');
        formData.append('__a', '1');
        formData.append('__req', '1');

        const response = await axios.post(
            `https://www.facebook.com/messages/send/?icm=1`,
            formData,
            {
                headers: {
                    ...formData.getHeaders(),
                    'Cookie': cookieString,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': `https://www.facebook.com/messages/t/${threadId}`
                }
            }
        );

        return { success: true, data: response.data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('New client connected');
    let currentSessionId = null;

    // Send initial connection success
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to automation server'
    }));

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            console.log('Received:', message.type);

            switch (message.type) {
                case 'start':
                    await handleStart(ws, message);
                    break;

                case 'stop':
                    handleStop(ws, message.sessionId);
                    break;

                case 'view_session':
                    handleViewSession(ws, message.sessionId);
                    break;

                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;

                default:
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Unknown command'
                    }));
            }
        } catch (error) {
            console.error('Error processing message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: error.message
            }));
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Handle start automation
async function handleStart(ws, data) {
    const { cookiesContent, messageContent, threadID, delay, prefix } = data;

    // Generate session ID
    const sessionId = 'sess_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

    // Parse cookies
    let cookies;
    try {
        cookies = JSON.parse(cookiesContent);
    } catch {
        cookies = parseCookies(cookiesContent);
    }

    // Parse messages
    const messages = messageContent.split('\n').filter(m => m.trim());

    if (messages.length === 0) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'No messages provided'
        }));
        return;
    }

    // Get fb_dtsg
    ws.send(JSON.stringify({
        type: 'log',
        message: 'Authenticating with Facebook...',
        logType: 'info'
    }));

    const fbDtsg = await getFbDtsg(cookies);

    if (!fbDtsg) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Failed to authenticate. Invalid cookies.'
        }));
        return;
    }

    ws.send(JSON.stringify({
        type: 'log',
        message: 'Authentication successful!',
        logType: 'success'
    }));

    // Create session
    const session = {
        id: sessionId,
        status: 'running',
        totalSent: 0,
        loopCount: 0,
        started: new Date().toLocaleString(),
        threadId: threadID,
        cookies,
        messages,
        delay: delay || 5,
        prefix: prefix || '',
        fbDtsg,
        ws,
        stopRequested: false
    };

    sessions.set(sessionId, session);

    // Send session info to client
    ws.send(JSON.stringify({
        type: 'session',
        sessionId
    }));

    ws.send(JSON.stringify({
        type: 'log',
        message: `Session started: ${sessionId}`,
        logType: 'success'
    }));

    ws.send(JSON.stringify({
        type: 'log',
        message: `Target Thread ID: ${threadID}`,
        logType: 'info'
    }));

    ws.send(JSON.stringify({
        type: 'log',
        message: `Total messages: ${messages.length}`,
        logType: 'info'
    }));

    // Start sending messages
    await runAutomation(session);
}

// Run automation loop
async function runAutomation(session) {
    const { ws, messages, threadId, delay, prefix, cookies, fbDtsg } = session;

    for (let i = 0; i < messages.length; i++) {
        if (session.stopRequested) {
            ws.send(JSON.stringify({
                type: 'log',
                message: 'Automation stopped by user',
                logType: 'warning'
            }));
            session.status = 'stopped';
            updateStats(session);
            return;
        }

        const message = prefix ? `${prefix} ${messages[i]}` : messages[i];

        ws.send(JSON.stringify({
            type: 'log',
            message: `Sending message ${i + 1}/${messages.length}: ${message.substring(0, 50)}...`,
            logType: 'info'
        }));

        ws.send(JSON.stringify({
            type: 'stats',
            currentMessage: message,
            progress: `${i + 1}/${messages.length}`
        }));

        // Send message
        const result = await sendMessage(cookies, threadId, message, fbDtsg);

        if (result.success) {
            session.totalSent++;
            ws.send(JSON.stringify({
                type: 'log',
                message: `Message ${i + 1} sent successfully!`,
                logType: 'success'
            }));
        } else {
            ws.send(JSON.stringify({
                type: 'log',
                message: `Failed to send message ${i + 1}: ${result.error}`,
                logType: 'error'
            }));
        }

        updateStats(session);

        // Wait before next message
        if (i < messages.length - 1) {
            await new Promise(resolve => setTimeout(resolve, delay * 1000));
        }
    }

    session.status = 'completed';
    session.loopCount++;
    updateStats(session);

    ws.send(JSON.stringify({
        type: 'log',
        message: 'All messages sent successfully!',
        logType: 'success'
    }));

    ws.send(JSON.stringify({
        type: 'completed',
        sessionId: session.id,
        totalSent: session.totalSent
    }));
}

// Update stats
function updateStats(session) {
    session.ws.send(JSON.stringify({
        type: 'stats',
        sessionId: session.id,
        status: session.status,
        totalSent: session.totalSent,
        loopCount: session.loopCount,
        started: session.started
    }));
}

// Handle stop
function handleStop(ws, sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
        session.stopRequested = true;
        ws.send(JSON.stringify({
            type: 'log',
            message: `Stop requested for session: ${sessionId}`,
            logType: 'warning'
        }));
    } else {
        ws.send(JSON.stringify({
            type: 'error',
            message: `Session not found: ${sessionId}`
        }));
    }
}

// Handle view session
function handleViewSession(ws, sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
        ws.send(JSON.stringify({
            type: 'session_details',
            sessionId: session.id,
            status: session.status,
            totalSent: session.totalSent,
            loopCount: session.loopCount,
            started: session.started,
            threadId: session.threadId
        }));
    } else {
        ws.send(JSON.stringify({
            type: 'error',
            message: `Session not found: ${sessionId}`
        }));
    }
}

// HTTP Routes
app.get('/api/sessions', (req, res) => {
    const sessionList = Array.from(sessions.values()).map(s => ({
        id: s.id,
        status: s.status,
        totalSent: s.totalSent,
        threadId: s.threadId,
        started: s.started
    }));
    res.json(sessionList);
});

app.get('/api/sessions/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (session) {
        res.json({
            id: session.id,
            status: session.status,
            totalSent: session.totalSent,
            loopCount: session.loopCount,
            started: session.started,
            threadId: session.threadId
        });
    } else {
        res.status(404).json({ error: 'Session not found' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        activeSessions: sessions.size
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Cookie Automation Server running on port ${PORT}`);
    console.log(`📱 WebSocket server ready`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = { app, server, wss };
