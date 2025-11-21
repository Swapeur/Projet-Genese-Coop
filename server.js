const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();
const app = express();
const http = require('http').createServer(app);
const { Server } = require("socket.io");
const io = new Server(http);
const https = require('https'); // Nécessaire pour l'anti-veille

// --- SÉCURITÉ & MIDDLEWARE ---
const xss = require('xss');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(rateLimit({ windowMs: 15*60*1000, max: 1000 }));

// --- CONFIGURATION MONGODB ---
const MONGO_URI = process.env.MONGO_URI;

const GameSchema = new mongoose.Schema({
  isGlobalSave: { type: Boolean, default: true, unique: true },
  data: { type: mongoose.Schema.Types.Mixed }
}, { strict: false });

const GameModel = mongoose.model('GlobalSave', GameSchema);

// --- CONSTANTES JEU ---
const TICK_RATE_MS = 200; 
const COST_MULTIPLIER = 1.15;
const SAVE_INTERVAL_MS = 10000; 
const PRESTIGE_THRESHOLD = 1e14; 

// REGLAGES JEU
const CLICK_COOLDOWN_MS = 40; 
const MAX_TABS_PER_DEVICE = 3; 
const CHAT_UNLOCK_CLICKS = 50; 

// --- REGLAGES CHAT ---
const CHAT_COOLDOWN_MS = 3000;
const MAX_CHAT_HISTORY = 50;

// --- REGLAGES BONUS ---
const BONUS_CHANCE_PER_TICK = 0.002; 
const BONUS_REWARD_SECONDS = 90; 

// Variables globales
let currentTickClicks = 0;
let lastClickTime = new Map();
let playerStats = new Map(); 

// --- SYSTEME DE CHAT (POLLING) ---
const chatHistory = [];

app.get('/api/chat', (req, res) => {
    const since = parseInt(req.query.since) || 0;
    const newMessages = chatHistory.filter(m => m.timestamp > since);
    res.json(newMessages);
});

app.post('/api/chat', (req, res) => {
    const { user, text } = req.body;
    if (!text || typeof text !== 'string' || text.trim().length === 0) return res.status(400).json({ error: "Message vide" });

    let playerFound = false;
    let playerStatsRef = null;
    for (const [_, stats] of playerStats) {
        if (stats.name === user) { playerFound = true; playerStatsRef = stats; break; }
    }

    if (!playerFound) return res.status(403).json({ error: "Session invalide." });
    if (playerStatsRef.clicks < CHAT_UNLOCK_CLICKS) return res.status(403).json({ error: `Verrouillé: ${CHAT_UNLOCK_CLICKS} clics requis.` });

    const now = Date.now();
    const lastTime = playerStatsRef.lastChatTime || 0;
    if (now - lastTime < CHAT_COOLDOWN_MS) return res.status(429).json({ error: "Doucement !" });

    playerStatsRef.lastChatTime = now;
    const msgObj = { id: Date.now() + Math.random(), timestamp: now, user: xss(user), text: xss(text.trim().substring(0, 100)) };
    chatHistory.push(msgObj);
    if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.shift();

    res.json({ success: true });
});

// --- BOOSTS DEFINITIONS ---
const BOOST_DEFINITIONS = {
  'seringue_precision': { id: 'seringue_precision', name: 'Seringue de Précision', description: 'Double la puissance de tous les clics.', cost: 2000, conditionType: 'totalClicks', conditionValue: 500 },
  'doigts_bioniques': { id: 'doigts_bioniques', name: 'Doigts Bioniques', description: 'Multiplie la puissance des clics par 3.', cost: 500000, conditionType: 'totalClicks', conditionValue: 2500 },
  'clics_contamines': { id: 'clics_contamines', name: 'Clics Contaminés', description: 'Chaque clic génère 1% de votre CI/s total.', cost: 10000000, conditionType: 'totalClicks', conditionValue: 10000 },
  'neurones_connectes': { id: 'neurones_connectes', name: 'Neurones Connectés', description: 'Chaque Centre de Contagion ajoute +1000 au clic.', cost: 25000000, conditionType: 'buildingCount', conditionTarget: 'centres_contagion', conditionValue: 5 },
  'gants_titane': { id: 'gants_titane', name: 'Gants en Titane', description: 'Multiplie la puissance des clics par 5.', cost: 5000000000, conditionType: 'totalClicks', conditionValue: 50000 },
  'rage_virale': { id: 'rage_virale', name: 'Rage Virale', description: 'Multiplie la puissance des clics par 10.', cost: 800000000000, conditionType: 'totalClicks', conditionValue: 100000 },
  'osmose_tactile': { id: 'osmose_tactile', name: 'Osmose Tactile', description: 'Ajoute 2% de votre production totale (CI/s) aux clics.', cost: 5000000000000, conditionType: 'buildingCount', conditionTarget: 'singularite_biologique', conditionValue: 1 },
  'mutation_boost_clic_t1': { id: 'mutation_boost_clic_t1', name: 'Auto-Click V1', description: 'Les Mutations Mineures boostent les clics (+0.5/u).', cost: 1000, conditionType: 'buildingCount', conditionTarget: 'mutations_mineures', conditionValue: 10 },
  'plumes_aero': { id: 'plumes_aero', name: 'Plumes Aérodynamiques', description: 'Double la production des Vecteurs Oiseaux.', cost: 5000, conditionType: 'buildingCount', conditionTarget: 'vecteurs_oiseaux', conditionValue: 10 },
  'filtres_mutagenes': { id: 'filtres_mutagenes', name: 'Filtres Mutagènes', description: 'Double la production de Contamination Eau.', cost: 12000, conditionType: 'buildingCount', conditionTarget: 'contamination_eau', conditionValue: 10 },
  'spores_haute_densite': { id: 'spores_haute_densite', name: 'Spores à Haute Densité', description: 'Double la production de Transmission Aérosol.', cost: 130000, conditionType: 'buildingCount', conditionTarget: 'transmission_aerosol', conditionValue: 10 },
  'partenariats_logistiques': { id: 'partenariats_logistiques', name: 'Partenariats Logistiques', description: 'Double la production des Aéroports.', cost: 1400000, conditionType: 'buildingCount', conditionTarget: 'aeroport_international', conditionValue: 10 },
  'nutriments_ameliores': { id: 'nutriments_ameliores', name: 'Nutriments Améliorés', description: 'Double la production des Fermes Virales.', cost: 5500000, conditionType: 'buildingCount', conditionTarget: 'fermes_virales', conditionValue: 10 },
  'gentrification_acceleree': { id: 'gentrification_acceleree', name: 'Gentrification Accélérée', description: 'Double la production des Centres de Contagion.', cost: 55000000, conditionType: 'buildingCount', conditionTarget: 'centres_contagion', conditionValue: 10 },
  'fake_news': { id: 'fake_news', name: 'Fake News', description: 'Double la production de Propagande Virale.', cost: 550000000, conditionType: 'buildingCount', conditionTarget: 'propagande_virale', conditionValue: 10 },
  'mutation_boost_clic_t2': { id: 'mutation_boost_clic_t2', name: 'Auto-Click V2', description: 'Les Mutations Mineures boostent encore les clics (+1/u).', cost: 50000, conditionType: 'buildingCount', conditionTarget: 'mutations_mineures', conditionValue: 25 },
  'oiseau_t2': { id: 'oiseau_t2', name: 'Migration de Masse', description: 'Double la production des Vecteurs Oiseaux (T2).', cost: 100000, conditionType: 'buildingCount', conditionTarget: 'vecteurs_oiseaux', conditionValue: 25 },
  'eau_t2': { id: 'eau_t2', name: 'Purification Inversée', description: 'Double la production de Contamination Eau (T2).', cost: 250000, conditionType: 'buildingCount', conditionTarget: 'contamination_eau', conditionValue: 25 },
  'aerosol_t2': { id: 'aerosol_t2', name: 'Spores Persistantes', description: 'Double la production de Transmission Aérosol (T2).', cost: 2600000, conditionType: 'buildingCount', conditionTarget: 'transmission_aerosol', conditionValue: 25 },
  'aeroport_t2': { id: 'aeroport_t2', name: 'Vols Pandémiques', description: 'Double la production des Aéroports (T2).', cost: 28000000, conditionType: 'buildingCount', conditionTarget: 'aeroport_international', conditionValue: 25 },
  'ferme_t2': { id: 'ferme_t2', name: 'Culture Intensive', description: 'Double la production des Fermes Virales (T2).', cost: 110000000, conditionType: 'buildingCount', conditionTarget: 'fermes_virales', conditionValue: 25 },
  'centre_t2': { id: 'centre_t2', name: 'Confinement Forcé', description: 'Double la production des Centres de Contagion (T2).', cost: 1100000000, conditionType: 'buildingCount', conditionTarget: 'centres_contagion', conditionValue: 25 },
  'propagande_t2': { id: 'propagande_t2', name: 'Contrôle des Médias', description: 'Double la production de Propagande Virale (T2).', cost: 11000000000, conditionType: 'buildingCount', conditionTarget: 'propagande_virale', conditionValue: 25 },
  'sat_t1': { id: 'sat_t1', name: 'Réseau 5G Viral', description: 'Double la production des Satellites.', cost: 15000000000, conditionType: 'buildingCount', conditionTarget: 'satellite_dispersion', conditionValue: 10 },
  'clone_t1': { id: 'clone_t1', name: 'ADN Instable', description: 'Double la production du Clonage Humain.', cost: 200000000000, conditionType: 'buildingCount', conditionTarget: 'clonage_humain', conditionValue: 10 },
  'terra_t1': { id: 'terra_t1', name: 'Atmosphère Toxique', description: 'Double la production de Terraformation.', cost: 3000000000000, conditionType: 'buildingCount', conditionTarget: 'terraformation_virale', conditionValue: 10 },
  'singu_t1': { id: 'singu_t1', name: 'Esprit de Ruche', description: 'Double la production de la Singularité.', cost: 50000000000000, conditionType: 'buildingCount', conditionTarget: 'singularite_biologique', conditionValue: 5 },
  'contamination_aviaire': { id: 'contamination_aviaire', name: 'Contamination Aviaire', description: 'Chaque Oiseau augmente la production d\'Eau de 1%.', cost: 50000000, conditionType: 'buildingCount', conditionTarget: 'vecteurs_oiseaux', conditionValue: 25, condition2Type: 'buildingCount', condition2Target: 'contamination_eau', condition2Value: 25 },
  'synergie_humide': { id: 'synergie_humide', name: 'Irrigation Infectée', description: 'Chaque Source d\'Eau augmente la production des Fermes de 0.5%.', cost: 5000000000, conditionType: 'buildingCount', conditionTarget: 'contamination_eau', conditionValue: 50, condition2Type: 'buildingCount', condition2Target: 'fermes_virales', conditionValue: 25 },
  'matrice_virale': { id: 'matrice_virale', name: 'Matrice Virale', description: 'Augmente la production de TOUS les bâtiments de 50%.', cost: 100000000000, conditionType: 'buildingCount', conditionTarget: 'centres_contagion', conditionValue: 50 },
  
  // --- BOOSTS ENDGAME ---
  'echo_t1': { id: 'echo_t1', name: 'Résonance Quantique', description: 'Double la production des Échos Dimensionnels.', cost: 100000000000000, conditionType: 'buildingCount', conditionTarget: 'echos_dimensionnels', conditionValue: 10 },
  'nano_t1': { id: 'nano_t1', name: 'Grey Goo', description: 'Double la production des Nanobots.', cost: 2000000000000000, conditionType: 'buildingCount', conditionTarget: 'nanobots_autoreplicants', conditionValue: 10 },
  'nova_t1': { id: 'nova_t1', name: 'Explosion Gamma', description: 'Double la production des Supernovas.', cost: 80000000000000000, conditionType: 'buildingCount', conditionTarget: 'supernova_virale', conditionValue: 5 },
  'omnipotence': { id: 'omnipotence', name: 'Omnipotence', description: 'Chaque Supernova multiplie TOUTE la production de 10%.', cost: 200000000000000000, conditionType: 'buildingCount', conditionTarget: 'supernova_virale', conditionValue: 10 },
  'doigt_divin': { id: 'doigt_divin', name: 'Toucher Divin', description: 'Le clic gagne +1% de la prod des Nanobots.', cost: 500000000000000, conditionType: 'totalClicks', conditionValue: 200000 }
};

const PRESTIGE_UPGRADE_DEFINITIONS = {
  'p_kit_demarrage': { id: 'p_kit_demarrage', name: 'Souche Héritée', description: 'Commence chaque nouvelle partie avec 5 Mutations Mineures.', cost: 1 },
  'p_recherche_acceleree': { id: 'p_recherche_acceleree', name: 'Publication Scientifique', description: 'Tous les boosts sont 10% moins chers.', cost: 5 },
  'p_efficacite_virale': { id: 'p_efficacite_virale', name: 'Virulence Accrue', description: 'Augmente la production de TOUS les bâtiments de 25%.', cost: 10 },
  'p_clics_experts': { id: 'p_clics_experts', name: 'Clics d\'Expert', description: 'Double la puissance de base des clics.', cost: 25 }
};

// --- ETAT DU JEU ---
const defaultGameState = {
  totalInfectedCells: 0, 
  fractionalResidue: 0,
  totalCellsEver: 0, 
  totalClicks: 0, 
  clickPower: 1, 
  clickPowerBonusFromCPS: 0, 
  cellsPerSecond: 0, 
  clicksPerSecond: 0, 
  prestigePoints: 0, 
  purchasedBoosts: [], 
  purchasedPrestigeUpgrades: [],
  mutations_mineures: 0, cost_mutation: 15, gain_mutation: 0.1,
  vecteurs_oiseaux: 0,   cost_oiseau: 100,  gain_oiseau: 1,
  contamination_eau: 0,  cost_eau: 1100,    gain_eau: 8,
  transmission_aerosol: 0, cost_aerosol: 12000, gain_aerosol: 47,
  aeroport_international: 0, cost_aeroport: 130000, gain_aeroport: 260,
  fermes_virales: 0, cost_ferme: 500000, gain_ferme: 2000,
  centres_contagion: 0, cost_centre: 5000000, gain_centre: 15000,
  propagande_virale: 0, cost_propagande: 50000000, gain_propagande: 100000,
  satellite_dispersion: 0, cost_satellite: 600000000, gain_satellite: 1200000,
  clonage_humain: 0, cost_clonage: 7500000000, gain_clonage: 20000000,
  terraformation_virale: 0, cost_terraformation: 95000000000, gain_terraformation: 350000000,
  singularite_biologique: 0, cost_singularite: 1500000000000, gain_singularite: 8000000000,
  echos_dimensionnels: 0, cost_echo: 10000000000000, gain_echo: 50000000000, 
  nanobots_autoreplicants: 0, cost_nano: 250000000000000, gain_nano: 1500000000000,
  supernova_virale: 0, cost_nova: 8000000000000000, gain_nova: 100000000000000
};

let gameState = { ...defaultGameState };

function safeNum(val, fallback = 0) {
    if (typeof val !== 'number' || isNaN(val) || !isFinite(val)) return fallback;
    return val;
}

function calculatePrestigePoints(cells) { 
    const safeCells = safeNum(cells);
    return Math.floor(Math.sqrt(safeCells / PRESTIGE_THRESHOLD)); 
}

function getPlayerScalingFactor() { 
  let activePlayers = 0;
  for (const [_, stats] of playerStats) {
    if (stats.hasCustomName) activePlayers++;
  }
  if (activePlayers <= 4) return 1; 
  return Math.sqrt(activePlayers); 
}

function applyAllPurchasedBoosts(state) {
  let prestigeProdBonus = 1; let prestigeClickBonus = 1;
  if (state.purchasedPrestigeUpgrades.includes('p_efficacite_virale')) prestigeProdBonus = 1.25;
  if (state.purchasedPrestigeUpgrades.includes('p_clics_experts')) prestigeClickBonus = 2;

  state.clickPower = 1 * prestigeClickBonus; state.clickPowerBonusFromCPS = 0;
  
  const keys = ['mutation', 'oiseau', 'eau', 'aerosol', 'aeroport', 'ferme', 'centre', 'propagande', 'satellite', 'clonage', 'terraformation', 'singularite', 'echo', 'nano', 'nova'];
  keys.forEach(k => { state[`gain_${k}`] = defaultGameState[`gain_${k}`] * prestigeProdBonus; });

  let synergyBonusWater = 0; let synergyBonusFarms = 0; let globalMultiplier = 1;
  
  for (const boostId of state.purchasedBoosts) {
    const b = BOOST_DEFINITIONS[boostId]; if(!b) continue;
    
    if (boostId === 'seringue_precision') state.clickPower *= 2;
    if (boostId === 'doigts_bioniques') state.clickPower *= 3;
    if (boostId === 'gants_titane') state.clickPower *= 5;
    if (boostId === 'rage_virale') state.clickPower *= 10;
    if (boostId === 'clics_contamines') state.clickPowerBonusFromCPS += 0.01;
    if (boostId === 'osmose_tactile') state.clickPowerBonusFromCPS += 0.02;
    if (boostId === 'doigt_divin') state.clickPower += (state.gain_nano * safeNum(state.nanobots_autoreplicants) * 0.01);
    
    if (boostId === 'neurones_connectes') state.clickPower += (1000 * safeNum(state.centres_contagion)) * prestigeClickBonus;
    if (boostId === 'mutation_boost_clic_t1') state.clickPower += (0.5 * safeNum(state.mutations_mineures)) * prestigeClickBonus;
    if (boostId === 'mutation_boost_clic_t2') state.clickPower += (1 * safeNum(state.mutations_mineures)) * prestigeClickBonus;
    
    if (boostId === 'plumes_aero' || boostId === 'oiseau_t2') state.gain_oiseau *= 2;
    if (boostId === 'filtres_mutagenes' || boostId === 'eau_t2') state.gain_eau *= 2;
    if (boostId === 'spores_haute_densite' || boostId === 'aerosol_t2') state.gain_aerosol *= 2;
    if (boostId === 'partenariats_logistiques' || boostId === 'aeroport_t2') state.gain_aeroport *= 2;
    if (boostId === 'nutriments_ameliores' || boostId === 'ferme_t2') state.gain_ferme *= 2;
    if (boostId === 'gentrification_acceleree' || boostId === 'centre_t2') state.gain_centre *= 2;
    if (boostId === 'fake_news' || boostId === 'propagande_t2') state.gain_propagande *= 2;
    if (boostId === 'sat_t1') state.gain_satellite *= 2;
    if (boostId === 'clone_t1') state.gain_clonage *= 2;
    if (boostId === 'terra_t1') state.gain_terraformation *= 2;
    if (boostId === 'singu_t1') state.gain_singularite *= 2;
    
    if (boostId === 'echo_t1') state.gain_echo *= 2;
    if (boostId === 'nano_t1') state.gain_nano *= 2;
    if (boostId === 'nova_t1') state.gain_nova *= 2;
    if (boostId === 'omnipotence') globalMultiplier *= (1 + (0.10 * safeNum(state.supernova_virale)));

    if (boostId === 'contamination_aviaire') synergyBonusWater += (0.01 * safeNum(state.vecteurs_oiseaux));
    if (boostId === 'synergie_humide') synergyBonusFarms += (0.005 * safeNum(state.contamination_eau));
    if (boostId === 'matrice_virale') globalMultiplier *= 1.5;
  }

  state.gain_eau *= (1 + synergyBonusWater); 
  state.gain_ferme *= (1 + synergyBonusFarms);
  
  keys.forEach(k => { state[`gain_${k}`] *= globalMultiplier; });

  state.cellsPerSecond = 
    (safeNum(state.mutations_mineures) * state.gain_mutation) + 
    (safeNum(state.vecteurs_oiseaux) * state.gain_oiseau) + 
    (safeNum(state.contamination_eau) * state.gain_eau) + 
    (safeNum(state.transmission_aerosol) * state.gain_aerosol) + 
    (safeNum(state.aeroport_international) * state.gain_aeroport) + 
    (safeNum(state.fermes_virales) * state.gain_ferme) + 
    (safeNum(state.centres_contagion) * state.gain_centre) + 
    (safeNum(state.propagande_virale) * state.gain_propagande) + 
    (safeNum(state.satellite_dispersion) * state.gain_satellite) + 
    (safeNum(state.clonage_humain) * state.gain_clonage) + 
    (safeNum(state.terraformation_virale) * state.gain_terraformation) + 
    (safeNum(state.singularite_biologique) * state.gain_singularite) +
    (safeNum(state.echos_dimensionnels) * state.gain_echo) +
    (safeNum(state.nanobots_autoreplicants) * state.gain_nano) +
    (safeNum(state.supernova_virale) * state.gain_nova);
}

function getAvailableBoosts(state) {
  let available = [];
  for (const boostId in BOOST_DEFINITIONS) {
    if (!state.purchasedBoosts.includes(boostId)) {
      const boost = BOOST_DEFINITIONS[boostId];
      let c1 = false, c2 = true;
      if (boost.conditionType === 'totalClicks' && state.totalClicks >= boost.conditionValue) c1 = true;
      else if (boost.conditionType === 'buildingCount' && state[boost.conditionTarget] >= boost.conditionValue) c1 = true;
      if (boost.condition2Type) { c2 = false; if (boost.condition2Type === 'buildingCount' && state[boost.condition2Target] >= boost.condition2Value) c2 = true; }
      if (c1 && c2) available.push(boost);
    }
  }
  return available;
}

async function saveGameState() {
  try {
    await GameModel.findOneAndUpdate(
      { isGlobalSave: true }, 
      { data: gameState }, 
      { upsert: true, new: true }
    );
  } catch (e) {
    console.error("⚠️ Erreur sauvegarde MongoDB:", e);
  }
}

function sendFullUpdate(target) {
  const availableBoosts = getAvailableBoosts(gameState);
  const prestigeInfo = { canPrestige: gameState.totalCellsEver >= PRESTIGE_THRESHOLD, pointsOnReset: calculatePrestigePoints(gameState.totalCellsEver) };
  target.emit('full_update', { gameState, availableBoosts, prestigeInfo, prestigeUpgrades: PRESTIGE_UPGRADE_DEFINITIONS });
}

io.on('connection', (socket) => {
  const deviceId = socket.handshake.auth.token || 'unknown';
  let deviceCount = 0;
  for (const [_, s] of io.sockets.sockets) { if (s.handshake.auth.token === deviceId) deviceCount++; }
  if (deviceCount > MAX_TABS_PER_DEVICE) { socket.disconnect(true); return; }

  console.log(`Joueur connecté: ${socket.id}`);
  const defaultName = 'Scientifique ' + socket.id.substring(0, 4);
  socket.username = defaultName;
  
  playerStats.set(socket.id, { name: defaultName, clicks: 0, contribution: 0, hasCustomName: false, activeBonusId: null, lastChatTime: 0 });
  lastClickTime.set(socket.id, 0);
  sendFullUpdate(socket);

  socket.on('set_username', (name) => {
    if(typeof name === 'string' && name.trim().length > 0) { 
        const clean = xss(name.trim().substring(0, 15));
        socket.username = clean;
        const stats = playerStats.get(socket.id);
        if(stats) { stats.name = clean; stats.hasCustomName = true; }
    }
  });

  socket.on('click_cell', () => {
    if(!playerStats.has(socket.id)) return;
    const stats = playerStats.get(socket.id);
    if (!stats.hasCustomName) return; 

    const now = Date.now();
    const last = lastClickTime.get(socket.id) || 0;
    if (now - last < CLICK_COOLDOWN_MS) return; 
    
    lastClickTime.set(socket.id, now);
    
    gameState.totalClicks++; currentTickClicks++;
    const base = gameState.clickPower;
    const bonus = gameState.cellsPerSecond * gameState.clickPowerBonusFromCPS;
    
    const rawTotal = (base + bonus) / getPlayerScalingFactor();
    const safeTotal = safeNum(rawTotal); 
    
    stats.clicks++; stats.contribution += safeTotal;
    gameState.fractionalResidue += safeTotal;
    const intGain = Math.floor(gameState.fractionalResidue);
    gameState.totalInfectedCells += intGain; 
    gameState.totalCellsEver += intGain;
    gameState.fractionalResidue -= intGain;
  });

  socket.on('click_bonus', (bonusId) => {
    const stats = playerStats.get(socket.id);
    if (!stats || !stats.activeBonusId) return;
    if (stats.activeBonusId === bonusId) {
        const rawReward = Math.max(1000, gameState.cellsPerSecond * BONUS_REWARD_SECONDS);
        const reward = Math.floor(safeNum(rawReward)); 
        
        gameState.totalInfectedCells += reward;
        gameState.totalCellsEver += reward;
        stats.contribution += reward;
        stats.activeBonusId = null;
        
        const cleanName = xss(stats.name);
        const msgObj = { id: Date.now()+Math.random(), timestamp: Date.now(), user: "Système", text: `🧬 ${cleanName} a déclenché une Mutation Instable (+${reward}) !` };
        chatHistory.push(msgObj);
        if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.shift();
    }
  });

  socket.on('buy_upgrade', (name) => {
    let bought = false;
    const checkAndBuy = (key, costKey) => {
      const currentCost = safeNum(gameState[costKey]);
      const currentCount = safeNum(gameState[key]);
      
      if (gameState.totalInfectedCells >= currentCost) {
        gameState.totalInfectedCells -= currentCost; 
        gameState[key] = currentCount + 1;
        const nextCostRaw = defaultGameState[costKey] * Math.pow(COST_MULTIPLIER, gameState[key]);
        gameState[costKey] = Math.ceil(safeNum(nextCostRaw)); 
        return true;
      } 
      return false;
    };
    
    if (name === 'mutation_mineure') bought = checkAndBuy('mutations_mineures', 'cost_mutation');
    else if (name === 'vecteur_oiseau') bought = checkAndBuy('vecteurs_oiseaux', 'cost_oiseau');
    else if (name === 'contamination_eau') bought = checkAndBuy('contamination_eau', 'cost_eau');
    else if (name === 'transmission_aerosol') bought = checkAndBuy('transmission_aerosol', 'cost_aerosol');
    else if (name === 'aeroport_international') bought = checkAndBuy('aeroport_international', 'cost_aeroport');
    else if (name === 'fermes_virales') bought = checkAndBuy('fermes_virales', 'cost_ferme');
    else if (name === 'centres_contagion') bought = checkAndBuy('centres_contagion', 'cost_centre');
    else if (name === 'propagande_virale') bought = checkAndBuy('propagande_virale', 'cost_propagande');
    else if (name === 'satellite_dispersion') bought = checkAndBuy('satellite_dispersion', 'cost_satellite');
    else if (name === 'clonage_humain') bought = checkAndBuy('clonage_humain', 'cost_clonage');
    else if (name === 'terraformation_virale') bought = checkAndBuy('terraformation_virale', 'cost_terraformation');
    else if (name === 'singularite_biologique') bought = checkAndBuy('singularite_biologique', 'cost_singularite');
    
    else if (name === 'echos_dimensionnels') bought = checkAndBuy('echos_dimensionnels', 'cost_echo');
    else if (name === 'nanobots_autoreplicants') bought = checkAndBuy('nanobots_autoreplicants', 'cost_nano');
    else if (name === 'supernova_virale') bought = checkAndBuy('supernova_virale', 'cost_nova');

    if (bought) { applyAllPurchasedBoosts(gameState); sendFullUpdate(io); saveGameState(); }
  });

  socket.on('buy_boost', (id) => {
    const boost = BOOST_DEFINITIONS[id];
    if (boost && !gameState.purchasedBoosts.includes(id)) {
      let cost = safeNum(boost.cost); 
      if (gameState.purchasedPrestigeUpgrades.includes('p_recherche_acceleree')) cost = Math.floor(cost * 0.9);
      
      if (gameState.totalInfectedCells >= cost) {
        gameState.totalInfectedCells -= cost; 
        gameState.purchasedBoosts.push(id);
        applyAllPurchasedBoosts(gameState); sendFullUpdate(io); saveGameState();
      }
    }
  });

  socket.on('buy_prestige_upgrade', (id) => {
    const upg = PRESTIGE_UPGRADE_DEFINITIONS[id];
    if (upg && !gameState.purchasedPrestigeUpgrades.includes(id)) {
      const cost = safeNum(upg.cost);
      if (gameState.prestigePoints >= cost) {
        gameState.prestigePoints -= cost; 
        gameState.purchasedPrestigeUpgrades.push(id);
        applyAllPurchasedBoosts(gameState); sendFullUpdate(io); saveGameState();
      }
    }
  });

  socket.on('do_prestige', () => {
    const pts = calculatePrestigePoints(gameState.totalCellsEver);
    if (pts > 0) {
      const oldPrestige = gameState.prestigePoints; const oldUpgrades = gameState.purchasedPrestigeUpgrades;
      gameState = JSON.parse(JSON.stringify(defaultGameState));
      gameState.prestigePoints = oldPrestige + pts; gameState.purchasedPrestigeUpgrades = oldUpgrades;
      if (gameState.purchasedPrestigeUpgrades.includes('p_kit_demarrage')) gameState.mutations_mineures = 5;
      applyAllPurchasedBoosts(gameState); sendFullUpdate(io); saveGameState();
    }
  });

  socket.on('disconnect', () => { lastClickTime.delete(socket.id); playerStats.delete(socket.id); });
});

function gameLoop() {
  if (isNaN(gameState.totalInfectedCells) || !isFinite(gameState.totalInfectedCells)) {
      console.log("⚠️ Anomalie détectée. Correction...");
      gameState.totalInfectedCells = 0; 
  }

  for (const [socketId, stats] of playerStats) {
      if (stats.hasCustomName && !stats.activeBonusId) {
          if (Math.random() < BONUS_CHANCE_PER_TICK) {
              const bonusId = 'b_' + Math.random().toString(36).substr(2, 9);
              stats.activeBonusId = bonusId;
              io.to(socketId).emit('spawn_bonus', { id: bonusId });
              setTimeout(() => { if (stats.activeBonusId === bonusId) stats.activeBonusId = null; }, 12000);
          }
      }
  }

  const scale = getPlayerScalingFactor();
  const rawCps = safeNum(gameState.cellsPerSecond);
  const scaledCps = rawCps / scale;
  const tickGain = scaledCps / (1000 / TICK_RATE_MS);
  
  gameState.fractionalResidue = safeNum(gameState.fractionalResidue) + tickGain;
  const integerGain = Math.floor(gameState.fractionalResidue);
  
  if (integerGain > 0) {
      gameState.totalInfectedCells += integerGain; 
      gameState.totalCellsEver += integerGain;
      gameState.fractionalResidue -= integerGain;
  }
  
  const baseClick = gameState.clickPower;
  const bonusClick = rawCps * gameState.clickPowerBonusFromCPS;
  const currentClickValue = (baseClick + bonusClick) / scale;
  const clickHeat = currentTickClicks / (TICK_RATE_MS / 1000);
  currentTickClicks = 0;

  let activePlayerCount = 0;
  for (const [_, stats] of playerStats) { if (stats.hasCustomName) activePlayerCount++; }

  const leaderboard = Array.from(playerStats.values())
      .filter(p => p.hasCustomName)
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 10);
      
  io.emit('tick_update', { score: gameState.totalInfectedCells, cps: gameState.cellsPerSecond, clickValue: currentClickValue, clickHeat: clickHeat, players: activePlayerCount, leaderboard: leaderboard });
}

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// --- DÉMARRAGE ASYNCHRONE ---
async function startGame() {
  try {
    console.log("📡 Connexion à MongoDB Atlas...");
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connecté à la base de données.");

    const savedDoc = await GameModel.findOne({ isGlobalSave: true });
    
    if (savedDoc && savedDoc.data) {
      console.log("📂 Sauvegarde trouvée, chargement...");
      gameState = { ...defaultGameState, ...savedDoc.data };
      for(const key in gameState) {
          if(typeof gameState[key] === 'number' && (isNaN(gameState[key]) || !isFinite(gameState[key]))) {
             gameState[key] = defaultGameState[key] || 0;
          }
      }
      applyAllPurchasedBoosts(gameState);
    } else {
      console.log("✨ Aucune sauvegarde, création d'une nouvelle partie.");
      await saveGameState(); 
    }

    // Boucles de jeu
    setInterval(gameLoop, TICK_RATE_MS);
    setInterval(saveGameState, SAVE_INTERVAL_MS);

    // ANTI-VEILLE RENDER (Keep-Alive)
    if (process.env.RENDER_EXTERNAL_URL) { 
      console.log("⏰ Système Anti-Veille activé sur", process.env.RENDER_EXTERNAL_URL);
      const keepAliveInterval = 14 * 60 * 1000; 
      
      setInterval(() => {
        https.get(process.env.RENDER_EXTERNAL_URL, (resp) => {
          if (resp.statusCode === 200) {
            // Ping réussi
          }
        }).on("error", (err) => {
          console.error("⚠️ Erreur Ping anti-veille :", err.message);
        });
      }, keepAliveInterval);
    }

    const PORT = process.env.PORT || 3000;
    http.listen(PORT, () => console.log(`🚀 Serveur prêt sur le port ${PORT}`));

  } catch (err) {
    console.error("❌ Erreur fatale au démarrage :", err);
    process.exit(1);
  }
}

startGame();