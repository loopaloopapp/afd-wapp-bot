require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 8080;
const SENT_DB = path.join(__dirname, 'sent_recipes.json');
if (!fs.existsSync(SENT_DB)) fs.writeFileSync(SENT_DB, JSON.stringify([]));

let lastQrData = null;
let botStatus = 'Initializing... ⚙️';
let sock = null;

// --- WEB INTERFACE ---
app.get('/', async (req, res) => {
    if (lastQrData) {
        try {
            const qrImage = await QRCode.toDataURL(lastQrData);
            return res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f0f2f5;"><div style="background:white;padding:40px;border-radius:20px;text-align:center;"><h1>Scan QR Code</h1><img src="${qrImage}" style="width:300px;" /><p>Apri WhatsApp > Dispositivi Collegati > Collega dispositivo</p></div><script>setTimeout(()=>location.reload(),20000);</script></body></html>`);
        } catch (e) {
            return res.send('Errore generazione QR. Ricarica...');
        }
    }
    res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f0f2f5;"><div style="background:white;padding:40px;border-radius:20px;text-align:center;"><h1>Air Fryer Bot</h1><p style="font-size:1.5em;">${botStatus}</p><p>La pagina si aggiornerà automaticamente.</p></div><script>setTimeout(()=>location.reload(),5000);</script></body></html>`);
});

// Health check per Railway
app.get('/health', (req, res) => res.send('OK'));

// Rotta di TEST manuale
app.get('/test-send', async (req, res) => {
    if (!sock) return res.send('Bot non pronto');
    try {
        console.log('🧪 Manual Test Triggered...');
        await checkAndPublish(true); // true forza l'invio anche se duplicata
        res.send('Test inviato! Controlla il canale WhatsApp.');
    } catch (e) {
        res.send('Errore test: ' + e.message);
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server LIVE on port ${PORT}`);
    setTimeout(connectToWhatsApp, 5000); // Avvio ritardato per stabilità
});

// --- BAILEYS WHATSAPP ---
async function connectToWhatsApp() {
    console.log('📱 Connecting to WhatsApp...');
    const { state, saveCreds } = await useMultiFileAuthState('.wwebjs_auth');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`ℹ️ Using WA version: ${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'error' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            lastQrData = qr;
            botStatus = 'Waiting for Scan... 📷';
            console.log('📷 New QR Code available!');
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`❌ Connection closed (Status: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            lastQrData = null;
            botStatus = 'Reconnecting... 🔄';
            if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
        } else if (connection === 'open') {
            console.log('✅ Connected to WhatsApp!');
            lastQrData = null;
            botStatus = 'Bot is Active! ✅';
            startAutomation();
        }
    });
}

// --- AUTOMATION ---
async function startAutomation() {
    console.log('🤖 Automation started...');
    setInterval(async () => {
        try { await checkAndPublish(); } catch (e) { console.error('Loop error:', e.message); }
    }, process.env.CHECK_INTERVAL_MINUTES * 60 * 1000);
    await checkAndPublish();
}

async function checkAndPublish(force = false) {
    const sourceUrl = process.env.WEB_SOURCE_URL;
    const channelId = process.env.WA_CHANNEL_ID;
    
    console.log(`🔎 Checking recipes (force: ${force})...`);
    const { data } = await axios.get(sourceUrl);
    const $ = cheerio.load(data);
    
    const recipeLinks = [];
    $('.recipe-card a.card-link').each((i, el) => {
        const href = $(el).attr('href');
        if (href) recipeLinks.push(new URL(href, sourceUrl).href);
    });

    const sentDb = JSON.parse(fs.readFileSync(SENT_DB));
    const newRecipes = force ? [recipeLinks[0]] : recipeLinks.filter(link => !sentDb.includes(link)).slice(0, 1); 

    for (const link of newRecipes) {
        console.log(`✨ Processing: ${link}`);
        const recipePage = await axios.get(link);
        const $r = cheerio.load(recipePage.data);
        const shareOnClick = $r('#mainShareBtn').attr('onclick');
        if (!shareOnClick) continue;

        const matches = shareOnClick.match(/unifiedShare\s*\(\s*(?:"|').*?(?:"|')\s*,\s*"((?:\\"|[^"])*)"/);
        let message = matches ? matches[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') : null;

        if (message && sock) {
            const delay = Math.floor(Math.random() * (60000 - 30000) + 30000);
            console.log(`⏳ Delay ${Math.round(delay/1000)}s...`);
            await new Promise(res => setTimeout(res, delay));
            await sock.sendMessage(channelId, { text: message });
            sentDb.push(link);
            fs.writeFileSync(SENT_DB, JSON.stringify(sentDb.slice(-100)));
            console.log(`🚀 Sent to channel: ${link}`);
        }
    }
}
