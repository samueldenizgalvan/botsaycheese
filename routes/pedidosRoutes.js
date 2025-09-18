const express = require('express');
const router = express.Router();
const orders = require('../services/orderStore');
const maybeTenant = require('../middleware/maybeTenant');

router.get('/pendientes', maybeTenant, async (req,res)=>{
  res.json(await orders.listPending(req.tenantId));
});

router.get('/cancelados', maybeTenant, async (req,res)=>{
  res.json(await orders.listCanceled(req.tenantId));
});

router.post('/:id/confirm', maybeTenant, async (req,res)=>{
  try {
    const out = await orders.confirm(req.tenantId, req.params.id);
    if (!out) return res.status(404).json({ error: 'not_found' });
    try {
      const wa = require('../services/whatsappService');
      const cfg = await require('../services/botService').getConfig(req.tenantId).catch(()=>({ messages:{} }));
      const phone = (out?.customer?.phone) || (out?.fields?.telefono) || '';
      const name  = (out?.customer?.name)  || (out?.fields?.nombre)   || '';
      if (phone) {
        const fecha = (out?.fields?.fecha) ? ` para el ${out.fields.fecha}` : '';
        const sched = cfg?.messages?.pickup_schedule ? `\n\n${cfg.messages.pickup_schedule}` : '';
        const msg = `¡Hola${name?` ${name}`:''}! 🎉\nHemos confirmado tu pedido${fecha}. ✅\nGracias por confiar en nosotros. Recuerda que los pagos son a la recogida en efectivo o tarjeta 🧁🥳${sched}`;
        await wa.sendMessage(req.tenantId, phone, msg).catch(()=>{});
      }
    } catch(e){ /* silent */ }
    return res.json({ ok:true, order: out });
  } catch(e){ return res.status(500).json({ error: e.message }); }
});

module.exports = router;