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
        console.log('🧪 DIAGNOSTICA AVVIATA...');
        
        // --- SCANNER CHAT ---
        console.log('🔎 Elenco chat visibili...');
        try {
            const chats = await sock.groupFetchAllParticipating?.() || {};
            console.log('📋 Gruppi trovati:', Object.keys(chats));
            
            // Tentativo alternativo per Newsletter
            console.log('🔎 Tentativo recupero newsletter...');
            const res = await sock.query({
                tag: 'iq',
                attrs: { to: '@newsletter', type: 'get', xmlns: 'w:mex' },
                content: [{ tag: 'query', attrs: { query_id: '6620195908089573' }, content: [] }]
            });
            console.log('📋 Risposta Newsletter Mex:', JSON.stringify(res, null, 2));
        } catch (e) { console.log('⚠️ Errore durante lo scan:', e.message); }

        await checkAndPublish(true); 
        res.send('Test eseguito! Guarda i log di Railway.');
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
        browser: ['Mac OS', 'Chrome', '121.0.6167.184'], // Browser più comune
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    // --- SCOPERTA ID CANALE ---
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            console.log(`📩 MESSAGGIO RICEVUTO DA: ${msg.key.remoteJid}`);
            console.log(`📝 CONTENUTO: ${msg.message?.conversation || msg.message?.extendedTextMessage?.text}`);
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { lastQrData = qr; botStatus = 'Waiting for Scan... 📷'; }
        if (connection === 'close') {
            const statusCode = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
            botStatus = 'Reconnecting... 🔄';
            setTimeout(connectToWhatsApp, 5000);
        } else if (connection === 'open') {
            const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            console.log(`✅ WhatsApp Connesso come: ${myJid}`);
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
            const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            
            console.log(`📤 Invio a me stesso (${myJid})...`);
            try {
                await sock.sendMessage(myJid, { text: 'BOT AIR FRYER: TEST\n' + message });
                console.log('✅ Inviato a se stesso');
            } catch (e) { console.log('❌ Errore se stesso:', e.message); }
            
            console.log(`📤 Invio al canale (${channelId})...`);
            try {
                await sock.sendMessage(channelId, { text: message });
                console.log('✅ Inviato al canale');
            } catch (e) { console.log('❌ Errore canale:', e.message); }
            
            if (!force) {
                sentDb.push(link);
                fs.writeFileSync(SENT_DB, JSON.stringify(sentDb.slice(-100)));
            }
        }
    }
}
