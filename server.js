const express = require('express');
const app = express();
const http = require('http').createServer(app);
const { Server } = require("socket.io");
const io = new Server(http);
const fs = require('fs');

// --- MODULES DE SÉCURITÉ (Toujours nécessaires) ---
const xss = require('xss');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Config Sécurité
app.use(helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({ windowMs: 15*60*1000, max: 100 })); // Max 100 requêtes/15min par IP pour charger la page

// --- CONSTANTES JEU ---
const PORT = process.env.PORT || 3000;
const TICK_RATE_MS = 200; 
const COST_MULTIPLIER = 1.15;
const SAVE_FILE = 'gameState.json';
const SAVE_INTERVAL_MS = 10000;
const PRESTIGE_THRESHOLD = 1e15; 
const CLICK_COOLDOWN_MS = 40; 

// --- REGLAGES ANTI-ABUS ---
const MAX_TABS_PER_DEVICE = 1; // Strictement 1 onglet par joueur
const CHAT_COOLDOWN_MS = 3000; // 3 secondes entre les messages

// Variables volatiles
let currentTickClicks = 0;
let lastClickTime = new Map();
let lastChatTime = new Map();
let playerStats = new Map();

// --- DEFINITIONS DU JEU ---
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
  'matrice_virale': { id: 'matrice_virale', name: 'Matrice Virale', description: 'Augmente la production de TOUS les bâtiments de 50%.', cost: 100000000000, conditionType: 'buildingCount', conditionTarget: 'centres_contagion', conditionValue: 50 }
};

const PRESTIGE_UPGRADE_DEFINITIONS = {
  'p_kit_demarrage': { id: 'p_kit_demarrage', name: 'Souche Héritée', description: 'Commence chaque nouvelle partie avec 5 Mutations Mineures.', cost: 1 },
  'p_recherche_acceleree': { id: 'p_recherche_acceleree', name: 'Publication Scientifique', description: 'Tous les boosts sont 10% moins chers.', cost: 5 },
  'p_efficacite_virale': { id: 'p_efficacite_virale', name: 'Virulence Accrue', description: 'Augmente la production de TOUS les bâtiments de 25%.', cost: 10 },
  'p_clics_experts': { id: 'p_clics_experts', name: 'Clics d\'Expert', description: 'Double la puissance de base des clics.', cost: 25 }
};

const defaultGameState = {
  totalInfectedCells: 0, totalCellsEver: 0, totalClicks: 0, clickPower: 1, clickPowerBonusFromCPS: 0, 
  cellsPerSecond: 0, clicksPerSecond: 0, prestigePoints: 0, purchasedBoosts: [], purchasedPrestigeUpgrades: [],
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
  singularite_biologique: 0, cost_singularite: 1500000000000, gain_singularite: 8000000000
};

function calculatePrestigePoints(cells) { return Math.floor(Math.sqrt(cells / PRESTIGE_THRESHOLD)); }
function getPlayerScalingFactor() { const playerCount = io.sockets.sockets.size; if (playerCount <= 4) return 1; return Math.sqrt(playerCount); }

function applyAllPurchasedBoosts(state) {
  let prestigeProdBonus = 1; let prestigeClickBonus = 1;
  if (state.purchasedPrestigeUpgrades.includes('p_efficacite_virale')) prestigeProdBonus = 1.25;
  if (state.purchasedPrestigeUpgrades.includes('p_clics_experts')) prestigeClickBonus = 2;

  state.clickPower = 1 * prestigeClickBonus; state.clickPowerBonusFromCPS = 0;
  state.gain_mutation = defaultGameState.gain_mutation * prestigeProdBonus;
  state.gain_oiseau = defaultGameState.gain_oiseau * prestigeProdBonus;
  state.gain_eau = defaultGameState.gain_eau * prestigeProdBonus;
  state.gain_aerosol = defaultGameState.gain_aerosol * prestigeProdBonus;
  state.gain_aeroport = defaultGameState.gain_aeroport * prestigeProdBonus;
  state.gain_ferme = defaultGameState.gain_ferme * prestigeProdBonus;
  state.gain_centre = defaultGameState.gain_centre * prestigeProdBonus;
  state.gain_propagande = defaultGameState.gain_propagande * prestigeProdBonus;
  state.gain_satellite = defaultGameState.gain_satellite * prestigeProdBonus;
  state.gain_clonage = defaultGameState.gain_clonage * prestigeProdBonus;
  state.gain_terraformation = defaultGameState.gain_terraformation * prestigeProdBonus;
  state.gain_singularite = defaultGameState.gain_singularite * prestigeProdBonus;

  let synergyBonusWater = 0; let synergyBonusFarms = 0; let globalMultiplier = 1;

  for (const boostId of state.purchasedBoosts) {
    if (boostId === 'seringue_precision') state.clickPower *= 2;
    if (boostId === 'doigts_bioniques') state.clickPower *= 3;
    if (boostId === 'gants_titane') state.clickPower *= 5;
    if (boostId === 'rage_virale') state.clickPower *= 10;
    if (boostId === 'clics_contamines') state.clickPowerBonusFromCPS += 0.01;
    if (boostId === 'osmose_tactile') state.clickPowerBonusFromCPS += 0.02;
    if (boostId === 'neurones_connectes') state.clickPower += (1000 * state.centres_contagion) * prestigeClickBonus;
    if (boostId === 'mutation_boost_clic_t1') state.clickPower += (0.5 * state.mutations_mineures) * prestigeClickBonus;
    if (boostId === 'mutation_boost_clic_t2') state.clickPower += (1 * state.mutations_mineures) * prestigeClickBonus;
    
    if (boostId === 'plumes_aero') state.gain_oiseau *= 2;
    if (boostId === 'filtres_mutagenes') state.gain_eau *= 2;
    if (boostId === 'spores_haute_densite') state.gain_aerosol *= 2;
    if (boostId === 'partenariats_logistiques') state.gain_aeroport *= 2;
    if (boostId === 'nutriments_ameliores') state.gain_ferme *= 2;
    if (boostId === 'gentrification_acceleree') state.gain_centre *= 2;
    if (boostId === 'fake_news') state.gain_propagande *= 2;
    if (boostId === 'sat_t1') state.gain_satellite *= 2;
    if (boostId === 'clone_t1') state.gain_clonage *= 2;
    if (boostId === 'terra_t1') state.gain_terraformation *= 2;
    if (boostId === 'singu_t1') state.gain_singularite *= 2;
    if (boostId === 'oiseau_t2') state.gain_oiseau *= 2;
    if (boostId === 'eau_t2') state.gain_eau *= 2;
    if (boostId === 'aerosol_t2') state.gain_aerosol *= 2;
    if (boostId === 'aeroport_t2') state.gain_aeroport *= 2;
    if (boostId === 'ferme_t2') state.gain_ferme *= 2;
    if (boostId === 'centre_t2') state.gain_centre *= 2;
    if (boostId === 'propagande_t2') state.gain_propagande *= 2;
    if (boostId === 'contamination_aviaire') synergyBonusWater += (0.01 * state.vecteurs_oiseaux);
    if (boostId === 'synergie_humide') synergyBonusFarms += (0.005 * state.contamination_eau);
    if (boostId === 'matrice_virale') globalMultiplier *= 1.5;
  }
  state.gain_eau *= (1 + synergyBonusWater);
  state.gain_ferme *= (1 + synergyBonusFarms);
  state.gain_mutation *= globalMultiplier; state.gain_oiseau *= globalMultiplier; state.gain_eau *= globalMultiplier; state.gain_aerosol *= globalMultiplier; state.gain_aeroport *= globalMultiplier; state.gain_ferme *= globalMultiplier; state.gain_centre *= globalMultiplier; state.gain_propagande *= globalMultiplier; state.gain_satellite *= globalMultiplier; state.gain_clonage *= globalMultiplier; state.gain_terraformation *= globalMultiplier; state.gain_singularite *= globalMultiplier;
  state.cellsPerSecond = (state.mutations_mineures * state.gain_mutation) + (state.vecteurs_oiseaux * state.gain_oiseau) + (state.contamination_eau * state.gain_eau) + (state.transmission_aerosol * state.gain_aerosol) + (state.aeroport_international * state.gain_aeroport) + (state.fermes_virales * state.gain_ferme) + (state.centres_contagion * state.gain_centre) + (state.propagande_virale * state.gain_propagande) + (state.satellite_dispersion * state.gain_satellite) + (state.clonage_humain * state.gain_clonage) + (state.terraformation_virale * state.gain_terraformation) + (state.singularite_biologique * state.gain_singularite);
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

function loadGameState() { try { const data = fs.readFileSync(SAVE_FILE, 'utf8'); const loaded = { ...defaultGameState, ...JSON.parse(data) }; for(const key in defaultGameState) { if(loaded[key] === undefined) loaded[key] = defaultGameState[key]; } applyAllPurchasedBoosts(loaded); return loaded; } catch (e) { return defaultGameState; } }
function saveGameState(state) { fs.writeFile(SAVE_FILE, JSON.stringify(state, null, 2), 'utf8', (err) => { if(err) console.error(err); }); }

let gameState = loadGameState();

function sendFullUpdate(target) {
  const availableBoosts = getAvailableBoosts(gameState);
  const prestigeInfo = { canPrestige: gameState.totalCellsEver >= PRESTIGE_THRESHOLD, pointsOnReset: calculatePrestigePoints(gameState.totalCellsEver) };
  target.emit('full_update', { gameState, availableBoosts, prestigeInfo, prestigeUpgrades: PRESTIGE_UPGRADE_DEFINITIONS });
}

// --- CONNEXIONS & SECURITE ---
io.on('connection', (socket) => {
  // 1. ANTI-MULTICOMPTE (Par Badge)
  const deviceId = socket.handshake.auth.token || 'unknown';
  let deviceCount = 0;
  for (const [_, s] of io.sockets.sockets) { if (s.handshake.auth.token === deviceId) deviceCount++; }
  
  if (deviceCount > MAX_TABS_PER_DEVICE) {
    socket.disconnect(true);
    console.log(`Blocage multi-comptes: ${deviceId}`);
    return;
  }

  console.log('Joueur connecté:', socket.id);
  
  // 2. MODE SPECTATEUR PAR DEFAUT
  socket.username = null;
  lastClickTime.set(socket.id, 0);
  lastChatTime.set(socket.id, 0);
  sendFullUpdate(socket);

  // 3. LOGIN SANS MOT DE PASSE
  socket.on('set_username', (name) => {
    if(typeof name === 'string' && name.trim().length > 0) { 
        let clean = xss(name.trim().substring(0, 15));
        // Interdiction nom système
        if (clean.toLowerCase().includes("scientifique")) clean = "Stagiaire";
        
        socket.username = clean;
        
        // Entrée dans le classement
        if(!playerStats.has(socket.id)) {
            playerStats.set(socket.id, { name: clean, clicks: 0, contribution: 0 });
        } else {
            playerStats.get(socket.id).name = clean;
        }
        
        // On confirme au client que c'est bon
        socket.emit('login_success', clean);
    }
  });

  // 4. ACTIONS PROTEGEES (Check if socket.username)
  socket.on('click_cell', () => {
    if (!socket.username) return;
    const now = Date.now();
    if (now - (lastClickTime.get(socket.id) || 0) < CLICK_COOLDOWN_MS) return;
    lastClickTime.set(socket.id, now);
    gameState.totalClicks++; currentTickClicks++;
    const base = gameState.clickPower;
    const bonus = gameState.cellsPerSecond * gameState.clickPowerBonusFromCPS;
    const total = (base + bonus) / getPlayerScalingFactor();
    if(playerStats.has(socket.id)) { const p = playerStats.get(socket.id); p.clicks++; p.contribution += total; }
    gameState.totalInfectedCells += total; gameState.totalCellsEver += total;
  });

  socket.on('buy_upgrade', (name) => {
    if (!socket.username) return;
    let bought = false;
    const checkAndBuy = (key, costKey) => {
      if(gameState[costKey] === undefined) return false;
      if (gameState.totalInfectedCells >= gameState[costKey]) {
        gameState.totalInfectedCells -= gameState[costKey]; gameState[key]++;
        gameState[costKey] = Math.ceil(defaultGameState[costKey] * Math.pow(COST_MULTIPLIER, gameState[key]));
        return true;
      } return false;
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
    if (bought) { applyAllPurchasedBoosts(gameState); sendFullUpdate(io); saveGameState(gameState); }
  });

  socket.on('buy_boost', (id) => {
    if (!socket.username) return;
    const boost = BOOST_DEFINITIONS[id];
    if (boost && !gameState.purchasedBoosts.includes(id)) {
      let cost = boost.cost;
      if (gameState.purchasedPrestigeUpgrades.includes('p_recherche_acceleree')) cost *= 0.9;
      if (gameState.totalInfectedCells >= cost) {
        gameState.totalInfectedCells -= cost; gameState.purchasedBoosts.push(id);
        applyAllPurchasedBoosts(gameState); sendFullUpdate(io); saveGameState(gameState);
      }
    }
  });

  socket.on('buy_prestige_upgrade', (id) => {
    if (!socket.username) return;
    const upg = PRESTIGE_UPGRADE_DEFINITIONS[id];
    if (upg && !gameState.purchasedPrestigeUpgrades.includes(id)) {
      if (gameState.prestigePoints >= upg.cost) {
        gameState.prestigePoints -= upg.cost; gameState.purchasedPrestigeUpgrades.push(id);
        applyAllPurchasedBoosts(gameState); sendFullUpdate(io); saveGameState(gameState);
      }
    }
  });

  socket.on('do_prestige', () => {
    if (!socket.username) return;
    const pts = calculatePrestigePoints(gameState.totalCellsEver);
    if (pts > 0) {
      const oldPrestige = gameState.prestigePoints; const oldUpgrades = gameState.purchasedPrestigeUpgrades;
      gameState = JSON.parse(JSON.stringify(defaultGameState));
      gameState.prestigePoints = oldPrestige + pts; gameState.purchasedPrestigeUpgrades = oldUpgrades;
      if (gameState.purchasedPrestigeUpgrades.includes('p_kit_demarrage')) gameState.mutations_mineures = 5;
      applyAllPurchasedBoosts(gameState); sendFullUpdate(io); saveGameState(gameState);
    }
  });

  socket.on('chat_message', (msg) => {
    if (!socket.username) return;
    
    // ANTI-SPAM TCHAT (3 secondes)
    const now = Date.now();
    const last = lastChatTime.get(socket.id) || 0;
    if (now - last < CHAT_COOLDOWN_MS) return;
    lastChatTime.set(socket.id, now);

    if(typeof msg !== 'string' || msg.trim().length === 0) return;
    const cleanMsg = xss(msg.substring(0, 100));
    io.emit('chat_message', { user: socket.username, text: cleanMsg });
  });

  socket.on('disconnect', () => { lastClickTime.delete(socket.id); lastChatTime.delete(socket.id); playerStats.delete(socket.id); });
});

function gameLoop() {
  const scale = getPlayerScalingFactor();
  const scaledGain = gameState.cellsPerSecond / scale;
  const tickGain = scaledGain / (1000 / TICK_RATE_MS);
  gameState.totalInfectedCells += tickGain; gameState.totalCellsEver += tickGain;
  
  const baseClick = gameState.clickPower;
  const bonusClick = gameState.cellsPerSecond * gameState.clickPowerBonusFromCPS;
  const currentClickValue = (baseClick + bonusClick) / scale;
  const clickHeat = currentTickClicks / (TICK_RATE_MS / 1000);
  currentTickClicks = 0;

  const leaderboard = Array.from(playerStats.values()).sort((a, b) => b.contribution - a.contribution).slice(0, 10);
  io.emit('tick_update', { score: gameState.totalInfectedCells, cps: gameState.cellsPerSecond, clickValue: currentClickValue, clickHeat: clickHeat, players: io.sockets.sockets.size, leaderboard: leaderboard });
}

setInterval(gameLoop, TICK_RATE_MS);
setInterval(() => saveGameState(gameState), SAVE_INTERVAL_MS);

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
http.listen(PORT, () => console.log(`Serveur public démarré sur le port ${PORT}`));