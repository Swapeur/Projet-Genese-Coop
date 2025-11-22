const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require("socket.io");
const helmet = require('helmet');
const xss = require('xss');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// CONFIGURATION
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'CLE_SECRETE_A_CHANGER';
const PORT = process.env.PORT || 3000;
const TICK_RATE_MS = 200;
const SAVE_INTERVAL_MS = 10000;

// MIDDLEWARES
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.static('public'));

// SCHEMAS MONGO
const GameSchema = new mongoose.Schema({ isGlobalSave: { type: Boolean, default: true }, data: Object }, { strict: false });
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  clicks: { type: Number, default: 0 },
  contribution: { type: Number, default: 0 },
  lastSeen: { type: Date, default: Date.now }
});
const GameModel = mongoose.model('GlobalSave', GameSchema);
const UserModel = mongoose.model('User', UserSchema);

// DONNÉES DU JEU (Les règles mathématiques)
// IMPORTANT : Ces clés correspondent exactement aux ID de ton HTML original
const BUILDINGS = {
  'mutation_mineure': { base: 15, gain: 0.1, key: 'mutations_mineures', costKey: 'cost_mutation', gainKey: 'gain_mutation' },
  'vecteur_oiseau': { base: 100, gain: 1, key: 'vecteurs_oiseaux', costKey: 'cost_oiseau', gainKey: 'gain_oiseau' },
  'contamination_eau': { base: 1100, gain: 8, key: 'contamination_eau', costKey: 'cost_eau', gainKey: 'gain_eau' },
  'transmission_aerosol': { base: 12000, gain: 47, key: 'transmission_aerosol', costKey: 'cost_aerosol', gainKey: 'gain_aerosol' },
  'aeroport_international': { base: 130000, gain: 260, key: 'aeroport_international', costKey: 'cost_aeroport', gainKey: 'gain_aeroport' },
  'fermes_virales': { base: 500000, gain: 2000, key: 'fermes_virales', costKey: 'cost_ferme', gainKey: 'gain_ferme' },
  'centres_contagion': { base: 5000000, gain: 15000, key: 'centres_contagion', costKey: 'cost_centre', gainKey: 'gain_centre' },
  'propagande_virale': { base: 50000000, gain: 100000, key: 'propagande_virale', costKey: 'cost_propagande', gainKey: 'gain_propagande' },
  'satellite_dispersion': { base: 600000000, gain: 1200000, key: 'satellite_dispersion', costKey: 'cost_satellite', gainKey: 'gain_satellite' },
  'clonage_humain': { base: 7500000000, gain: 20000000, key: 'clonage_humain', costKey: 'cost_clonage', gainKey: 'gain_clonage' },
  'terraformation_virale': { base: 95000000000, gain: 350000000, key: 'terraformation_virale', costKey: 'cost_terraformation', gainKey: 'gain_terraformation' },
  'singularite_biologique': { base: 1500000000000, gain: 8000000000, key: 'singularite_biologique', costKey: 'cost_singularite', gainKey: 'gain_singularite' },
  'echos_dimensionnels': { base: 10000000000000, gain: 50000000000, key: 'echos_dimensionnels', costKey: 'cost_echo', gainKey: 'gain_echo' },
  'nanobots_autoreplicants': { base: 250000000000000, gain: 1500000000000, key: 'nanobots_autoreplicants', costKey: 'cost_nano', gainKey: 'gain_nano' },
  'supernova_virale': { base: 8000000000000000, gain: 100000000000000, key: 'supernova_virale', costKey: 'cost_nova', gainKey: 'gain_nova' }
};

// Initialisation de l'état par défaut
let defaultGameState = { 
    totalInfectedCells: 0, fractionalResidue: 0, totalCellsEver: 0, totalClicks: 0,
    clickPower: 1, clickPowerBonusFromCPS: 0, cellsPerSecond: 0, prestigePoints: 0,
    purchasedBoosts: [], purchasedPrestigeUpgrades: [] 
};
// On remplit les coûts par défaut
for (const id in BUILDINGS) {
    const b = BUILDINGS[id];
    defaultGameState[b.key] = 0;
    defaultGameState[b.costKey] = b.base;
    defaultGameState[b.gainKey] = b.gain;
}

let gameState = { ...defaultGameState };
let playerStats = new Map();
let lastClickTime = new Map();
let chatHistory = [];

// --- AUTHENTIFICATION ---
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Données manquantes" });
    try {
        const existing = await UserModel.findOne({ username });
        if (existing) return res.status(400).json({ error: "Pseudo pris" });
        const hash = await bcrypt.hash(password, 10);
        const user = await UserModel.create({ username, passwordHash: hash });
        const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET);
        res.json({ token, username: user.username });
    } catch (e) { res.status(500).json({ error: "Erreur serveur" }); }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await UserModel.findOne({ username });
        if (!user) return res.status(400).json({ error: "Inconnu" });
        if (!await bcrypt.compare(password, user.passwordHash)) return res.status(400).json({ error: "Mauvais mot de passe" });
        const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET);
        res.json({ token, username: user.username });
    } catch (e) { res.status(500).json({ error: "Erreur serveur" }); }
});

app.get('/api/chat', (req, res) => res.json(chatHistory));
app.post('/api/chat', (req, res) => { /* Logique Chat Simplifiée pour l'exemple */ res.json({success:true}); });

// --- SOCKET ---
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Auth requise"));
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return next(new Error("Token invalide"));
        socket.user = decoded;
        next();
    });
});

io.on('connection', async (socket) => {
    const userId = socket.user.id;
    const userDB = await UserModel.findById(userId);
    if(!userDB) { socket.disconnect(); return; }

    playerStats.set(socket.id, { dbId: userId, name: userDB.username, clicks: userDB.clicks, contribution: userDB.contribution });
    
    // Envoi de l'état complet au format attendu par ton index.html original
    socket.emit('full_update', { 
        gameState, 
        availableBoosts: gameState.purchasedBoosts, 
        prestigeInfo: { canPrestige: false, pointsOnReset: 0 },
        prestigeUpgrades: {} 
    });

    socket.on('click_cell', () => {
        const stats = playerStats.get(socket.id);
        if(!stats) return;
        const now = Date.now();
        if(now - (lastClickTime.get(socket.id)||0) < CLICK_COOLDOWN_MS) return;
        lastClickTime.set(socket.id, now);
        
        // Calcul gain
        let scale = 1; // Simplifié
        let val = (gameState.clickPower + (gameState.cellsPerSecond * gameState.clickPowerBonusFromCPS)) / scale;
        gameState.fractionalResidue += val;
        let gain = Math.floor(gameState.fractionalResidue);
        
        if(gain > 0) {
            gameState.fractionalResidue -= gain;
            gameState.totalInfectedCells += gain;
            gameState.totalCellsEver += gain;
            stats.clicks++;
            stats.contribution += gain;
        }
    });

    socket.on('buy_upgrade', (id) => {
        const b = BUILDINGS[id];
        if(b) {
            const cost = gameState[b.costKey];
            if(gameState.totalInfectedCells >= cost) {
                gameState.totalInfectedCells -= cost;
                gameState[b.key] = (gameState[b.key] || 0) + 1;
                gameState[b.costKey] = Math.ceil(cost * 1.15);
                
                // Recalcul CPS
                let cps = 0;
                for(let k in BUILDINGS) cps += (gameState[BUILDINGS[k].key]||0) * gameState[BUILDINGS[k].gainKey];
                gameState.cellsPerSecond = cps;
                
                io.emit('full_update', { gameState, availableBoosts: [] });
            }
        }
    });

    socket.on('disconnect', () => playerStats.delete(socket.id));
});

// --- BOUCLE JEU ---
setInterval(() => {
    let cps = gameState.cellsPerSecond;
    let tickGain = cps / 5; // 5 ticks/sec
    gameState.fractionalResidue += tickGain;
    let gain = Math.floor(gameState.fractionalResidue);
    if(gain > 0) {
        gameState.fractionalResidue -= gain;
        gameState.totalInfectedCells += gain;
        gameState.totalCellsEver += gain;
    }
    
    const leaderboard = Array.from(playerStats.values()).sort((a,b)=>b.contribution-a.contribution).slice(0,10);
    
    io.emit('tick_update', {
        score: gameState.totalInfectedCells,
        cps: gameState.cellsPerSecond,
        clickValue: gameState.clickPower,
        players: playerStats.size,
        leaderboard: leaderboard
    });
}, TICK_RATE_MS);

// --- SAUVEGARDE DB ---
setInterval(async () => {
    await GameModel.findOneAndUpdate({ isGlobalSave: true }, { data: gameState }, { upsert: true });
    const bulk = [];
    const savedIds = new Set();
    for(let [_, s] of playerStats) {
        if(!savedIds.has(s.dbId)) {
            savedIds.add(s.dbId);
            bulk.push({ updateOne: { filter: {_id: s.dbId}, update: {$set: {clicks: s.clicks, contribution: s.contribution}} } });
        }
    }
    if(bulk.length) await UserModel.bulkWrite(bulk);
}, SAVE_INTERVAL_MS);

// START
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
mongoose.connect(MONGO_URI).then(async () => {
    const s = await GameModel.findOne({ isGlobalSave: true });
    if(s && s.data) gameState = { ...defaultGameState, ...s.data };
    server.listen(PORT, () => console.log("Serveur Prêt"));
});