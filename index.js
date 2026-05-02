require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const SENT_DB = path.join(__dirname, 'sent_recipes.json');

// --- DATABASE LOCALE ---
if (!fs.existsSync(SENT_DB)) fs.writeFileSync(SENT_DB, JSON.stringify([]));
const getSentRecipes = () => JSON.parse(fs.readFileSync(SENT_DB));
const saveSentRecipe = (id) => {
    const db = getSentRecipes();
    db.push(id);
let lastQr = null;
let botStatus = 'Initializing... ⚙️';

// --- WEB INTERFACE PER RAILWAY ---
app.get('/', (req, res) => {
    if (lastQr) {
        res.send(`
            <html>
                <body style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; font-family:sans-serif; background:#f0f2f5;">
                    <div style="background:white; padding:40px; border-radius:20px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); text-align:center;">
                        <h1 style="color:#25d366;">WhatsApp Bot Setup</h1>
                        <p>Scansiona il QR Code qui sotto con WhatsApp</p>
                        <div id="qrcode" style="display:inline-block; margin:20px;"></div>
                        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
                        <script>new QRCode(document.getElementById("qrcode"), { text: "${lastQr}", width: 256, height: 256 });</script>
                        <p style="color:#666; font-size:0.9em;">Dispositivi collegati > Collega un dispositivo</p>
                    </div>
                    <script>setTimeout(() => location.reload(), 15000);</script>
                </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
                <body style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; font-family:sans-serif; background:#f0f2f5;">
                    <div style="background:white; padding:40px; border-radius:20px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); text-align:center;">
                        <h1 style="color:#25d366;">Air Fryer Bot</h1>
                        <div style="font-size:1.5em; margin:20px;">${botStatus}</div>
                        <p style="color:#666;">La pagina si aggiornerà automaticamente.</p>
                    </div>
                    <script>setTimeout(() => location.reload(), 5000);</script>
                </body>
            </html>
        `);
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server listening on port ${PORT}`));

// --- CONFIGURAZIONE WHATSAPP ---
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ],
        executablePath: process.env.CHROME_PATH || null
    }
});

client.on('qr', (qr) => {
    lastQr = qr;
    botStatus = 'Waiting for Scan... 📷';
    console.log('--- QR CODE UPDATED ---');
});

client.on('ready', () => {
    lastQr = null;
    botStatus = 'Bot is Ready & Working! ✅';
    console.log('✅ WhatsApp Client is ready!');
    startAutomation();
});

client.on('authenticated', () => {
    botStatus = 'Authenticated! Starting... 🚀';
    console.log('✅ Authenticated successfully');
});
client.on('auth_failure', msg => console.error('❌ Auth failure:', msg));

// --- LOGICA DI AUTOMAZIONE ---
async function startAutomation() {
    console.log(`🤖 Monitoring started: ${process.env.WEB_SOURCE_URL}`);
    
    // Controllo periodico
    setInterval(async () => {
        try {
            await checkAndPublish();
        } catch (err) {
            console.error('❌ Automation Error:', err.message);
        }
    }, process.env.CHECK_INTERVAL_MINUTES * 60 * 1000);
    
    // Primo avvio immediato
    await checkAndPublish();
}

async function checkAndPublish() {
    const sourceUrl = process.env.WEB_SOURCE_URL;
    const channelId = process.env.WA_CHANNEL_ID;
    
    console.log('🔎 Checking for new recipes...');
    try {
        const { data } = await axios.get(sourceUrl, { timeout: 10000 });
        const $ = cheerio.load(data);
        
        // Estraiamo i link delle ricette dalla home
        const recipeLinks = [];
        $('.recipe-card a.card-link').each((i, el) => {
            const href = $(el).attr('href');
            if (href) recipeLinks.push(new URL(href, sourceUrl).href);
        });

        const sentDb = getSentRecipes();
        // Filtriamo quelle nuove e limitiamo a 5 per sessione (batching)
        const newRecipes = recipeLinks.filter(link => !sentDb.includes(link)).slice(0, 5); 

        if (newRecipes.length === 0) {
            console.log('😴 No new recipes found.');
            return;
        }

        for (const link of newRecipes) {
            console.log(`✨ Processing: ${link}`);
            
            try {
                // Visitiamo la pagina della ricetta
                const recipePage = await axios.get(link, { timeout: 10000 });
                const $r = cheerio.load(recipePage.data);
                
                // Estraiamo il contenuto dal pulsante share (logica basata sull'attributo onclick)
                const shareOnClick = $r('#mainShareBtn').attr('onclick');
                if (!shareOnClick) {
                    console.warn(`⚠️ No share button found for ${link}`);
                    continue;
                }

                // Estraiamo il secondo argomento di unifiedShare(title, fullMessage, url, img)
                // Usiamo una regex che gestisce le stringhe racchiuse tra virgolette doppie
                const matches = shareOnClick.match(/unifiedShare\s*\(\s*(?:"|').*?(?:"|')\s*,\s*"((?:\\"|[^"])*)"/);
                let message = matches ? matches[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') : null;

                if (message) {
                    // --- STRATEGIE ANTI-BAN ---
                    // 1. Random Delay tra 45 e 150 secondi
                    const delay = Math.floor(Math.random() * (150000 - 45000 + 1) + 45000);
                    console.log(`⏳ Waiting ${Math.round(delay/1000)}s before sending (Anti-ban)...`);
                    await new Promise(res => setTimeout(res, delay));

                    // 2. Simula stato "sta scrivendo" (Human Mimicry)
                    try {
                        const chat = await client.getChatById(channelId);
                        await chat.sendStateTyping();
                        await new Promise(res => setTimeout(res, 5000)); // 5 secondi di "typing"
                    } catch (e) {
                        console.warn('⚠️ Could not simulate typing (Newsletter IDs might not support it)');
                    }

                    // 3. Invio effettivo
                    await client.sendMessage(channelId, message);
                    console.log(`🚀 Published to WhatsApp Channel: ${link}`);
                    
                    saveSentRecipe(link);
                }
            } catch (e) {
                console.error(`⚠️ Failed to process details for ${link}:`, e.message);
            }
        }
    } catch (e) {
        console.error('❌ Scrape Error:', e.message);
    }
}

console.log('🚀 Initializing WhatsApp Client...');
client.initialize();
