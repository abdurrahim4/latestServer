import crypto from 'node:crypto';
import {list,mutate,storageMode,findRecord,insertRecord,updateOrderRecord,v2db} from '../repositories/jsonStore.js';
const money=n=>Math.round((n+Number.EPSILON)*100)/100;
export class OrderError extends Error { constructor(message,status=400){super(message);this.status=status;} }
export async function priceOrder(body) {
 const branches=await list('branches');
 if(!branches.some(b=>b.id===body.branchId&&b.available)) throw new OrderError('Branch unavailable');
 const products=storageMode()==='mongodb-v2'?[]:await list('products'), groups=storageMode()==='mongodb-v2'?[]:await list('customization-groups');
 const db=storageMode()==='mongodb-v2'?await v2db():null;
 if(!Array.isArray(body.items)||!body.items.length||body.items.length>40) throw new OrderError('Invalid cart');
 const categories=await list('categories');
 const items=[];for(const item of body.items){
  let product=products.find(p=>p.id===item.productId&&p.branchId===body.branchId&&!p.archived&&p.available);
  let groupList=groups;
  if(db){const assignment=await db.collection('branchProducts').findOne({branchId:body.branchId,productId:item.productId,available:true});
    if(assignment){const master=await db.collection('productCatalog').findOne({id:item.productId,active:{$ne:false}});if(master){const size=item.size||'small';if(!['small','medium','large'].includes(size))throw new OrderError('Invalid size');product={...master,price:assignment.prices[size]/100,selectedSize:size};groupList=await db.collection('sharedOptionGroups').find({id:{$in:master.customizationGroupIds||[]}}).toArray();}}
    if(!product){product=await db.collection('products').findOne({id:item.productId,branchId:body.branchId,available:true,archived:{$ne:true}});groupList=await db.collection('customization-groups').find({id:{$in:product?.customizationGroupIds||[]}}).toArray();}
  }
  if(!product) throw new OrderError('Product unavailable for selected branch');
  if(!Number.isInteger(item.quantity)||item.quantity<1||item.quantity>30) throw new OrderError('Invalid quantity');
  const selections=item.selections||{};
  if(Object.keys(selections).some(id=>!product.customizationGroupIds.includes(id))) throw new OrderError('Unknown customization group');
  let extras=0,extrasVat=0;const chosen=[];
  for(const id of product.customizationGroupIds){
   const group=groupList.find(g=>g.id===id);if(!group) throw new OrderError('Invalid product configuration',500);
   const ids=selections[id]||[];
   if(!Array.isArray(ids)||ids.length<group.min||ids.length>group.max||new Set(ids).size!==ids.length) throw new OrderError(`Invalid ${group.name} selections`);
   for(const optionId of ids){const option=group.options.find(o=>o.id===optionId&&o.available);if(!option) throw new OrderError('Unavailable customization');extras+=option.price;const optionVat=money(option.price*(Number(group.vatRate)||0)/100);extrasVat+=optionVat;chosen.push({groupId:id,groupName:group.name,optionId,name:option.name,price:option.price,vatRate:Number(group.vatRate)||0,vatAmount:optionVat});}
  }
  const category=categories.find(c=>c.id===product.categoryId);
  const categoryVatRate=Number(category?.vatRate)||0;
  const unitSubtotal=money(product.price+extras);
  const unitVat=money(product.price*categoryVatRate/100+extrasVat);
  const unitPrice=money(unitSubtotal+unitVat);
  items.push({productId:product.id,name:structuredClone(product.name),categoryId:product.categoryId,categoryVatRate,quantity:item.quantity,basePrice:product.price,size:product.selectedSize||null,selections:chosen,unitSubtotal,unitVat,unitPrice,lineSubtotal:money(unitSubtotal*item.quantity),lineVat:money(unitVat*item.quantity),lineTotal:money(unitPrice*item.quantity),instructions:String(item.instructions||'').slice(0,500)});
 }
 return {items,subtotal:money(items.reduce((s,x)=>s+x.lineSubtotal,0)),vatTotal:money(items.reduce((s,x)=>s+x.lineVat,0)),total:money(items.reduce((s,x)=>s+x.lineTotal,0))};
}
export async function createOrder(body,io){
 const {items,subtotal,vatTotal,total}=await priceOrder(body);
 const now=new Date().toISOString();
 const deliveryFee=Number(body.delivery?.deliveryFee||0);
 const finalTotal=money(total+deliveryFee);
 const order={id:`DKB-${crypto.randomUUID()}`,branchId:body.branchId,customer:{name:body.customer.name.trim(),phone:body.customer.phone.trim(),address:body.customer.address.trim()},items,subtotal,vatTotal,deliveryFee,deliveryDistanceKm:body.delivery?.distanceKm||null,deliveryPromotion:body.delivery?.promotion||null,total:finalTotal,currency:'PLN',paymentMethod:body.paymentMethod,status:'new',createdAt:now,updatedAt:now,history:[{status:'new',at:now}],cancellationReason:null};
 const record=storageMode()==='mongodb-v2' ? await (async()=>{
  order.idempotencyKey=body.idempotencyKey||null;
  if(order.idempotencyKey){const existing=await findRecord('orders',{branchId:body.branchId,idempotencyKey:order.idempotencyKey});if(existing)return {order:existing,created:false};}
  try {await insertRecord('orders',order);return {order,created:true};}
  catch(err){if(err.code===11000&&order.idempotencyKey){const existing=await findRecord('orders',{branchId:body.branchId,idempotencyKey:order.idempotencyKey});if(existing)return {order:existing,created:false};}throw err;}
 })() : await mutate('orders',rows=>{
  if(body.idempotencyKey){const existing=rows.find(x=>x.idempotencyKey===body.idempotencyKey&&x.branchId===body.branchId);if(existing)return {order:existing,created:false};}
  order.idempotencyKey=body.idempotencyKey||null;rows.push(order);return {order,created:true};
 });
 if(record.created) io.to(`branch:${body.branchId}`).emit('order:new',{eventId:crypto.randomUUID(),order:record.order});
 return record;
}
const transitions={new:['preparing','cancelled'],preparing:['delivering','cancelled'],delivering:['delivered'],delivered:[],cancelled:[]};
export async function changeStatus(branchId,id,status,reason,io){
 const updated=storageMode()==='mongodb-v2' ? await (async()=>{
  const current=await findRecord('orders',{id,branchId});if(!current)throw new OrderError('Order not found',404);
  if(!transitions[current.status]?.includes(status))throw new OrderError('Invalid status transition',409);
  if(status==='cancelled'&&!String(reason||'').trim())throw new OrderError('Cancellation reason required');
  const at=new Date().toISOString();const result=await updateOrderRecord(branchId,id,current.status,{status,updatedAt:at,cancellationReason:status==='cancelled'?reason:current.cancellationReason,historyEntry:{status,at}});
  if(!result)throw new OrderError('Order status changed concurrently; retry',409);return result;
 })() : await mutate('orders',rows=>{
  const order=rows.find(o=>o.id===id&&o.branchId===branchId);
  if(!order)throw new OrderError('Order not found',404);
  if(!transitions[order.status].includes(status))throw new OrderError('Invalid status transition',409);
  if(status==='cancelled'&&!String(reason||'').trim())throw new OrderError('Cancellation reason required');
  order.status=status;order.updatedAt=new Date().toISOString();order.history.push({status,at:order.updatedAt});if(status==='cancelled')order.cancellationReason=reason;return structuredClone(order);
 });
 io.to(`branch:${branchId}`).emit('order:updated',{eventId:crypto.randomUUID(),order:updated});return updated;
}
