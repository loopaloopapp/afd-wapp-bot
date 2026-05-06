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
const Redis = require('ioredis');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, '.wwebjs_auth');

// Redis client
const redis = new Redis(process.env.REDIS_URL);

// Fallback locale se Redis non disponibile
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let lastQrData = null;
let botStatus = 'Initializing... ⚙️';
let sock = null;

// --- REDIS HELPERS ---
async function getSentRecipes() {
    try {
        const data = await redis.get('afd:sent_recipes');
        return data ? JSON.parse(data) : [];
    } catch (e) {
        console.error('Redis error, using local fallback:', e.message);
        const localPath = path.join(AUTH_DIR, 'sent_recipes.json');
        if (!fs.existsSync(localPath)) fs.writeFileSync(localPath, JSON.stringify([]));
        return JSON.parse(fs.readFileSync(localPath));
    }
}

async function saveSentRecipes(recipes) {
    try {
        await redis.set('afd:sent_recipes', JSON.stringify(recipes.slice(-100)));
    } catch (e) {
        console.error('Redis error, saving locally:', e.message);
        const localPath = path.join(AUTH_DIR, 'sent_recipes.json');
        fs.writeFileSync(localPath, JSON.stringify(recipes.slice(-100)));
    }
}

// --- REDIS AUTH STATE ---
async function useRedisAuthState() {
    const KEY = 'afd:wa_creds';

    async function readData() {
        try {
            const data = await redis.get(KEY);
            return data ? JSON.parse(data) : {};
        } catch (e) {
            return {};
        }
    }

    async function writeData(data) {
        try {
            await redis.set(KEY, JSON.stringify(data));
        } catch (e) {
            console.error('Error saving creds to Redis:', e.message);
        }
    }

    const data = await readData();

    const state = {
        creds: data.creds || require("@whiskeysockets/baileys").initAuthCreds(),
        keys: {
            get: async (type, ids) => {
                const result = {};
                for (const id of ids) {
                    const val = data.keys?.[type]?.[id];
                    if (val) result[id] = val;
                }
                return result;
            },
            set: async (newData) => {
                for (const category in newData) {
                    data.keys = data.keys || {};
                    data.keys[category] = data.keys[category] || {};
                    Object.assign(data.keys[category], newData[category]);
                }
                await writeData(data);
            }
        }
    };

    const saveCreds = async () => {
        await writeData(data);
    };

    return { state, saveCreds };
}

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
    let state, saveCreds;

    if (process.env.REDIS_URL) {
        console.log('🔴 Using Redis for session storage');
        ({ state, saveCreds } = await useRedisAuthState());
    } else {
        console.log('📁 Using local file for session storage');
        ({ state, saveCreds } = await useMultiFileAuthState(AUTH_DIR));
    }

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
            const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output?.statusCode : 0;
            botStatus = 'Reconnecting... 🔄';
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.log('❌ Disconnesso da WhatsApp, necessaria nuova autenticazione');
                // Cancella sessione Redis per forzare nuovo QR
                if (process.env.REDIS_URL) redis.del('afd:wa_creds');
                setTimeout(connectToWhatsApp, 5000);
            }
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

    if (!channelId || channelId.trim() === "" || channelId.startsWith('http')) {
        channelId = '120363425032237179@newsletter';
    }

    console.log(`🔍 Controllo nuove ricette su: ${sourceUrl}`);
    try {
        const { data } = await axios.get(sourceUrl);
        const $ = cheerio.load(data);
        const recipeLinks = [];

        $('.recipe-card a.card-link').each((i, el) => {
            const href = $(el).attr('href');
            if (href) recipeLinks.push(new URL(href, sourceUrl).href);
        });

        console.log(`📚 Trovate ${recipeLinks.length} ricette totali sul sito.`);

        const sentDb = await getSentRecipes();
        const newRecipes = force ? [recipeLinks[0]] : recipeLinks.filter(link => !sentDb.includes(link)).slice(0, 1);

        if (newRecipes.length === 0) {
            console.log("✅ Nessuna nuova ricetta da pubblicare.");
            return;
        }

        for (const link of newRecipes) {
            try {
                console.log(`📖 Analisi ricetta: ${link}`);
                const recipePage = await axios.get(link);
                const $r = cheerio.load(recipePage.data);

                const imageUrl = $r('meta[property="og:image"]').attr('content') || $r('.recipe-header img').attr('src');
                const absoluteImageUrl = imageUrl ? new URL(imageUrl, link).href : null;

                const shareBtn = $r('#mainShareBtn');
                if (shareBtn.length === 0) {
                    console.log("⚠️ Pulsante share non trovato, salto.");
                    continue;
                }

                const shareOnClick = shareBtn.attr('onclick');
                const decodedOnClick = shareOnClick.replace(/&quot;/g, '"');

                const matches = decodedOnClick.match(/unifiedShare\s*\(\s*".*?"\s*,\s*"(.*?)"\s*,/);
                let message = null;
                if (matches) {
                    message = matches[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\//g, '/');
                }

                if (!message) {
                    console.log("⚠️ Impossibile estrarre il messaggio dalla ricetta, salto.");
                    continue;
                }

                if (sock && sock.user) {
                    const lines = message.split('\n');
                    if (lines.length > 0) {
                        lines[0] = `*${lines[0].trim()}*`;
                        message = lines.join('\n');
                    }

                    console.log(`🚀 Inviando a WhatsApp: ${lines[0]}`);

                    if (absoluteImageUrl) {
                        await sock.sendMessage(channelId, {
                            image: { url: absoluteImageUrl },
                            caption: message
                        });
                    } else {
                        await sock.sendMessage(channelId, { text: message });
                    }

                    if (!force) {
                        sentDb.push(link);
                        await saveSentRecipes(sentDb);
                    }
                    console.log("✅ Ricetta pubblicata con successo!");
                } else {
                    console.log("❌ Bot non ancora connesso a WhatsApp.");
                }
            } catch (err) {
                console.error(`❌ Errore durante l'elaborazione di ${link}:`, err.message);
            }
        }
    } catch (e) {
        console.error(`❌ Errore durante il caricamento della home:`, e.message);
    }
}
