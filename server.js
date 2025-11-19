const express = require('express');
require('dotenv').config();
const app = express();
const http = require('http').createServer(app);
const { Server } = require("socket.io");
const io = new Server(http);
const fs = require('fs');
const session = require('express-session'); // NOUVEAU: Pour les sessions utilisateur
const passport = require('passport'); // NOUVEAU: Authentification
const GoogleStrategy = require('passport-google-oauth20').Strategy; // NOUVEAU: Stratégie Google
const path = require('path'); // Pour gérer les chemins de fichiers

// --- VOS CLÉS GOOGLE (À REMPLACER) ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID; 
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET; 
const SESSION_SECRET = process.env.SESSION_SECRET;
const CALLBACK_URL = '/auth/google/callback';
// ------------------------------------

// --- SÉCURITÉ & MIDDLEWARE ---
const xss = require('xss');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({ windowMs: 15*60*1000, max: 100 }));

// NOUVEAU: Middleware de session
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Changer à true si vous utilisez HTTPS
}));

// NOUVEAU: Initialisation de Passport
app.use(passport.initialize());
app.use(passport.session());

// --- CONFIGURATION PASSPORT ---
passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL: CALLBACK_URL
  },
  (accessToken, refreshToken, profile, cb) => {
    // Dans un vrai jeu, vous vérifieriez ici si l'utilisateur existe dans votre base de données.
    // L'objet 'profile' contient les informations de l'utilisateur (id, nom, email).
    // Nous retournons simplement le profil pour l'utiliser dans la session.
    return cb(null, profile);
  }
));

// Sérialisation/désérialisation pour la session
passport.serializeUser((user, done) => {
    done(null, user);
});
passport.deserializeUser((user, done) => {
    done(null, user);
});

// --- CONSTANTES JEU (Laissé inchangé) ---
const TICK_RATE_MS = 200; 
const COST_MULTIPLIER = 1.15;
const SAVE_FILE = 'gameState.json';
const SAVE_INTERVAL_MS = 10000;
const PRESTIGE_THRESHOLD = 1e15; 
const CLICK_COOLDOWN_MS = 40; 
const MAX_TABS_PER_DEVICE = 3; 
const CHAT_COOLDOWN_MS = 2000; 
const CHAT_UNLOCK_CLICKS = 50; 
const BONUS_CHANCE_PER_TICK = 0.005; 
const BONUS_REWARD_SECONDS = 300; 

let currentTickClicks = 0;
let lastClickTime = new Map();
let playerStats = new Map();

// ... (fonctions getPlayerScalingFactor, applyAllPurchasedBoosts, getAvailableBoosts, loadGameState, saveGameState, defaultGameState, calculatePrestigePoints, BOOST_DEFINITIONS, PRESTIGE_UPGRADE_DEFINITIONS) ...
// NOTE: J'omets ces fonctions ici pour la concision, elles sont inchangées.
// Vous devez conserver toutes les fonctions de l'ancien 'server.js' ici.

let gameState = loadGameState();

function sendFullUpdate(target) {
    const availableBoosts = getAvailableBoosts(gameState);
    const prestigeInfo = { canPrestige: gameState.totalCellsEver >= PRESTIGE_THRESHOLD, pointsOnReset: calculatePrestigePoints(gameState.totalCellsEver) };
    target.emit('full_update', { gameState, availableBoosts, prestigeInfo, prestigeUpgrades: PRESTIGE_UPGRADE_DEFINITIONS });
}

// --- ROUTES D'AUTHENTIFICATION GOOGLE ---

// 1. Déclenche le flux OAuth (lorsque l'utilisateur clique sur le bouton)
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

// 2. Route de rappel après la connexion réussie
app.get(CALLBACK_URL, 
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => {
    // L'authentification a réussi. Redirige vers la page d'accueil.
    // On met en place le nom d'utilisateur dans la session
    req.session.username = xss(req.user.displayName || `Agent ${req.user.id.substring(0, 4)}`);

    // Nous devons mettre à jour l'état de la socket APRÈS la redirection
    // Le client sera déconnecté/reconnecté ou rafraîchi par le front-end.
    res.redirect('/');
  }
);

// 3. Route pour vérifier l'état de la connexion (pour le front-end)
app.get('/api/auth_status', (req, res) => {
    if (req.isAuthenticated() && req.session.username) {
        res.json({ isAuthenticated: true, username: req.session.username });
    } else {
        res.json({ isAuthenticated: false });
    }
});

// --- GESTION DES SOCKETS (MODIFIÉE) ---
io.on('connection', (socket) => {
  const deviceId = socket.handshake.auth.token || 'unknown';
  let deviceCount = 0;
  for (const [_, s] of io.sockets.sockets) { if (s.handshake.auth.token === deviceId) deviceCount++; }
  if (deviceCount > MAX_TABS_PER_DEVICE) { socket.disconnect(true); return; }

  console.log(`Joueur connecté: ${socket.id}`);
  
  // NOUVEAU: Vérification de l'authentification lors de la connexion Socket
  const username = socket.request.session.username;
  if (!username) {
      // Si l'utilisateur n'est pas connecté via Google, il est un simple invité.
      socket.username = 'Invité ' + socket.id.substring(0, 4);
  } else {
      socket.username = username;
      // Marquer comme authentifié
      const stats = playerStats.get(socket.id) || { name: username, clicks: 0, contribution: 0, hasCustomName: true, activeBonusId: null };
      stats.name = username;
      stats.hasCustomName = true;
      playerStats.set(socket.id, stats);
  }
  
  // Initialisation ou mise à jour des stats du joueur
  if (!playerStats.has(socket.id)) {
    playerStats.set(socket.id, { 
        name: socket.username, 
        clicks: 0, 
        contribution: 0, 
        hasCustomName: !!username, // true si auth Google
        activeBonusId: null 
    });
  }

  lastClickTime.set(socket.id, 0);
  sendFullUpdate(socket);

  // set_username n'est plus utilisé pour l'authentification principale.
  // Je le laisse pour la compatibilité, mais il devrait idéalement être retiré.
  socket.on('set_username', (name) => {
    if(typeof name === 'string' && name.trim().length > 0) { 
        const clean = xss(name.trim().substring(0, 15));
        socket.username = clean;
        const stats = playerStats.get(socket.id);
        if(stats) {
            stats.name = clean;
            stats.hasCustomName = true; // Permet aux invités de se nommer (si vous voulez)
        }
    }
  });

  // ... (Reste des gestionnaires d'événements socket: click_cell, buy_upgrade, etc. INCHANGÉS) ...

  socket.on('click_cell', () => {
    if(!playerStats.has(socket.id)) return;
    const stats = playerStats.get(socket.id);

    // DÉCISION: SEULS LES UTILISATEURS AUTHENTIFIÉS PEUVENT CLIQUER
    // if (!stats.hasCustomName) return; // Uncommenter ceci pour forcer l'auth Google

    const now = Date.now();
    const last = lastClickTime.get(socket.id) || 0;
    if (now - last < CLICK_COOLDOWN_MS) return; 
    
    lastClickTime.set(socket.id, now);
    
    gameState.totalClicks++; currentTickClicks++;
    const base = gameState.clickPower;
    const bonus = gameState.cellsPerSecond * gameState.clickPowerBonusFromCPS;
    const total = (base + bonus) / getPlayerScalingFactor();
    
    stats.clicks++; stats.contribution += total;
    gameState.totalInfectedCells += total; gameState.totalCellsEver += total;
  });
  
  // ... (Reste des gestionnaires d'événements socket : buy_upgrade, buy_boost, do_prestige, chat_message, etc.) ...
  socket.on('disconnect', () => { lastClickTime.delete(socket.id); playerStats.delete(socket.id); });
});

// --- GESTIONNAIRE DE SESSION POUR SOCKET.IO ---
const wrap = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
});

io.use((socket, next) => {
    wrap(socket.request, {}, next);
});

// --- ROUTES EXPRESS (MODIFIÉES) ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Serveur sur le port ${PORT}`));
// J'omets ici le reste des fonctions de jeu pour la concision du code du serveur.js.
// Assurez-vous de conserver toutes les fonctions de l'ancien 'server.js' après cette ligne.