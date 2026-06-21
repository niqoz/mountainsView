import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  // GitHub Pages sert le site sous https://niqoz.github.io/mountainsView/
  // → tous les chemins d'assets doivent être préfixés par le nom du dépôt.
  base: '/mountainsView/',
  server: {
    host: true, // accessible sur le réseau local → téléphone peut accéder via HTTPS
  },
  plugins: [
    basicSsl(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'MountainsView',
        short_name: 'Mountains',
        description: 'Réalité augmentée : noms des sommets de montagne en temps réel',
        theme_color: '#0d1117',
        background_color: '#0d1117',
        display: 'fullscreen',
        orientation: 'any',
      },
    }),
  ],
});
