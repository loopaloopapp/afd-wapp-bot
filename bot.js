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

// LOG DI AVVIO PER VERIFICA VARIABILI
console.log('--- ENV CHECK ---');
console.log('WEB_SOURCE_URL:', process.env.WEB_SOURCE_URL);
console.log('WA_CHANNEL_ID:', process.env.WA_CHANNEL_ID);
console.log('CHECK_INTERVAL:', process.env.CHECK_INTERVAL_MINUTES);
console.log('-----------------');

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
    const isConnected = sock && sock.user && sock.user.id;
    if (!isConnected) {
        return res.status(500).send(`
            <h1>Bot non collegato ❌</h1>
            <p>Devi prima scansionare il QR code nella <a href="/">Home</a>.</p>
            <p>Stato attuale: ${botStatus}</p>
        `);
    }
    
    try {
        console.log('🧪 Manual Test Triggered...');
        
        // Diagnostica: Vediamo quali canali/gruppi vede il bot
        console.log('🔎 Cerco canali/newsletter disponibili...');
        // Nota: Baileys carica i metadati dei gruppi/canali man mano
        
        await checkAndPublish(true); 
        res.send('Test inviato con successo! Controlla WhatsApp.');
    } catch (e) {
        console.error('❌ Test Route Error:', e);
        res.status(500).send(`
            <h1>Errore durante il test</h1>
            <pre style="background:#fff2f2; padding:20px; border:1px solid red;">${e.stack}</pre>
        `);
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server LIVE on port ${PORT}`);
    setTimeout(connectToWhatsApp, 5000);
});

// --- BAILEYS WHATSAPP ---
async function connectToWhatsApp() {
    console.log('📱 Connecting to WhatsApp...');
    try {
        const { state, saveCreds } = await useMultiFileAuthState('.wwebjs_auth');
        
        let version = [2, 3000, 1015901307]; 
        try {
            const latest = await fetchLatestBaileysVersion();
            if (latest && latest.version) version = latest.version;
        } catch (e) {
            console.log('⚠️ Usando versione WhatsApp di fallback');
        }

        console.log(`ℹ️ WhatsApp version: ${version.join('.')}`);

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
    } catch (err) {
        console.error('❌ Error in connectToWhatsApp:', err);
        setTimeout(connectToWhatsApp, 10000);
    }
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
    try {
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

            if (message && sock && sock.user && sock.user.id) {
                try {
                    const delay = force ? 1000 : Math.floor(Math.random() * (60000 - 30000) + 30000);
                    await new Promise(res => setTimeout(res, delay));
                    
                    // TEST 1: Messaggio semplicissimo a se stesso
                    console.log(`📤 Sending simple test to self (${sock.user.id})...`);
                    await sock.sendMessage(sock.user.id, { text: 'Bot Air Fryer è VIVO! 🚀' });
                    
                    // TEST 2: Invio al canale
                    console.log(`📤 Sending to channel ${channelId}...`);
                    const result = await sock.sendMessage(channelId, { text: message });
                    console.log('✅ Message Result ID:', result?.key?.id);

                    if (!force) {
                        sentDb.push(link);
                        fs.writeFileSync(SENT_DB, JSON.stringify(sentDb.slice(-100)));
                    }
                } catch (sendError) {
                    console.error('❌ Errore durante l\'invio del messaggio:', sendError);
                    throw sendError;
                }
            }
 else if (message) {
                console.log('⚠️ Messaggio pronto ma Bot non collegato (sock.user mancante). Salto...');
            }
        }
    } catch (e) {
        console.error('❌ Scrape error:', e.message);
        throw e;
    }
}
