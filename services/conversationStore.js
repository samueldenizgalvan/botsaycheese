const fs = require('fs');
const { join, dirname } = require('path');
const DATA_DIR = join(process.cwd(), 'data');

const pathForConv = (tenantId, phone) =>
  join(DATA_DIR, tenantId, 'sessions', `${String(phone).replace(/[^0-9]/g,'')}.json`);

async function readConv(tenantId, phone){
  try { return JSON.parse(await fs.promises.readFile(pathForConv(tenantId,phone),'utf8')); }
  catch { return {}; }
}

async function writeConv(tenantId, phone, conv){
  const p = pathForConv(tenantId,phone);
  try {
    await fs.promises.mkdir(dirname(p), { recursive:true });
    await fs.promises.writeFile(p, JSON.stringify(conv, null, 2), 'utf8');
    console.log('[writeConv]', p, conv);
  } catch(e) {
    console.error('[writeConv][ERROR]', p, conv, e);
    throw e;
  }
}

module.exports = { readConv, writeConv };