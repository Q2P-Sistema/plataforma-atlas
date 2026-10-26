import { defineConfig } from 'vitest/config';

// Os testes de banco (*-db.test.ts, opt-in com ATLAS_DB_INTEGRATION=1) criam e removem as mesmas tabelas do espelho
// OMIE no schema public: em paralelo, um arquivo derruba a tabela que o outro usa ou a encontra com dados e pula em
// silencio. Com o opt-in os arquivos rodam um por vez; sem ele (CI e uso normal) segue o paralelo padrao.
export default defineConfig({
  test: {
    fileParallelism: process.env.ATLAS_DB_INTEGRATION !== '1',
  },
});
