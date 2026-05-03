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
const PORT = process.env.PORT || 3000;
const SENT_DB = path.join(__dirname, 'sent_recipes.json');
if (!fs.existsSync(SENT_DB)) fs.writeFileSync(SENT_DB, JSON.stringify([]));

let lastQrData = null;
let botStatus = 'Initializing... ⚙️';
let sock = null;

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/', async (req, res) => {
    if (lastQrData) {
        try {
            const qrImage = await QRCode.toDataURL(lastQrData);
            return res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f0f2f5;"><div style="background:white;padding:40px;border-radius:20px;text-align:center;"><h1>Scan QR Code</h1><img src="${qrImage}" style="width:300px;" /><p>Apri WhatsApp > Dispositivi Collegati</p></div><script>setTimeout(()=>location.reload(),15000);</script></body></html>`);
        } catch (e) { return res.send('Errore QR'); }
    }
    res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f0f2f5;"><div style="background:white;padding:40px;border-radius:20px;text-align:center;"><h1>Air Fryer Bot</h1><p style="font-size:1.5em;">${botStatus}</p></div><script>setTimeout(()=>location.reload(),5000);</script></body></html>`);
});

app.get('/test-send', async (req, res) => {
    if (!sock || !sock.user) return res.send('Bot non collegato!');
    try {
        console.log('🧪 Avvio Test Manuale...');
        await checkAndPublish(true); 
        res.send('Test inviato! Controlla sia la tua chat privata che il canale.');
    } catch (e) { res.status(500).send(e.message); }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server on port ${PORT}`);
    setTimeout(connectToWhatsApp, 5000);
});

async function connectToWhatsApp() {
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
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { lastQrData = qr; botStatus = 'Waiting for Scan... 📷'; }
        if (connection === 'close') {
            const statusCode = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
            botStatus = 'Reconnecting... 🔄';
            setTimeout(connectToWhatsApp, 5000);
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Connesso!');
            lastQrData = null;
            botStatus = 'Bot is Active! ✅';
            startAutomation();
        }
    });
}

async function startAutomation() {
    setInterval(async () => {
        try { await checkAndPublish(); } catch (e) { console.error('Loop error:', e.message); }
    }, (process.env.CHECK_INTERVAL_MINUTES || 30) * 60 * 1000);
    await checkAndPublish();
}

async function checkAndPublish(force = false) {
    const sourceUrl = process.env.WEB_SOURCE_URL;
    const channelId = process.env.WA_CHANNEL_ID;
    
    console.log('🔎 Controllo ricette...');
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

        if (message && sock && sock.user) {
            // TEST: Invio a te stesso
            console.log(`📤 Invio a me stesso (${sock.user.id})...`);
            await sock.sendMessage(sock.user.id, { text: '--- TEST BOT ---\n' + message });
            
            // Invio al canale
            console.log(`📤 Invio al canale ${channelId}...`);
            await sock.sendMessage(channelId, { text: message });
            
            if (!force) {
                sentDb.push(link);
                fs.writeFileSync(SENT_DB, JSON.stringify(sentDb.slice(-100)));
            }
        }
    }
}
