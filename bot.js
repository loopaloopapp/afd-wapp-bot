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
const AUTH_DIR = path.join(__dirname, '.wwebjs_auth');
const SENT_DB = path.join(AUTH_DIR, 'sent_recipes.json'); // Salviamo nel volume per persistenza

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
if (!fs.existsSync(SENT_DB)) fs.writeFileSync(SENT_DB, JSON.stringify([]));

let lastQrData = null;
let botStatus = 'Initializing... ⚙️';
let sock = null;

// --- WEB INTERFACE ---
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
        await checkAndPublish(true); 
        res.send('Test inviato al canale con foto!');
    } catch (e) { res.status(500).send(e.message); }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server on port ${PORT}`);
    setTimeout(connectToWhatsApp, 5000);
});

// --- WHATSAPP LOGIC ---
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version = [2, 3000, 1015901307];
    try {
        const latest = await fetchLatestBaileysVersion();
        if (latest && latest.version) version = latest.version;
    } catch (e) {}

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'error' }),
        browser: ['Mac OS', 'Chrome', '121.0.6167.184'],
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
            lastQrData = null;
            botStatus = 'Bot is Active! ✅';
            console.log('✅ WhatsApp Connesso');
            startAutomation();
        }
    });
}

async function startAutomation() {
    const interval = (process.env.CHECK_INTERVAL_MINUTES || 30) * 60 * 1000;
    setInterval(async () => {
        try { await checkAndPublish(); } catch (e) { console.error('Loop error:', e.message); }
    }, interval);
    await checkAndPublish();
}

async function checkAndPublish(force = false) {
    const sourceUrl = process.env.WEB_SOURCE_URL;
    let channelId = process.env.WA_CHANNEL_ID;
    if (!channelId || channelId.startsWith('0029')) channelId = '120363425032237179@newsletter';

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
        try {
            const recipePage = await axios.get(link);
            const $r = cheerio.load(recipePage.data);
            
            // Estrazione Immagine
            const imageUrl = $r('meta[property="og:image"]').attr('content') || $r('.recipe-header img').attr('src');
            const absoluteImageUrl = imageUrl ? new URL(imageUrl, link).href : null;

            // Estrazione Messaggio Share
            const shareOnClick = $r('#mainShareBtn').attr('onclick');
            if (!shareOnClick) continue;
            
            // Estrazione e decodifica corretta della stringa JS
            const matches = shareOnClick.match(/unifiedShare\s*\(\s*(?:"|').*?(?:"|')\s*,\s*"((?:\\"|[^"])*)"/);
            let message = null;
            if (matches) {
                try {
                    // Usiamo JSON.parse per decodificare correttamente unicode ed escape
                    message = JSON.parse(`"${matches[1]}"`);
                } catch (e) {
                    // Fallback se JSON.parse fallisce
                    message = matches[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\//g, '/');
                }
            }

            if (message && sock && sock.user) {
                // Miglioriamo ulteriormente il formato: Titolo in Grassetto
                // Assumiamo che la prima riga sia il titolo
                const lines = message.split('\n');
                if (lines.length > 0) {
                    lines[0] = `*${lines[0].trim()}*`;
                    message = lines.join('\n');
                }
                console.log(`🚀 Pubblicazione ricetta con foto: ${link}`);
                
                if (absoluteImageUrl) {
                    // Invio con FOTO
                    await sock.sendMessage(channelId, { 
                        image: { url: absoluteImageUrl },
                        caption: message
                    });
                } else {
                    // Solo testo se manca foto
                    await sock.sendMessage(channelId, { text: message });
                }

                if (!force) {
                    sentDb.push(link);
                    fs.writeFileSync(SENT_DB, JSON.stringify(sentDb.slice(-100)));
                }
            }
        } catch (err) {
            console.error(`❌ Errore ricetta ${link}:`, err.message);
        }
    }
}
