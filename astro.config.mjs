import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://www.theivybk.com',
  trailingSlash: 'never',
  build: {
    format: 'file',
  },
});
