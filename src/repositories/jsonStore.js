import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');
const allowed = new Set(['restaurants','branches','products','categories','customization-groups','users','orders','inventory','delivery-settings','delivery-promotions']);
const mode = process.env.STORAGE_DRIVER || 'json';
if (!['json','mongodb','mongodb_v2'].includes(mode)) throw new Error('STORAGE_DRIVER must be json, mongodb or mongodb_v2');
const cache = new Map();
const queues = new Map();
let client;
let connection;

function check(name) { if (!allowed.has(name)) throw Error('Unknown collection: ' + name); return name; }
function filename(name) { return path.join(dir, `${check(name)}.json`); }

async function mongoCollection() {
  if (!['mongodb','mongodb_v2'].includes(mode)) throw Error('MongoDB storage is not enabled');
  if (!process.env.MONGODB_URI) throw Error('MONGODB_URI is required when STORAGE_DRIVER=mongodb');
  if (!connection) {
    client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: Number(process.env.DB_POOL_MAX || 10), serverSelectionTimeoutMS: 10000 });
    connection = client.connect().then(async () => {
      const db = client.db(process.env.MONGODB_DB_NAME || 'deltakebab');
      await db.command({ ping: 1 });
      return mode === 'mongodb_v2' ? db : db.collection('dk_collections');
    }).catch(async err => { connection = null; await client.close().catch(()=>{}); throw err; });
  }
  return connection;
}

export async function initStorage() {
  if (mode === 'mongodb_v2') { const db=await mongoCollection(); for(const name of allowed) await db.collection(name).createIndex({id:1},{unique:true}); await db.collection('delivery-promotions').createIndex({enabled:1,startAt:1,endAt:1}); await db.collection('delivery-promotions').createIndex({enabled:1,branchIds:1,endAt:1}); await db.collection('branches').createIndex({available:1,deletedAt:1}); await db.collection('orders').createIndex({branchId:1,status:1,createdAt:-1}); await db.collection('orders').createIndex({branchId:1,createdAt:-1}); await db.collection('orders').createIndex({branchId:1,idempotencyKey:1},{unique:true,partialFilterExpression:{idempotencyKey:{$type:'string'}}}); return; }
  if (mode !== 'mongodb') return;
  const collection = await mongoCollection();
  for (const name of allowed) {
    await collection.updateOne({ _id: name }, { $setOnInsert: { records: [], version: 0, updatedAt: new Date() } }, { upsert: true });
  }
}

export async function list(name) {
  check(name);
  if (mode === 'mongodb_v2') { const db=await mongoCollection(); return db.collection(name).find({}, {projection:{_id:0}}).toArray(); }
  if (mode === 'mongodb') {
    const collection = await mongoCollection();
    const document = await collection.findOne({ _id: name });
    if (!document) throw Error('MongoDB not initialized; run npm run db:init');
    return structuredClone(document.records);
  }
  if (!cache.has(name)) cache.set(name, JSON.parse(await fs.readFile(filename(name), 'utf8')));
  return structuredClone(cache.get(name));
}

export async function mutate(name, callback) {
  check(name);
  const previous = queues.get(name) || Promise.resolve();
  const task = previous.catch(()=>{}).then(async () => {
    if (mode === 'mongodb_v2') {
      // Compatibility adapter for legacy admin operations. New order routes use targeted queries.
      const db=await mongoCollection(); const col=db.collection(name);
      const records=await col.find({}, {projection:{_id:0}}).toArray();
      const before=new Map(records.map(x=>[x.id,JSON.stringify(x)]));
      const result=await callback(records);
      const after=new Set(records.map(x=>x.id));
      const ops=[];
      for(const record of records){if(!record.id)throw Error('Missing record id'); if(before.get(record.id)!==JSON.stringify(record))ops.push({replaceOne:{filter:{id:record.id},replacement:record,upsert:true}});}
      for(const id of before.keys())if(!after.has(id))ops.push({deleteOne:{filter:{id}}});
      if(ops.length)await col.bulkWrite(ops,{ordered:true}); return result;
    }
    if (mode === 'mongodb') {
      const collection = await mongoCollection();
      for (let attempt = 0; attempt < 8; attempt++) {
        const document = await collection.findOne({ _id: name });
        if (!document) throw Error('MongoDB not initialized; run npm run db:init');
        const records = structuredClone(document.records);
        const result = await callback(records);
        const updated = await collection.updateOne(
          { _id: name, version: document.version },
          { $set: { records, updatedAt: new Date() }, $inc: { version: 1 } }
        );
        if (updated.modifiedCount === 1) return result;
      }
      throw Error('Concurrent database updates; please retry');
    }
    const records = await list(name);
    const result = await callback(records);
    const file = filename(name), temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(records, null, 2), { flag:'wx', mode:0o600 });
    try { await fs.rename(temp, file); } catch(e) { await fs.rm(temp,{force:true}); throw e; }
    cache.set(name, records);
    return result;
  });
  queues.set(name, task);
  return task;
}

export const repositories = Object.fromEntries([...allowed].map(n => [n, { list: () => list(n), mutate: fn => mutate(n, fn) }]));
export async function closeStorage() { if (client) await client.close(); }
export function storageMode() { return mode === 'mongodb_v2' ? 'mongodb-v2' : mode === 'mongodb' ? 'mongodb' : 'local-json'; }

// Atomic branch + first employee creation. Atlas replica sets support transactions.
export async function createBranchAndEmployee(branch, employee) {
  if (mode === 'mongodb_v2') {
    const db=await mongoCollection(); const session=client.startSession();
    try { await session.withTransaction(async()=>{
      const users=db.collection('users');
      const existing=await users.findOne({$or:[{email:employee.email},{username:employee.username}]},{session});
      if(existing)throw Object.assign(new Error('Employee username or email already exists'),{status:409});
      await db.collection('branches').insertOne(branch,{session});
      await users.insertOne(employee,{session});
    }); } finally {await session.endSession();} return;
  }
  if (mode !== 'mongodb') throw Error('Atomic branch creation requires STORAGE_DRIVER=mongodb');
  await mongoCollection();
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const col = client.db(process.env.MONGODB_DB_NAME || 'deltakebab').collection('dk_collections');
      const branches = await col.findOne({_id:'branches'}, {session});
      const users = await col.findOne({_id:'users'}, {session});
      if (!branches || !users) throw Error('Initialize MongoDB first');
      if (branches.records.some(x => x.id === branch.id)) throw Error('Branch ID already exists');
      if (users.records.some(x => x.email?.toLowerCase() === employee.email.toLowerCase() || x.username?.toLowerCase() === employee.username.toLowerCase())) throw Object.assign(new Error('Employee username or email already exists'),{status:409});
      await col.updateOne({_id:'branches'}, {$push:{records:branch},$inc:{version:1},$set:{updatedAt:new Date()}}, {session});
      await col.updateOne({_id:'users'}, {$push:{records:employee},$inc:{version:1},$set:{updatedAt:new Date()}}, {session});
    });
  } finally { await session.endSession(); }
}

// Targeted MongoDB V2 operations: do not read the entire orders collection.
export async function findRecords(name, filter={}, options={}) {
 check(name); if(mode!=='mongodb_v2') {let rows=await list(name); return rows.filter(x=>Object.entries(filter).every(([k,v])=>x[k]===v)).slice(0,options.limit||100);} 
 const db=await mongoCollection(); return db.collection(name).find(filter,{projection:{_id:0}}).sort(options.sort||{createdAt:-1}).limit(Math.min(100,Math.max(1,options.limit||20))).toArray();
}
export async function findRecord(name,filter) {check(name);if(mode!=='mongodb_v2')return (await list(name)).find(x=>Object.entries(filter).every(([k,v])=>x[k]===v))||null; const db=await mongoCollection();return db.collection(name).findOne(filter,{projection:{_id:0}});}
export async function insertRecord(name,record) {check(name);if(mode!=='mongodb_v2')return mutate(name,rows=>{rows.push(record);return record;}); const db=await mongoCollection();await db.collection(name).insertOne(record);return record;}
export async function updateOrderRecord(branchId,id,oldStatus,patch) {
 if(mode!=='mongodb_v2')return mutate('orders',rows=>{const x=rows.find(o=>o.id===id&&o.branchId===branchId&&o.status===oldStatus);if(!x)return null;Object.assign(x,patch);return structuredClone(x);});
 const db=await mongoCollection();const result=await db.collection('orders').findOneAndUpdate({id,branchId,status:oldStatus},{$set:{status:patch.status,updatedAt:patch.updatedAt,cancellationReason:patch.cancellationReason},$push:{history:patch.historyEntry}},{returnDocument:'after',projection:{_id:0}});return result;
}
export async function getOrderPage(branchId,{status,limit=20,offset=0}={}){
 if(mode!=='mongodb_v2'){let rows=(await list('orders')).filter(o=>o.branchId===branchId&&(!status||o.status===status)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));return {data:rows.slice(offset,offset+limit),pagination:{total:rows.length,limit,offset}};}
 const db=await mongoCollection();const filter={branchId,...(status?{status}:{})};const col=db.collection('orders');
 const [data,total]=await Promise.all([col.find(filter,{projection:{_id:0}}).sort({createdAt:-1,id:-1}).skip(Math.min(100000,Math.max(0,offset))).limit(Math.min(100,Math.max(1,limit))).toArray(),col.countDocuments(filter)]);return {data,pagination:{total,limit,offset}};
}
export async function v2db(){if(mode!=='mongodb_v2')throw Error('Set STORAGE_DRIVER=mongodb_v2');return mongoCollection();}

// Optimized delivery configuration. Legacy JSON storage remains supported.
export async function getDeliverySettings() {
 if(mode==='mongodb_v2'){const db=await mongoCollection();return db.collection('delivery-settings').findOne({id:'default'},{projection:{_id:0}});}
 return (await list('delivery-settings')).find(x=>x.id==='default')||null;
}
export async function saveDeliverySettings(bands) {
 const row={id:'default',bands,updatedAt:new Date().toISOString()};
 if(mode==='mongodb_v2'){const db=await mongoCollection();await db.collection('delivery-settings').updateOne({id:'default'},{$set:row},{upsert:true});return row;}
 return mutate('delivery-settings',rows=>{const i=rows.findIndex(x=>x.id==='default');if(i>=0)rows[i]=row;else rows.push(row);return row;});
}
export async function getPromotionsForBranch(branchId,now=new Date().toISOString()) {
 if(mode==='mongodb_v2') {const db=await mongoCollection();return db.collection('delivery-promotions').find({enabled:true,startAt:{$lte:now},endAt:{$gt:now},$or:[{branchIds:branchId},{branchIds:{$size:0}},{branchIds:{$exists:false}}]},{projection:{_id:0}}).sort({createdAt:1}).limit(100).toArray();}
 return (await list('delivery-promotions')).filter(p=>p.enabled&&p.startAt<=now&&p.endAt>now&&(!p.branchIds?.length||p.branchIds.includes(branchId)));
}
export async function getDeliveryPromotionsAdmin(limit=100) {
 if(mode==='mongodb_v2'){const db=await mongoCollection();return db.collection('delivery-promotions').find({},{projection:{_id:0}}).sort({createdAt:-1}).limit(Math.min(500,limit)).toArray();}
 return (await list('delivery-promotions')).slice(0,limit);
}
export async function createDeliveryPromotion(row) {
 if(mode==='mongodb_v2'){const db=await mongoCollection();await db.collection('delivery-promotions').insertOne(row);return row;}
 return mutate('delivery-promotions',rows=>{rows.push(row);return row;});
}
export async function patchDeliveryPromotion(id,patch) {
 if(mode==='mongodb_v2') {const db=await mongoCollection();const col=db.collection('delivery-promotions');const old=await col.findOne({id});if(!old)return null;const next={...old,...patch};if(Date.parse(next.endAt)<=Date.parse(next.startAt))throw Object.assign(new Error('Invalid promotion dates'),{status:400});const updated=await col.findOneAndUpdate({id,startAt:old.startAt,endAt:old.endAt,updatedAt:old.updatedAt??{$exists:false}},{$set:{...patch,updatedAt:new Date().toISOString()}},{returnDocument:'after',projection:{_id:0}});if(!updated)throw Object.assign(new Error('Promotion modified concurrently; retry'),{status:409});return updated;}
 return mutate('delivery-promotions',rows=>{const p=rows.find(x=>x.id===id);if(!p)return null;Object.assign(p,patch);if(Date.parse(p.endAt)<=Date.parse(p.startAt))throw Object.assign(new Error('Invalid promotion dates'),{status:400});return structuredClone(p);});
}
export async function deleteDeliveryPromotion(id) {
 if(mode==='mongodb_v2'){const db=await mongoCollection();return (await db.collection('delivery-promotions').deleteOne({id})).deletedCount===1;}
 return mutate('delivery-promotions',rows=>{const i=rows.findIndex(x=>x.id===id);if(i<0)return false;rows.splice(i,1);return true;});
}
export async function getActiveDeliveryBranches(exceptId=null){
 if(mode==='mongodb_v2'){const db=await mongoCollection();return db.collection('branches').find({available:true,deletedAt:null,...(exceptId?{id:{$ne:exceptId}}:{})},{projection:{_id:0,id:1,name:1,latitude:1,longitude:1,available:1}}).toArray();}
 return (await list('branches')).filter(b=>b.available&&!b.deletedAt&&b.id!==exceptId);
}
