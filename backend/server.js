/**
 * Zeba's Tiffin — backend API
 * Plain Node/Express, file-based JSON storage (data/db.json) so it runs anywhere
 * Node runs, with zero external database service required. Swap the storage
 * layer for Postgres/MySQL later without touching the route logic — see README.
 */
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const DB_FILE = path.join(__dirname, 'data', 'db.json');
if(process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || !process.env.DATABASE_URL)){
  throw new Error('Production requires JWT_SECRET and DATABASE_URL environment variables.');
}
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
}) : null;
let dbState;
let saveQueue = Promise.resolve();

/* ---------------------------- storage layer ---------------------------- */
function seedDB(){
  const now = new Date();
  const endOfToday = new Date(now); endOfToday.setHours(23,59,59,999);
  return {
    users: [
      { id:'u_zeba', username:'zeba', passwordHash: bcrypt.hashSync('zeba123', 10), name:'Zeba', phone:'07954414208', role:'admin' },
      { id:'u_tabrez', username:'tabrez', passwordHash: bcrypt.hashSync('tabrez123', 10), name:'Tabrez', phone:'07914076790', role:'admin' }
    ],
    settings:{
      orderingEnabled:true,
      minLeadHours:1.5,
      tiffinPricing:{ veg:5, nonveg:6 },
      subscriptionPricing:{ veg:60, nonveg:70, both:120 },
      subscriptionIncludedQty:{ veg:1, nonveg:1, both:2 }
    },
    dishOfDay:{
      veg:{ name:'', available:true, mode:'daily', validUntil: endOfToday.toISOString() },
      nonVeg:{ name:'', available:true, mode:'daily', validUntil: endOfToday.toISOString() }
    },
    extras:[
      {id:'e1', name:'Chicken Biryani', category:'Biryani', price:4, available:true},
      {id:'e2', name:'Lamb Biryani', category:'Biryani', price:8, available:true},
      {id:'e3', name:'Sabudana Vada', category:'Snacks', price:2.5, available:true},
      {id:'e4', name:'Samosa Chaat', category:'Snacks', price:3, available:true},
      {id:'e5', name:'Aloo Tikki Chaat', category:'Snacks', price:3, available:true},
      {id:'e6', name:'Pani Puri', category:'Snacks', price:3, available:true},
      {id:'e7', name:'Bread Pakora', category:'Snacks', price:2.5, available:true},
      {id:'e8', name:'Masala Chai', category:'Drinks', price:1, available:true},
      {id:'e9', name:'Extra Roti / Phulka', category:'Extras', price:0.5, available:true},
      {id:'e10', name:'Extra Basmati Rice', category:'Extras', price:1.5, available:true},
      {id:'e11', name:'Extra Curry Bowl', category:'Extras', price:3, available:true},
      {id:'e12', name:'Sweet of the Day', category:'Extras', price:1.5, available:true},
      {id:'e13', name:'Fresh Raita', category:'Extras', price:1, available:true}
    ],
    orders: []
  };
}
function loadFileDB(){
  if(!fs.existsSync(DB_FILE)){
    fs.mkdirSync(path.dirname(DB_FILE), {recursive:true});
    const db = seedDB();
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    return db;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
async function initDB(){
  if(!pool){
    dbState = loadFileDB();
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id integer PRIMARY KEY CHECK (id = 1),
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const result = await pool.query('SELECT data FROM app_state WHERE id = 1');
  if(result.rowCount === 0){
    dbState = loadFileDB();
    await pool.query(
      'INSERT INTO app_state (id, data) VALUES (1, $1::jsonb)',
      [JSON.stringify(dbState)]
    );
  } else {
    dbState = result.rows[0].data;
  }
}
function loadDB(){ return dbState; }
function saveDB(db){
  dbState = db;
  if(pool){
    saveQueue = saveQueue
      .then(()=> pool.query(
        'UPDATE app_state SET data = $1::jsonb, updated_at = now() WHERE id = 1',
        [JSON.stringify(db)]
      ))
      .catch(error=> console.error('Database save failed:', error));
  } else {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }
}
function uid(prefix){ return prefix + '_' + Math.random().toString(36).slice(2,9) + Date.now().toString(36).slice(-4); }
function isoDate(d){ return d.toISOString().slice(0,10); }
function addDays(d,n){ const r = new Date(d); r.setDate(r.getDate()+n); return r; }

/* ---------------------------- business logic ---------------------------- */
function dishActiveNow(dish){
  if(!dish.name) return false;
  if(dish.mode === 'fixed') return true;
  if(!dish.validUntil) return false;
  return new Date() <= new Date(dish.validUntil);
}
function subscriptionCoversType(user, type){
  if(!user.subscription || !user.subscription.active) return false;
  const s = user.subscription;
  const today = isoDate(new Date());
  if(today < s.startDate || today > s.endDate) return false;
  return s.type === 'both' || s.type === type;
}
/**
 * Server-side, authoritative pricing. Never trust quantities/prices from the client.
 * `selections` = { veg:{sel,qty}, nonveg:{sel,qty}, extras:{ [extraId]: qty } }
 * Subscription covers up to `includedQty` tiffins per order (veg processed before
 * non-veg); anything past that budget, or of a type the plan doesn't cover, is
 * charged at the one-time per-portion price — never the monthly rate.
 */
function priceOrder(db, user, selections){
  const items = [];
  const settings = db.settings;
  let budget = (user.subscription && user.subscription.active)
    ? (user.subscription.includedQty ?? settings.subscriptionIncludedQty[user.subscription.type] ?? 0)
    : 0;

  ['veg','nonveg'].forEach(type=>{
    const sel = selections[type];
    if(!sel || !sel.sel || !sel.qty) return;
    const dish = type==='veg' ? db.dishOfDay.veg : db.dishOfDay.nonVeg;
    if(!dish.available || !dishActiveNow(dish)) throw new Error(`${type==='veg'?'Veg':'Non-Veg'} Tiffin is not available right now.`);
    const qty = Math.max(1, Math.min(50, Math.floor(sel.qty)));
    const covers = subscriptionCoversType(user, type);
    const coveredQty = covers ? Math.min(budget, qty) : 0;
    budget -= coveredQty;
    const chargedQty = qty - coveredQty;
    const unitPrice = settings.tiffinPricing[type] || 0;
    items.push({
      type:'tiffin', tiffinType:type,
      name: (type==='veg'?'Veg Tiffin':'Non-Veg Tiffin') + (dish.name ? ' — '+dish.name : ''),
      qty, coveredQty, chargedQty, unitPrice,
      lineTotal: Math.round(chargedQty*unitPrice*100)/100,
      coveredBySub: coveredQty>0
    });
  });

  const extraSel = selections.extras || {};
  Object.entries(extraSel).forEach(([id,qty])=>{
    qty = Math.max(0, Math.min(50, Math.floor(qty)));
    if(qty<=0) return;
    const ex = db.extras.find(x=>x.id===id);
    if(!ex || !ex.available) throw new Error('One of the extras in your order is no longer available.');
    items.push({
      type:'extra', name:ex.name, qty, coveredQty:0, chargedQty:qty,
      unitPrice: ex.price, lineTotal: Math.round(qty*ex.price*100)/100, coveredBySub:false
    });
  });

  if(items.length===0) throw new Error('Add a tiffin or at least one extra before placing your order.');
  const total = Math.round(items.reduce((s,it)=>s+it.lineTotal,0)*100)/100;
  return {items, total};
}

/* ---------------------------- app + auth ---------------------------- */
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend'))); // serves index.html at '/'

function sign(user){ return jwt.sign({id:user.id, role:user.role}, JWT_SECRET, {expiresIn:'30d'}); }
function auth(req,res,next){
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if(!token) return res.status(401).json({error:'Not logged in.'});
  try{
    const payload = jwt.verify(token, JWT_SECRET);
    const db = loadDB();
    const user = db.users.find(u=>u.id===payload.id);
    if(!user) return res.status(401).json({error:'Session no longer valid.'});
    req.user = user; req.db = db;
    next();
  }catch(e){ return res.status(401).json({error:'Session expired — please log in again.'}); }
}
function requireAdmin(req,res,next){
  if(req.user.role!=='admin') return res.status(403).json({error:'Admin access required.'});
  next();
}
function publicUser(u){ const {passwordHash, ...rest} = u; return rest; }

/* ---------------------------- auth routes ---------------------------- */
app.post('/api/auth/login', (req,res)=>{
  const {username, password} = req.body || {};
  const db = loadDB();
  const user = db.users.find(u=>u.username.toLowerCase()===(username||'').trim().toLowerCase());
  if(!user || !bcrypt.compareSync(password||'', user.passwordHash)){
    return res.status(401).json({error:'Incorrect username or password.'});
  }
  res.json({ token: sign(user), user: publicUser(user) });
});

/* ---------------------------- bootstrap (role-aware) ---------------------------- */
app.get('/api/bootstrap', auth, (req,res)=>{
  const db = req.db;
  if(req.user.role==='admin'){
    res.json({
      me: publicUser(req.user),
      settings: db.settings,
      dishOfDay: db.dishOfDay,
      extras: db.extras,
      customers: db.users.filter(u=>u.role==='customer').map(publicUser),
      orders: db.orders
    });
  } else {
    res.json({
      me: publicUser(req.user),
      settings: db.settings,
      dishOfDay: db.dishOfDay,
      extras: db.extras.filter(e=>e.available),
      orders: db.orders.filter(o=>o.userId===req.user.id)
    });
  }
});

/* ---------------------------- orders ---------------------------- */
app.post('/api/orders', auth, (req,res)=>{
  if(req.user.role!=='customer') return res.status(403).json({error:'Only customers place orders.'});
  const db = req.db;
  const { selections, requestedFor } = req.body || {};
  if(!requestedFor) return res.status(400).json({error:'Please choose a date and time.'});
  const minT = new Date(); minT.setMinutes(minT.getMinutes() + Math.round(db.settings.minLeadHours*60));
  if(new Date(requestedFor) < minT) return res.status(400).json({error:`Please choose a time at least ${db.settings.minLeadHours} hours from now.`});
  if(!db.settings.orderingEnabled) return res.status(400).json({error:"Ordering is closed by Zeba's Kitchen right now."});
  try{
    const {items, total} = priceOrder(db, req.user, selections || {});
    const order = {
      id: uid('o'), userId: req.user.id, customerName: req.user.name,
      placedAt: new Date().toISOString(), requestedFor, items, total,
      paymentStatus: total>0 ? 'unpaid' : 'n/a', status:'pending'
    };
    db.orders.push(order); saveDB(db);
    res.json(order);
  }catch(e){ res.status(400).json({error: e.message}); }
});

app.put('/api/orders/:id/status', auth, requireAdmin, (req,res)=>{
  const db = req.db;
  const o = db.orders.find(x=>x.id===req.params.id);
  if(!o) return res.status(404).json({error:'Order not found.'});
  const {status} = req.body || {};
  if(!['pending','confirmed','declined','delivered'].includes(status)) return res.status(400).json({error:'Invalid status.'});
  o.status = status; saveDB(db); res.json(o);
});
app.put('/api/orders/:id/payment', auth, requireAdmin, (req,res)=>{
  const db = req.db;
  const o = db.orders.find(x=>x.id===req.params.id);
  if(!o) return res.status(404).json({error:'Order not found.'});
  const {paymentStatus} = req.body || {};
  if(!['paid','unpaid'].includes(paymentStatus)) return res.status(400).json({error:'Invalid payment status.'});
  o.paymentStatus = paymentStatus; saveDB(db); res.json(o);
});

/* ---------------------------- settle (subscription + outstanding orders together) ---------------------------- */
app.put('/api/customers/:id/settle', auth, requireAdmin, (req,res)=>{
  const db = req.db;
  const c = db.users.find(u=>u.id===req.params.id && u.role==='customer');
  if(!c) return res.status(404).json({error:'Customer not found.'});
  let ordersSettled = 0;
  db.orders.forEach(o=>{
    if(o.userId===c.id && o.paymentStatus==='unpaid'){ o.paymentStatus='paid'; ordersSettled++; }
  });
  if(c.subscription && c.subscription.active) c.subscription.paymentStatus = 'paid';
  saveDB(db);
  res.json({ ordersSettled, subscription: c.subscription });
});

/* ---------------------------- dish of the day ---------------------------- */
app.put('/api/dish/:key', auth, requireAdmin, (req,res)=>{
  const db = req.db;
  const key = req.params.key; // 'veg' | 'nonVeg'
  if(!['veg','nonVeg'].includes(key)) return res.status(400).json({error:'Invalid dish key.'});
  const {name, mode, available} = req.body || {};
  let validUntil;
  const now = new Date();
  if(mode==='daily'){ const e=new Date(now); e.setHours(23,59,59,999); validUntil=e.toISOString(); }
  else if(mode==='weekly'){ validUntil = addDays(now,7).toISOString(); }
  else { validUntil = null; }
  db.dishOfDay[key] = { name: (name||'').trim(), mode, available: !!available, validUntil };
  saveDB(db); res.json(db.dishOfDay[key]);
});

/* ---------------------------- extras ---------------------------- */
app.post('/api/extras', auth, requireAdmin, (req,res)=>{
  const db = req.db;
  const {name, category, price} = req.body || {};
  if(!name) return res.status(400).json({error:'Name is required.'});
  const ex = {id:uid('e'), name:name.trim(), category:(category||'Extras').trim(), price:Number(price)||0, available:true};
  db.extras.push(ex); saveDB(db); res.json(ex);
});
app.put('/api/extras/:id', auth, requireAdmin, (req,res)=>{
  const db = req.db;
  const ex = db.extras.find(x=>x.id===req.params.id);
  if(!ex) return res.status(404).json({error:'Item not found.'});
  const {name, category, price, available} = req.body || {};
  if(name!==undefined) ex.name = name.trim();
  if(category!==undefined) ex.category = category.trim();
  if(price!==undefined) ex.price = Number(price)||0;
  if(available!==undefined) ex.available = !!available;
  saveDB(db); res.json(ex);
});
app.delete('/api/extras/:id', auth, requireAdmin, (req,res)=>{
  const db = req.db;
  db.extras = db.extras.filter(x=>x.id!==req.params.id);
  saveDB(db); res.json({ok:true});
});

/* ---------------------------- settings ---------------------------- */
app.put('/api/settings', auth, requireAdmin, (req,res)=>{
  const db = req.db;
  const s = req.body || {};
  if(s.orderingEnabled!==undefined) db.settings.orderingEnabled = !!s.orderingEnabled;
  if(s.minLeadHours!==undefined) db.settings.minLeadHours = Number(s.minLeadHours)||1;
  if(s.tiffinPricing){ Object.assign(db.settings.tiffinPricing, s.tiffinPricing); }
  if(s.subscriptionPricing){ Object.assign(db.settings.subscriptionPricing, s.subscriptionPricing); }
  if(s.subscriptionIncludedQty){ Object.assign(db.settings.subscriptionIncludedQty, s.subscriptionIncludedQty); }
  saveDB(db); res.json(db.settings);
});

/* ---------------------------- customers ---------------------------- */
app.post('/api/customers', auth, requireAdmin, (req,res)=>{
  const db = req.db;
  const {name, phone, username, password, subscription} = req.body || {};
  if(!name || !username || !password) return res.status(400).json({error:'Name, username and password are required.'});
  if(db.users.some(u=>u.username.toLowerCase()===username.trim().toLowerCase())) return res.status(400).json({error:'That username is already taken.'});
  const c = {
    id: uid('u'), username: username.trim().toLowerCase(), passwordHash: bcrypt.hashSync(password, 10),
    name: name.trim(), phone: (phone||'').trim(), role:'customer',
    subscription: subscription || {active:false, type:'veg', startDate:isoDate(new Date()), endDate:isoDate(addDays(new Date(),30)), paymentStatus:'due', includedQty:1}
  };
  db.users.push(c); saveDB(db); res.json(publicUser(c));
});
app.put('/api/customers/:id/subscription', auth, requireAdmin, (req,res)=>{
  const db = req.db;
  const c = db.users.find(u=>u.id===req.params.id && u.role==='customer');
  if(!c) return res.status(404).json({error:'Customer not found.'});
  c.subscription = req.body || {active:false};
  saveDB(db); res.json(publicUser(c));
});

app.get('/api/health', (req,res)=> res.json({ok:true, time:new Date().toISOString()}));

initDB()
  .then(()=> app.listen(PORT, ()=> console.log(`Zeba's Tiffin API listening on port ${PORT}`)))
  .catch(error=>{
    console.error('Database initialization failed:', error);
    process.exit(1);
  });
