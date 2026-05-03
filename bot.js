require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
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
        const qrImage = await QRCode.toDataURL(lastQrData);
        res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f0f2f5;"><div style="background:white;padding:40px;border-radius:20px;text-align:center;"><h1>Scan QR Code</h1><img src="${qrImage}" /><p>Scansiona con WhatsApp</p></div><script>setTimeout(()=>location.reload(),20000);</script></body></html>`);
    } else {
        res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f0f2f5;"><div style="background:white;padding:40px;border-radius:20px;text-align:center;"><h1>Air Fryer Bot</h1><p>${botStatus}</p></div><script>setTimeout(()=>location.reload(),5000);</script></body></html>`);
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server LIVE on port ${PORT}`));

// --- BAILEYS WHATSAPP ---
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('.wwebjs_auth');
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'info' }), // Aumentiamo il log per vedere meglio cosa succede
        browser: ['Ubuntu', 'Chrome', '20.0.04'] // Stringa standard più sicura
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            lastQrData = qr;
            botStatus = 'Waiting for Scan... 📷';
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            lastQrData = null;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ Connected to WhatsApp!');
            lastQrData = null;
            botStatus = 'Working! ✅';
            startAutomation();
        }
    });
}

// --- AUTOMATION ---
async function startAutomation() {
    setInterval(async () => {
        try { await checkAndPublish(); } catch (e) { console.error('Loop error:', e.message); }
    }, process.env.CHECK_INTERVAL_MINUTES * 60 * 1000);
    await checkAndPublish();
}

async function checkAndPublish() {
    const sourceUrl = process.env.WEB_SOURCE_URL;
    const channelId = process.env.WA_CHANNEL_ID;
    
    console.log('🔎 Checking recipes...');
    const { data } = await axios.get(sourceUrl);
    const $ = cheerio.load(data);
    
    const recipeLinks = [];
    $('.recipe-card a.card-link').each((i, el) => {
        const href = $(el).attr('href');
        if (href) recipeLinks.push(new URL(href, sourceUrl).href);
    });

    const sentDb = JSON.parse(fs.readFileSync(SENT_DB));
    const newRecipes = recipeLinks.filter(link => !sentDb.includes(link)).slice(0, 1); 

    for (const link of newRecipes) {
        const recipePage = await axios.get(link);
        const $r = cheerio.load(recipePage.data);
        const shareOnClick = $r('#mainShareBtn').attr('onclick');
        if (!shareOnClick) continue;

        const matches = shareOnClick.match(/unifiedShare\s*\(\s*(?:"|').*?(?:"|')\s*,\s*"((?:\\"|[^"])*)"/);
        let message = matches ? matches[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') : null;

        if (message && sock) {
            // Anti-ban delay
            const delay = Math.floor(Math.random() * (120000 - 45000) + 45000);
            console.log(`⏳ Waiting ${Math.round(delay/1000)}s...`);
            await new Promise(res => setTimeout(res, delay));

            // Invio messaggio
            await sock.sendMessage(channelId, { text: message });
            
            sentDb.push(link);
            fs.writeFileSync(SENT_DB, JSON.stringify(sentDb.slice(-100)));
            console.log(`🚀 Sent: ${link}`);
        }
    }
}

connectToWhatsApp();
