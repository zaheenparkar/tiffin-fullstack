const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if(!process.env.DATABASE_URL){
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const dbFile = path.join(__dirname, 'data', 'db.json');
if(!fs.existsSync(dbFile)){
  console.error(`Local database not found: ${dbFile}`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
});

async function main(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id integer PRIMARY KEY CHECK (id = 1),
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const existing = await pool.query('SELECT 1 FROM app_state WHERE id = 1');
  if(existing.rowCount > 0){
    throw new Error('Production database already contains app data; refusing to overwrite it.');
  }
  await pool.query(
    'INSERT INTO app_state (id, data) VALUES (1, $1::jsonb)',
    [JSON.stringify(data)]
  );
  console.log('Migrated backend/data/db.json to PostgreSQL.');
}

main()
  .catch(error=>{
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(()=> pool.end());
