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

// LOG IMMEDIATO PER DIAGNOSTICA
console.log('--- STARTING UP ---');
console.log('PORT ENV:', process.env.PORT);

const app = express();
const PORT = process.env.PORT || 3000;
const SENT_DB = path.join(__dirname, 'sent_recipes.json');

if (!fs.existsSync(SENT_DB)) fs.writeFileSync(SENT_DB, JSON.stringify([]));

let lastQrData = null;
let botStatus = 'Initializing... ⚙️';
let sock = null;

// --- ROUTES ---
app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/', async (req, res) => {
    if (lastQrData) {
        try {
            const qrImage = await QRCode.toDataURL(lastQrData);
            return res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f0f2f5;"><div style="background:white;padding:40px;border-radius:20px;text-align:center;"><h1>Scan QR Code</h1><img src="${qrImage}" style="width:300px;" /><p>Apri WhatsApp > Dispositivi Collegati</p></div><script>setTimeout(()=>location.reload(),15000);</script></body></html>`);
        } catch (e) {
            return res.send('Errore generazione QR. Ricarica...');
        }
    }
    res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f0f2f5;"><div style="background:white;padding:40px;border-radius:20px;text-align:center;"><h1>Air Fryer Bot</h1><p style="font-size:1.5em;">${botStatus}</p></div><script>setTimeout(()=>location.reload(),5000);</script></body></html>`);
});

app.get('/test-send', async (req, res) => {
    const isConnected = sock && sock.user && sock.user.id;
    if (!isConnected) return res.send('Bot non collegato!');
    try {
        await checkAndPublish(true); 
        res.send('Test inviato!');
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// START SERVER
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server listening on port ${PORT}`);
    setTimeout(connectToWhatsApp, 10000); // 10 secondi di respiro prima di WA
});

async function connectToWhatsApp() {
    console.log('📱 Connecting to WhatsApp...');
    try {
        const { state, saveCreds } = await useMultiFileAuthState('.wwebjs_auth');
        let version = [2, 3000, 1015901307]; 
        try {
            const latest = await fetchLatestBaileysVersion();
            if (latest && latest.version) version = latest.version;
        } catch (e) {}

        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'error' }),
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            connectTimeoutMs: 60000,
            printQRInTerminal: false
        });

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                lastQrData = qr;
                botStatus = 'Waiting for Scan... 📷';
            }
            if (connection === 'close') {
                const statusCode = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`❌ Closed. Reconnect: ${shouldReconnect}`);
                lastQrData = null;
                botStatus = 'Reconnecting... 🔄';
                if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
            } else if (connection === 'open') {
                console.log('✅ Connected!');
                lastQrData = null;
                botStatus = 'Bot is Active! ✅';
                startAutomation();
            }
        });
    } catch (err) {
        console.error('❌ Error:', err);
        setTimeout(connectToWhatsApp, 15000);
    }
}

async function startAutomation() {
    setInterval(async () => {
        try { await checkAndPublish(); } catch (e) { console.error('Loop error:', e.message); }
    }, process.env.CHECK_INTERVAL_MINUTES * 60 * 1000);
    await checkAndPublish();
}

async function checkAndPublish(force = false) {
    const sourceUrl = process.env.WEB_SOURCE_URL;
    const channelId = process.env.WA_CHANNEL_ID;
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
        const recipePage = await axios.get(link);
        const $r = cheerio.load(recipePage.data);
        const shareOnClick = $r('#mainShareBtn').attr('onclick');
        if (!shareOnClick) continue;
        const matches = shareOnClick.match(/unifiedShare\s*\(\s*(?:"|').*?(?:"|')\s*,\s*"((?:\\"|[^"])*)"/);
        let message = matches ? matches[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') : null;
        if (message && sock && sock.user && sock.user.id) {
            await new Promise(res => setTimeout(res, 2000));
            await sock.sendMessage(channelId, { text: message });
            if (!force) {
                sentDb.push(link);
                fs.writeFileSync(SENT_DB, JSON.stringify(sentDb.slice(-100)));
            }
        }
    }
}
