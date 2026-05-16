# Tarot Africain — Serveur

Serveur WebSocket pour le jeu Tarot Africain multijoueur.

## Déploiement Railway

1. Créer un compte sur [railway.app](https://railway.app)
2. New Project → Deploy from GitHub repo
3. Sélectionner ce repo
4. Railway détecte automatiquement Node.js et lance `npm start`

## Variables d'environnement

- `PORT` : injecté automatiquement par Railway (ne pas modifier)

## API

- `WS /` : connexion WebSocket de jeu
- `GET /info` : retourne les IPs locales et les parties en lobby
