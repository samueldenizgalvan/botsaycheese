const express = require('express');
const router = express.Router();
const orders = require('../services/orderStore');

function requireTenant(req,res,next){
  const t = req.query.tenant; if(!t) return res.status(400).json({ error:'missing_tenant' });
  req.tenantId = String(t); next();
}

router.get('/pendientes', requireTenant, async (req,res)=>{
  res.type('application/json');
  const list = await orders.listPending(req.tenantId);
  res.json(list);
});

router.get('/cancelados', requireTenant, async (req,res)=>{
  res.type('application/json');
  const list = await orders.listCanceled(req.tenantId);
  res.json(list);
});

router.post('/:id/confirmar', requireTenant, async (req,res)=>{
  res.type('application/json');
  const updated = await orders.confirm(req.tenantId, req.params.id);
  if(!updated) return res.status(404).json({ error:'not_found' });
  res.json({ ok:true });
});

router.delete('/:id', requireTenant, async (req,res)=>{
  res.type('application/json');
  try {
    const out = await orders.remove(req.tenantId, String(req.params.id));
    if(!out.ok) return res.status(404).json({ error:'pedido no encontrado' });
    res.json({ ok:true });
  } catch(e){
    console.error('DELETE pedido error', e);
    res.status(500).json({ error:'internal' });
  }
});

module.exports = router;