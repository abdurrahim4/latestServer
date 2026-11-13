import {storageMode} from './repositories/jsonStore.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import {z} from 'zod';
import {list,mutate,createBranchAndEmployee,getOrderPage,findRecord,getDeliverySettings,saveDeliverySettings,getPromotionsForBranch,getDeliveryPromotionsAdmin,createDeliveryPromotion,patchDeliveryPromotion,deleteDeliveryPromotion,getActiveDeliveryBranches} from './repositories/jsonStore.js';
import {auth,access,manager,tokenFor} from './middleware/auth.js';
import {createOrder,changeStatus,OrderError} from './services/orders.js';
import {quoteDelivery,verifyDeliveryQuote,trackingToken,verifyTrackingToken,nearestBranches} from './services/delivery.js';
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const fail=(status,message)=>{throw new OrderError(message,status);};
const page=(rows,req)=>{const limit=Math.min(100,Math.max(1,Number(req.query.limit)||20)),offset=Math.max(0,Number(req.query.offset)||0);return {data:rows.slice(offset,offset+limit),pagination:{total:rows.length,limit,offset}};};
const text=z.string().trim().min(1).max(250);
const productSchema=z.object({name:z.record(z.string()).refine(o=>!!o.pl||!!o.en),description:z.record(z.string()).default({}),categoryId:text,price:z.number().finite().min(0).max(100000),available:z.boolean().default(true),imageUrl:z.string().max(2000).default(''),customizationGroupIds:z.array(z.string()).default([]),sortOrder:z.number().int().default(0)});
const groupSchema=z.object({name:text,min:z.number().int().min(0).max(30),max:z.number().int().min(1).max(30),options:z.array(z.object({id:z.string().min(1).max(100),name:text,price:z.number().finite().min(0).max(100000),available:z.boolean().default(true)})).min(1).max(60)}).refine(x=>x.min<=x.max&&x.max<=x.options.length,{message:'Invalid selection limits'});
const vatRate=z.number().finite().min(0).max(100);
const categorySchema=z.object({id:z.string().trim().min(1).max(70).regex(/^[a-z0-9_-]+$/),name:z.object({pl:text,en:z.string().max(250).optional()}),vatRate:vatRate.default(0),sortOrder:z.number().int().default(0)});
const orderSchema=z.object({branchId:text,customer:z.object({name:text,phone:text,address:text}),items:z.array(z.object({productId:text,size:z.enum(['small','medium','large']).optional(),quantity:z.number().int().min(1).max(30),selections:z.record(z.array(z.string())).optional(),instructions:z.string().max(500).optional()})).min(1).max(40),paymentMethod:z.enum(['cash_on_delivery','card_on_delivery']),idempotencyKey:z.string().min(8).max(120).optional(),deliveryQuoteToken:z.string().min(12).optional()});
const settingsSchema=z.object({available:z.boolean().optional(),hours:z.object({open:z.string().regex(/^\d\d:\d\d$/),close:z.string().regex(/^\d\d:\d\d$/)}).optional(),phone:z.string().max(40).optional()});
async function validateProductGroups(ids,branchId){if(new Set(ids).size!==ids.length)fail(400,'Duplicate customization group');const groups=await list('customization-groups');for(const id of ids){if(!groups.some(g=>g.id===id&&(g.global===true||g.branchId===branchId)))fail(400,'Invalid customization group for branch');}}
export function createApp(io){
 const app=express();app.disable('x-powered-by');app.use(helmet());
 app.use(cors());
 // Parse JSON request bodies for login, checkout and management routes.
 app.use(express.json({ limit: '100kb' }));
 app.use('/api',rateLimit({windowMs:60000,limit:240,standardHeaders:'draft-7',legacyHeaders:false}));
 app.get('/health',(_q,r)=>r.json({status:'ok',storage:storageMode()}));
 app.post('/api/v1/auth/login',rateLimit({windowMs:60000,limit:10}),wrap(async(req,res)=>{
  const {email,password}=z.object({email:z.string().min(1),password:z.string().min(1)}).parse(req.body);
  const users=await list('users');const user=users.find(u=>(u.email?.toLowerCase()===email.toLowerCase()||u.username?.toLowerCase()===email.toLowerCase())&&u.active);
  if(!user||!await bcrypt.compare(password,user.passwordHash))fail(401,'Invalid credentials');
  res.json({data:{token:tokenFor(user),user:{id:user.id,email:user.email,role:user.role,branchIds:user.branchIds}}});
 }));
 app.get('/api/v1/auth/me',auth,wrap(async(req,res)=>{const user=(await list('users')).find(u=>u.id===req.user.sub&&u.active);if(!user)fail(401,'Account disabled');res.json({data:{id:user.id,email:user.email,role:user.role,branchIds:user.branchIds}});}));
 app.get('/api/v1/restaurants',wrap(async(req,res)=>{let rows=(await list('branches')).filter(b=>!b.deletedAt);if(req.query.city)rows=rows.filter(b=>b.city.toLowerCase().includes(String(req.query.city).toLowerCase()));if(req.query.search)rows=rows.filter(b=>(b.name+' '+b.city).toLowerCase().includes(String(req.query.search).toLowerCase()));if(req.query.available!==undefined)rows=rows.filter(b=>b.available===(req.query.available==='true'));res.json(page(rows,req));}));
 app.get('/api/v1/restaurants/:id',wrap(async(req,res)=>{const b=(await list('branches')).find(b=>b.id===req.params.id);if(!b||b.deletedAt)fail(404,'Branch not found');res.json({data:b});}));
 app.get('/api/v1/restaurants/:id/products',wrap(async(req,res)=>{let rows=(await list('products')).filter(p=>p.branchId===req.params.id&&!p.archived&&p.available);if(req.query.category)rows=rows.filter(p=>p.categoryId===req.query.category);if(req.query.search)rows=rows.filter(p=>Object.values(p.name).join(' ').toLowerCase().includes(String(req.query.search).toLowerCase()));res.json(page(rows.sort((a,b)=>a.sortOrder-b.sortOrder),req));}));
 app.get('/api/v1/restaurants/:id/products/:productId',wrap(async(req,res)=>{const p=(await list('products')).find(p=>p.id===req.params.productId&&p.branchId===req.params.id&&!p.archived&&p.available);if(!p)fail(404,'Product not found');const groups=(await list('customization-groups')).filter(g=>p.customizationGroupIds.includes(g.id));res.json({data:{...p,customizationGroups:groups}});}));
 app.get('/api/v1/restaurants/:id/categories',wrap(async(req,res)=>{const products=(await list('products')).filter(p=>p.branchId===req.params.id&&!p.archived);const ids=new Set(products.map(p=>p.categoryId));res.json({data:(await list('categories')).filter(c=>ids.has(c.id))});}));
 app.get('/api/v1/restaurants/:id/customizations',wrap(async(req,res)=>res.json({data:(await list('customization-groups')).filter(g=>g.branchId===req.params.id||!g.branchId)})));
 const onlySuper=(req,res,next)=>req.user?.role==='super_admin'?next():res.status(403).json({error:{code:'FORBIDDEN',message:'Super Admin required'}});
 // Delivery configuration is managed exclusively by the Super Admin.
 const deliveryBandsSchema=z.array(z.object({upToKm:z.number().int().min(1).max(15),fee:z.number().finite().min(0).max(1000)})).length(15).refine(a=>a.every((x,i)=>x.upToKm===i+1));
 const promotionSchema=z.object({name:z.string().trim().min(1).max(120),type:z.enum(['free_delivery','fixed_discount']),amount:z.number().finite().min(0).max(1000).default(0),startAt:z.string().datetime({offset:true}),endAt:z.string().datetime({offset:true}),branchIds:z.array(z.string()).default([]),enabled:z.boolean().default(true)}).refine(p=>Date.parse(p.endAt)>Date.parse(p.startAt),{message:'End must follow start'});
 const defaultBands=()=>{const entries=String(process.env.DELIVERY_FEE_BANDS||'3:5,7:8,10:12,15:16').split(',').map(s=>s.split(':').map(Number));return Array.from({length:15},(_,i)=>({upToKm:i+1,fee:entries.find(([km])=>i+1<=km)?.[1]??entries.at(-1)?.[1]??0}));};
 app.get('/api/v1/management/delivery-settings',auth,onlySuper,wrap(async(_req,res)=>{const stored=await getDeliverySettings();res.json({data:{bands:stored?.bands||defaultBands(),promotions:await getDeliveryPromotionsAdmin()}})}));
 app.put('/api/v1/management/delivery-settings/bands',auth,onlySuper,wrap(async(req,res)=>{const bands=deliveryBandsSchema.parse(req.body.bands);await saveDeliverySettings(bands);res.json({data:{bands}})}));
 app.post('/api/v1/management/delivery-promotions',auth,onlySuper,wrap(async(req,res)=>{const data=promotionSchema.parse(req.body);const row={...data,id:crypto.randomUUID(),createdAt:new Date().toISOString()};await createDeliveryPromotion(row);res.status(201).json({data:row})}));
 app.patch('/api/v1/management/delivery-promotions/:id',auth,onlySuper,wrap(async(req,res)=>{const patch=promotionSchema.partial().parse(req.body);const row=await patchDeliveryPromotion(req.params.id,patch);if(!row)fail(404,'Promotion not found');res.json({data:row})}));
 app.delete('/api/v1/management/delivery-promotions/:id',auth,onlySuper,wrap(async(req,res)=>{if(!await deleteDeliveryPromotion(req.params.id))fail(404,'Promotion not found');res.json({data:{deleted:true}})}));
 const deliveryAddressSchema=z.object({street:text,houseNumber:text,city:text,postalCode:z.string().trim().min(1).max(30),apartment:z.string().max(50).optional(),floor:z.string().max(30).optional()});
 app.post('/api/v1/delivery/nearest',rateLimit({windowMs:60000,limit:8}),wrap(async(req,res)=>{
  const {latitude,longitude}=z.object({latitude:z.number().finite().min(-90).max(90),longitude:z.number().finite().min(-180).max(180)}).parse(req.body);
  const branches=await list('branches');
  const results=await nearestBranches(latitude,longitude,branches,3);
  res.json({data:results});
 }));
 app.post('/api/v1/delivery/quote',rateLimit({windowMs:60000,limit:15}),wrap(async(req,res)=>{const body=z.object({branchId:text,address:deliveryAddressSchema,subtotal:z.number().finite().min(0).max(100000).optional()}).parse(req.body);const branch=await findRecord('branches',{id:body.branchId});if(!branch||branch.deletedAt||!branch.available)fail(404,'Branch unavailable');const [settings,promotions,branches]=await Promise.all([getDeliverySettings(),getPromotionsForBranch(branch.id),getActiveDeliveryBranches(branch.id)]);const result=await quoteDelivery(branch,body.address,branches,{settings,promotions});res.json({data:result});}));
 app.post('/api/v1/orders',wrap(async(req,res)=>{const body=orderSchema.parse(req.body);if(!body.deliveryQuoteToken)fail(400,'Verify delivery address first');const delivery=verifyDeliveryQuote(body.deliveryQuoteToken,body.branchId);body.customer.address=delivery.formattedAddress;body.delivery=delivery;const {order,created}=await createOrder(body,io);res.status(created?201:200).json({data:{...order,trackingToken:trackingToken(order.id),accessToken:undefined},created});}));
 app.get('/api/v1/orders/:id/track',rateLimit({windowMs:60000,limit:30}),wrap(async(req,res)=>{if(!verifyTrackingToken(req.params.id,req.get('X-Order-Token')))fail(403,'Invalid tracking token');const order=await findRecord('orders',{id:req.params.id});if(!order)fail(404,'Order not found');res.json({data:{id:order.id,branchId:order.branchId,status:order.status,createdAt:order.createdAt,updatedAt:order.updatedAt,total:order.total,estimatedDeliveryAt:order.estimatedDeliveryAt||null}});}));
 // Guest order lookup requires a secret generated at checkout. Existing orders are intentionally inaccessible to unauthenticated callers.
 app.get('/api/v1/orders/:id',auth,wrap(async(req,res)=>{const o=await findRecord('orders',{id:req.params.id});if(!o)fail(404,'Order not found');if(req.user.role!=='super_admin'&&!req.user.branchIds.includes(o.branchId))fail(403,'Access denied');res.json({data:o});}));


 const hhmm=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
 const schedule=z.record(z.enum(['monday','tuesday','wednesday','thursday','friday','saturday','sunday']),z.object({closed:z.boolean(),open:hhmm.optional(),close:hhmm.optional()}).refine(x=>x.closed||(x.open&&x.close),'Open and close times required')).refine(x=>Object.keys(x).length===7,'All seven days required');
 const branchFields=z.object({name:text,restaurantName:text,address:text,city:text,postalCode:z.string().max(30).default(''),phone:text,email:z.union([z.string().email(),z.literal('')]).default(''),timezone:z.string().min(1).max(100).default('Europe/Warsaw'),houseNumber:z.string().trim().max(30).default(''),latitude:z.number().finite().min(-90).max(90),longitude:z.number().finite().min(-180).max(180),active:z.boolean().default(true),schedule});
 const employeeFields=z.object({fullName:text,username:z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/),password:z.string().min(10).max(128),role:z.enum(['manager','staff'])});
 const publicEmployee=u=>({id:u.id,fullName:u.fullName,username:u.username,role:u.role,branchIds:u.branchIds,active:u.active});
 app.post('/api/v1/management/branches',auth,onlySuper,wrap(async(req,res)=>{
   const {employee,...rest}=z.object({...branchFields.shape,employee:employeeFields}).parse(req.body);
   try { new Intl.DateTimeFormat('en',{timeZone:rest.timezone}); } catch { fail(400,'Invalid timezone'); }
   const id=crypto.randomUUID();
   const branch={...rest,id,restaurantId:'delta-kebab',available:rest.active,deletedAt:null,createdAt:new Date().toISOString(),hours:{open:rest.schedule.monday.open||'00:00',close:rest.schedule.monday.close||'00:00'}};
   const username=employee.username.toLowerCase();
   const user={id:crypto.randomUUID(),email:username+'@staff.deltakebab.local',username,fullName:employee.fullName,role:employee.role,branchIds:[id],active:true,passwordHash:await bcrypt.hash(employee.password,12)};
   await createBranchAndEmployee(branch,user);
   res.status(201).json({data:{branch,employee:publicEmployee(user)}});
 }));
 app.get('/api/v1/management/branches',auth,onlySuper,wrap(async(req,res)=>{
   let rows=await list('branches');
   if(req.query.search){const q=String(req.query.search).toLowerCase();rows=rows.filter(b=>[b.name,b.restaurantName,b.city,b.address,b.id].some(x=>String(x||'').toLowerCase().includes(q)));}
   if(req.query.status==='active')rows=rows.filter(b=>b.active!==false&&!b.deletedAt);
   if(req.query.status==='inactive')rows=rows.filter(b=>b.active===false&&!b.deletedAt);
   if(req.query.status==='deleted')rows=rows.filter(b=>!!b.deletedAt);
   res.json(page(rows,req));
 }));
 app.patch('/api/v1/management/branches/:branchId',auth,onlySuper,wrap(async(req,res)=>{
   const body=branchFields.partial().parse(req.body);
   if(body.timezone){try{new Intl.DateTimeFormat('en',{timeZone:body.timezone})}catch{fail(400,'Invalid timezone')}}
   const branch=await mutate('branches',rows=>{const b=rows.find(x=>x.id===req.params.branchId);if(!b||b.deletedAt)fail(404,'Branch not found');Object.assign(b,body);if(body.active!==undefined)b.available=body.active;if(body.schedule)b.hours={open:body.schedule.monday?.open||'00:00',close:body.schedule.monday?.close||'00:00'};return structuredClone(b)});
   res.json({data:branch});
 }));
 app.delete('/api/v1/management/branches/:branchId',auth,onlySuper,wrap(async(req,res)=>{
   const hasOrders=!!(await findRecord('orders',{branchId:req.params.branchId}));
   const branch=await mutate('branches',rows=>{const b=rows.find(x=>x.id===req.params.branchId);if(!b||b.deletedAt)fail(404,'Branch not found');b.deletedAt=new Date().toISOString();b.active=false;b.available=false;return structuredClone(b)});
   res.json({data:{...branch,softDeleted:true,hasOrders}});
 }));
 app.post('/api/v1/management/branches/:branchId/restore',auth,onlySuper,wrap(async(req,res)=>{
   const branch=await mutate('branches',rows=>{const b=rows.find(x=>x.id===req.params.branchId);if(!b)fail(404,'Branch not found');b.deletedAt=null;b.active=true;b.available=true;return structuredClone(b)});res.json({data:branch});
 }));
 app.get('/api/v1/management/branches/:branchId/employees',auth,access,manager,wrap(async(req,res)=>{
   res.json({data:(await list('users')).filter(u=>u.branchIds?.includes(req.params.branchId)).map(publicEmployee)});
 }));
 app.post('/api/v1/management/branches/:branchId/employees',auth,onlySuper,wrap(async(req,res)=>{
   const body=employeeFields.parse(req.body);
   if(!(await list('branches')).some(b=>b.id===req.params.branchId&&!b.deletedAt))fail(404,'Branch not found');
   const username=body.username.toLowerCase();
   const user={id:crypto.randomUUID(),email:username+'@staff.deltakebab.local',username,fullName:body.fullName,role:body.role,branchIds:[req.params.branchId],active:true,passwordHash:await bcrypt.hash(body.password,12)};
   await mutate('users',rows=>{if(rows.some(u=>u.username?.toLowerCase()===username||u.email?.toLowerCase()===user.email))fail(409,'Username already exists');rows.push(user)});
   res.status(201).json({data:publicEmployee(user)});
 }));
 app.patch('/api/v1/management/branches/:branchId/employees/:employeeId',auth,onlySuper,wrap(async(req,res)=>{
   const body=z.object({fullName:text.optional(),username:z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/).optional(),role:z.enum(['manager','staff']).optional(),active:z.boolean().optional()}).strict().parse(req.body);
   if(!Object.keys(body).length)fail(400,'No changes provided');
   const updated=await mutate('users',rows=>{const u=rows.find(x=>x.id===req.params.employeeId&&x.branchIds?.includes(req.params.branchId)&&x.role!=='super_admin');if(!u)fail(404,'Employee not found');if(body.username){const username=body.username.toLowerCase();if(rows.some(x=>x.id!==u.id&&(x.username?.toLowerCase()===username||x.email?.toLowerCase()===username+'@staff.deltakebab.local')))fail(409,'Username already in use');u.username=username;u.email=username+'@staff.deltakebab.local';}if(body.fullName!==undefined)u.fullName=body.fullName;if(body.role!==undefined)u.role=body.role;if(body.active!==undefined)u.active=body.active;return publicEmployee(u)});
   res.json({data:updated});
 }));
 app.delete('/api/v1/management/branches/:branchId/employees/:employeeId',auth,onlySuper,wrap(async(req,res)=>{
   const updated=await mutate('users',rows=>{const u=rows.find(x=>x.id===req.params.employeeId&&x.branchIds?.includes(req.params.branchId)&&x.role!=='super_admin');if(!u)fail(404,'Employee not found');u.active=false;u.deletedAt=new Date().toISOString();return publicEmployee(u)});
   res.json({data:updated});
 }));
 app.patch('/api/v1/management/branches/:branchId/employees/:employeeId/password',auth,onlySuper,wrap(async(req,res)=>{
   const {password}=z.object({password:z.string().min(10).max(128)}).parse(req.body);
   const hash=await bcrypt.hash(password,12);
   await mutate('users',rows=>{const u=rows.find(x=>x.id===req.params.employeeId&&x.branchIds?.includes(req.params.branchId));if(!u)fail(404,'Employee not found');u.passwordHash=hash});
   res.json({data:{updated:true}});
 }));

 const branch='/api/v1/management/branches/:branchId';app.use(branch,auth,access);
 app.get(branch+'/orders',wrap(async(req,res)=>{res.json(await getOrderPage(req.params.branchId,{status:req.query.status,limit:Math.min(100,Math.max(1,Number(req.query.limit)||20)),offset:Math.max(0,Number(req.query.offset)||0)}));}));
 app.patch(branch+'/orders/:orderId/status',wrap(async(req,res)=>{const {status,reason}=z.object({status:z.enum(['preparing','delivering','delivered','cancelled']),reason:z.string().max(500).optional()}).parse(req.body);res.json({data:await changeStatus(req.params.branchId,req.params.orderId,status,reason,io)});}));
 app.get(branch+'/products',wrap(async(req,res)=>{let rows=(await list('products')).filter(p=>p.branchId===req.params.branchId);if(req.query.search)rows=rows.filter(p=>Object.values(p.name).join(' ').toLowerCase().includes(String(req.query.search).toLowerCase()));if(req.query.archived!==undefined)rows=rows.filter(p=>p.archived===(req.query.archived==='true'));res.json(page(rows,req));}));
 app.post(branch+'/products',manager,wrap(async(req,res)=>{const body=productSchema.parse(req.body);if(!(await list('categories')).some(c=>c.id===body.categoryId))fail(400,'Create the category first');await validateProductGroups(body.customizationGroupIds,req.params.branchId);const p={...body,id:crypto.randomUUID(),branchId:req.params.branchId,currency:'PLN',archived:false};await mutate('products',rows=>rows.push(p));res.status(201).json({data:p});}));
 app.patch(branch+'/products/:productId',manager,wrap(async(req,res)=>{const body=productSchema.partial().parse(req.body);if(body.categoryId&&!(await list('categories')).some(c=>c.id===body.categoryId))fail(400,'Unknown category');if(body.customizationGroupIds)await validateProductGroups(body.customizationGroupIds,req.params.branchId);const p=await mutate('products',rows=>{const x=rows.find(p=>p.id===req.params.productId&&p.branchId===req.params.branchId);if(!x)fail(404,'Product not found');Object.assign(x,body);return structuredClone(x);});res.json({data:p});}));
 app.delete(branch+'/products/:productId',manager,wrap(async(req,res)=>{const p=await mutate('products',rows=>{const x=rows.find(p=>p.id===req.params.productId&&p.branchId===req.params.branchId);if(!x)fail(404,'Product not found');x.archived=true;return structuredClone(x);});res.json({data:p});}));
 app.post(branch+'/products/:productId/restore',manager,wrap(async(req,res)=>{const p=await mutate('products',rows=>{const x=rows.find(p=>p.id===req.params.productId&&p.branchId===req.params.branchId);if(!x)fail(404,'Product not found');x.archived=false;return structuredClone(x);});res.json({data:p});}));
 app.patch(branch+'/products/:productId/availability',manager,wrap(async(req,res)=>{const {available}=z.object({available:z.boolean()}).parse(req.body);const p=await mutate('products',rows=>{const x=rows.find(p=>p.id===req.params.productId&&p.branchId===req.params.branchId);if(!x)fail(404,'Product not found');x.available=available;return structuredClone(x);});res.json({data:p});}));
 app.post(branch+'/products/:productId/duplicate',manager,wrap(async(req,res)=>{const p=await mutate('products',rows=>{const x=rows.find(p=>p.id===req.params.productId&&p.branchId===req.params.branchId);if(!x)fail(404,'Product not found');const copy={...structuredClone(x),id:crypto.randomUUID(),archived:false};rows.push(copy);return copy;});res.status(201).json({data:p});}));
 app.post(branch+'/products/:productId/copy',manager,wrap(async(req,res)=>{const {targetBranchId}=z.object({targetBranchId:text}).parse(req.body);if(req.user.role!=='super_admin'&&!req.user.branchIds.includes(targetBranchId))fail(403,'Target branch denied');const p=await mutate('products',rows=>{const x=rows.find(p=>p.id===req.params.productId&&p.branchId===req.params.branchId);if(!x)fail(404,'Product not found');const copy={...structuredClone(x),id:crypto.randomUUID(),branchId:targetBranchId,archived:false};rows.push(copy);return copy;});res.status(201).json({data:p});}));
 app.patch(branch+'/bulk/products',manager,wrap(async(req,res)=>{const {ids,available,price}=z.object({ids:z.array(text).min(1).max(100),available:z.boolean().optional(),price:z.number().min(0).max(100000).optional()}).parse(req.body);const changed=await mutate('products',rows=>{const affected=rows.filter(p=>p.branchId===req.params.branchId&&ids.includes(p.id));for(const p of affected){if(available!==undefined)p.available=available;if(price!==undefined)p.price=price;}return affected.length;});res.json({data:{updated:changed}});}));
 app.get(branch+'/settings',wrap(async(req,res)=>{const b=(await list('branches')).find(x=>x.id===req.params.branchId);res.json({data:b});}));
 app.patch(branch+'/settings',manager,wrap(async(req,res)=>{const body=settingsSchema.parse(req.body);const b=await mutate('branches',rows=>{const x=rows.find(x=>x.id===req.params.branchId);if(!x)fail(404,'Branch not found');Object.assign(x,body);return structuredClone(x);});res.json({data:b});}));
 app.get(branch+'/categories',wrap(async(req,res)=>res.json({data:await list('categories')})));
 app.get(branch+'/customizations',wrap(async(req,res)=>{const products=await list('products');const groups=await list('customization-groups');res.json({data:groups.filter(g=>g.branchId===req.params.branchId||(!g.branchId&&products.some(p=>p.branchId===req.params.branchId&&p.customizationGroupIds?.includes(g.id))))})}));
 app.post(branch+'/customizations',manager,wrap(async(req,res)=>{const body=groupSchema.parse(req.body);const group={...body,id:crypto.randomUUID(),branchId:req.params.branchId};await mutate('customization-groups',rows=>rows.push(group));res.status(201).json({data:group})}));
 app.patch(branch+'/customizations/:groupId',manager,wrap(async(req,res)=>{const body=groupSchema.parse(req.body);const updated=await mutate('customization-groups',rows=>{const g=rows.find(x=>x.id===req.params.groupId&&x.branchId===req.params.branchId);if(!g)fail(404,'Customization group not found');Object.assign(g,body);return structuredClone(g)});res.json({data:updated})}));
 app.delete(branch+'/customizations/:groupId',manager,wrap(async(req,res)=>{const used=(await list('products')).some(p=>p.branchId===req.params.branchId&&p.customizationGroupIds?.includes(req.params.groupId)&&!p.archived);if(used)fail(409,'Remove this group from active products before deleting it');await mutate('customization-groups',rows=>{const i=rows.findIndex(g=>g.id===req.params.groupId&&g.branchId===req.params.branchId);if(i<0)fail(404,'Group not found');rows.splice(i,1)});res.json({data:{deleted:true}})}));
 // Global product categories; VAT is an additional charge, not tax-inclusive pricing.
 app.get('/api/v1/management/categories',auth,onlySuper,wrap(async(_req,res)=>res.json({data:await list('categories')})));
 app.post('/api/v1/management/categories',auth,onlySuper,wrap(async(req,res)=>{const body=categorySchema.parse(req.body);const row=await mutate('categories',rows=>{if(rows.some(x=>x.id===body.id))fail(409,'Category ID already exists');const c={...body};rows.push(c);return c});res.status(201).json({data:row});}));
 app.patch('/api/v1/management/categories/:id',auth,onlySuper,wrap(async(req,res)=>{const body=categorySchema.omit({id:true}).partial().parse(req.body);const row=await mutate('categories',rows=>{const c=rows.find(x=>x.id===req.params.id);if(!c)fail(404,'Category not found');Object.assign(c,body);return structuredClone(c)});res.json({data:row});}));
 app.delete('/api/v1/management/categories/:id',auth,onlySuper,wrap(async(req,res)=>{if((await list('products')).some(p=>p.categoryId===req.params.id&&!p.archived))fail(409,'Category is used by active products');await mutate('categories',rows=>{const i=rows.findIndex(c=>c.id===req.params.id);if(i<0)fail(404,'Category not found');rows.splice(i,1)});res.json({data:{deleted:true}});}));
 // Shared options are global; products and their size groups remain branch-specific.
 const globalOptionSchema=z.intersection(groupSchema,z.object({type:z.enum(['sauce','meat','extra']),vatRate:vatRate.default(0)}));
 app.get('/api/v1/management/global-options',auth,onlySuper,wrap(async(_req,res)=>res.json({data:(await list('customization-groups')).filter(g=>g.global===true)})));
 app.post('/api/v1/management/global-options',auth,onlySuper,wrap(async(req,res)=>{const body=globalOptionSchema.parse(req.body);const group={...body,id:crypto.randomUUID(),global:true,branchId:null};await mutate('customization-groups',rows=>rows.push(group));res.status(201).json({data:group});}));
 app.patch('/api/v1/management/global-options/:id',auth,onlySuper,wrap(async(req,res)=>{const body=globalOptionSchema.parse(req.body);const group=await mutate('customization-groups',rows=>{const g=rows.find(x=>x.id===req.params.id&&x.global===true);if(!g)fail(404,'Global option group not found');Object.assign(g,body);return structuredClone(g)});res.json({data:group});}));
 app.delete('/api/v1/management/global-options/:id',auth,onlySuper,wrap(async(req,res)=>{if((await list('products')).some(p=>!p.archived&&p.customizationGroupIds?.includes(req.params.id)))fail(409,'This group is assigned to active products; remove it from those products first');await mutate('customization-groups',rows=>{const index=rows.findIndex(g=>g.id===req.params.id&&g.global===true);if(index<0)fail(404,'Global group not found');rows.splice(index,1)});res.json({data:{deleted:true}});}));
 app.use((_req,res)=>res.status(404).json({error:{code:'NOT_FOUND',message:'Route not found'}}));
 app.use((err,_req,res,next)=>{if(res.headersSent)return next(err);if(err instanceof z.ZodError)return res.status(400).json({error:{code:'VALIDATION',details:err.flatten()}});const status=err.status||500;if(status>=500)console.error(err);res.status(status).json({error:{code:status===500?'INTERNAL_ERROR':'REQUEST_ERROR',message:status===500?'Internal server error':err.message}});});
 return app;
}
