import crypto from 'node:crypto';
import {OrderError} from './orders.js';

// Geoapify credentials stay on the server; never expose them in customer JavaScript.
const apiKey=()=>process.env.GEOAPIFY_API_KEY?.trim();
const secret=()=>process.env.DELIVERY_QUOTE_SECRET||process.env.DELIVERY_SIGNING_SECRET||process.env.JWT_SECRET;
const round=n=>Math.round((n+Number.EPSILON)*100)/100;
const b64=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
const sign=s=>crypto.createHmac('sha256',secret()).update(s).digest('base64url');
const pack=obj=>{if(!secret())throw new OrderError('Server delivery signing secret not configured',503);const payload=b64(obj);return `${payload}.${sign(payload)}`};
const unpack=token=>{if(!secret()||typeof token!=='string')throw new OrderError('Invalid delivery verification',403);const [payload,mac]=token.split('.');if(!payload||!mac)throw new OrderError('Invalid delivery verification',403);const expected=sign(payload);if(mac.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(mac),Buffer.from(expected)))throw new OrderError('Invalid delivery verification',403);let obj;try{obj=JSON.parse(Buffer.from(payload,'base64url').toString())}catch{throw new OrderError('Invalid delivery verification',403)}if(obj.exp<Date.now())throw new OrderError('Delivery verification expired; check address again',403);return obj};
// Geoapify routing uses lat,lon. Internally keep [lon,lat] GeoJSON order.
const coords=b=>{if(b.latitude===undefined||b.longitude===undefined||b.latitude===null||b.longitude===null||b.latitude===''||b.longitude==='')return null;const lat=Number(b.latitude),lon=Number(b.longitude);return Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180?[lon,lat]:null};
async function getJson(url){const ctl=new AbortController();const timeout=setTimeout(()=>ctl.abort(),9000);try{let response;try{response=await fetch(url,{signal:ctl.signal,headers:{Accept:'application/json'}})}catch{throw new OrderError('Geoapify is temporarily unavailable',503)}if(!response.ok){if(response.status===401||response.status===403)throw new OrderError('Geoapify API key or permissions invalid',503);if(response.status===429)throw new OrderError('Geoapify rate limit reached; try again later',503);throw new OrderError('Geoapify request failed',503)}return await response.json()}finally{clearTimeout(timeout)}}
async function geocode(address){const formattedAddress=[`${address.street} ${address.houseNumber}`.trim(),address.postalCode,address.city,'Poland'].filter(Boolean).join(', ');const params=new URLSearchParams({text:formattedAddress,filter:'countrycode:pl',limit:'1',format:'json',apiKey:apiKey()});const result=await getJson(`https://api.geoapify.com/v1/geocode/search?${params}`);const hit=result.results?.[0];if(!hit||!Number.isFinite(hit.lat)||!Number.isFinite(hit.lon)|| (hit.rank?.confidence!==undefined&&hit.rank.confidence<0.5))throw new OrderError('Could not locate delivery address',422);return {destination:[hit.lon,hit.lat],formattedAddress};}
async function routeKm(from,to){const params=new URLSearchParams({waypoints:`${from[1]},${from[0]}|${to[1]},${to[0]}`,mode:'drive',apiKey:apiKey()});const result=await getJson(`https://api.geoapify.com/v1/routing?${params}`);const meters=result.features?.[0]?.properties?.distance;if(!Number.isFinite(meters)||meters<0)throw new OrderError('Driving route unavailable',422);return round(meters/1000)}
const feeBands=()=>{const bands=String(process.env.DELIVERY_FEE_BANDS||'3:5,7:8,10:12,15:16').split(',').map(pair=>pair.split(':').map(Number)).filter(([km,fee])=>Number.isFinite(km)&&Number.isFinite(fee)&&km>0&&fee>=0).sort((a,b)=>a[0]-b[0]);if(!bands.length)throw new OrderError('Delivery fee bands not configured',503);return bands};
export async function quoteDelivery(branch,address,branches,config={}){if(!apiKey())throw new OrderError('Configure GEOAPIFY_API_KEY to enable delivery verification',503);const origin=coords(branch);if(!origin)throw new OrderError('Branch coordinates missing',422);const {destination,formattedAddress}=await geocode(address);const distanceKm=await routeKm(origin,destination);const maxKm=Number(process.env.DELIVERY_MAX_KM||15);if(!Number.isFinite(maxKm)||maxKm<=0)throw new OrderError('Invalid delivery distance configuration',503);const eligible=distanceKm<=maxKm;const bands=config.settings?.bands?.length===15?config.settings.bands.map(x=>[x.upToKm,x.fee]):feeBands();let deliveryFee=eligible?(bands.find(([km])=>distanceKm<=km)?.[1]??bands.at(-1)[1]):null;
 const now=Date.now();const promotion=eligible?(config.promotions||[]).find(p=>p.enabled&&Date.parse(p.startAt)<=now&&Date.parse(p.endAt)>now&&(!p.branchIds?.length||p.branchIds.includes(branch.id))):null;
 if(promotion?.type==='free_delivery')deliveryFee=0;
 if(promotion?.type==='fixed_discount')deliveryFee=round(Math.max(0,deliveryFee-Number(promotion.amount||0)));
 let recommended=null;if(!eligible){const nearby=branches.filter(b=>b.id!==branch.id&&coords(b)).map(b=>({b,d:Math.hypot((coords(b)[0]-destination[0])*Math.cos(destination[1]*Math.PI/180),coords(b)[1]-destination[1])})).sort((a,b)=>a.d-b.d).slice(0,5);for(const candidate of nearby){try{const d=await routeKm(coords(candidate.b),destination);if(d<=maxKm){recommended={branchId:candidate.b.id,name:candidate.b.name,distanceKm:d};break}}catch{}}}
 return {eligible,distanceKm,deliveryFee,formattedAddress,recommended,promotion:promotion?{id:promotion.id,name:promotion.name,type:promotion.type}:null,quoteToken:eligible?pack({branchId:branch.id,formattedAddress,distanceKm,deliveryFee,promotion:promotion?{id:promotion.id,name:promotion.name,type:promotion.type}:null,exp:Date.now()+10*60*1000}):null};}
export function verifyDeliveryQuote(token,branchId){const q=unpack(token);if(q.branchId!==branchId||q.distanceKm>Number(process.env.DELIVERY_MAX_KM||15)||!Number.isFinite(q.deliveryFee))throw new OrderError('Delivery verification mismatch',403);return q;}
export const trackingToken=id=>pack({id,exp:Date.now()+90*24*60*60*1000});
export function verifyTrackingToken(id,token){try{return unpack(token).id===id}catch{return false}}

// Calculate actual road distances from the visitor's GPS position to nearby branches.
// GPS coordinates are ephemeral and never stored. Candidate pruning reduces routing API usage.
export async function nearestBranches(latitude,longitude,branches,limit=3){
 if(!apiKey())throw new OrderError('Geoapify API key is not configured',503);
 const origin=[longitude,latitude];
 const rad=Math.PI/180;
 const haversine=b=>{const c=coords(b);if(!c)return Infinity;const dlat=(c[1]-latitude)*rad,dlon=(c[0]-longitude)*rad;const a=Math.sin(dlat/2)**2+Math.cos(latitude*rad)*Math.cos(c[1]*rad)*Math.sin(dlon/2)**2;return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));};
 const candidates=branches.filter(b=>b.available!==false&&!b.deletedAt&&coords(b)).map(b=>({branch:b,straightKm:haversine(b)})).sort((a,b)=>a.straightKm-b.straightKm).slice(0,Math.min(5,Math.max(3,limit)));
 if(!candidates.length)return [];
 const results=await Promise.all(candidates.map(async({branch})=>{try{return {branchId:branch.id,name:branch.name,address:branch.address,distanceKm:await routeKm(origin,coords(branch))}}catch{return null}}));
 return results.filter(Boolean).sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,limit);
}
