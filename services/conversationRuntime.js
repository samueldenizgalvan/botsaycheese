// In-memory per-tenant conversation runtime state
// Shape: { stage, data, welcomed, lastWelcomeAt }
const map = new Map();

function key(tenantId, chatId){ return `${tenantId}:${chatId}`; }

function baseState(){
  return { stage:'none', data:{}, welcomed:false, lastWelcomeAt:0 };
}

function getState(tenantId, chatId){
  const k = key(tenantId, chatId);
  let st = map.get(k);
  if(!st){ st = baseState(); map.set(k, st); }
  return st;
}

function setState(tenantId, chatId, partial){
  const st = getState(tenantId, chatId);
  Object.assign(st, partial);
  return st;
}

function reset(tenantId, chatId){
  map.set(key(tenantId, chatId), baseState());
}

module.exports = { getState, setState, reset };
