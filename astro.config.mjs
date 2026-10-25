import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Production site: https://tokuprice.com/ (GitHub Pages + custom domain)
export default defineConfig({
  site: 'https://tokuprice.com',
  base: '/',
  trailingSlash: 'always',
  integrations: [sitemap()],
});
