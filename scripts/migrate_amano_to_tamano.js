#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const baseDir = path.join(__dirname, '..', 'data');

function migrateFile(file){
  try{
    const raw = fs.readFileSync(file,'utf8');
    const data = JSON.parse(raw);
    if(Array.isArray(data)){
      let changed=false;
      data.forEach(order=>{
        try{
          if(order && order.fields && Array.isArray(order.fields.items)){
            order.fields.items.forEach(it=>{
              if(it && it.amano && !it.tamano){ it.tamano = it.amano; delete it.amano; changed=true; }
            });
          }
        }catch{}
      });
      if(changed){
        fs.writeFileSync(file, JSON.stringify(data,null,2),'utf8');
        console.log('Migrated', file);
      } else {
        console.log('No changes', file);
      }
    } else {
      console.log('Skip (not array)', file);
    }
  }catch(e){ console.error('Error processing', file, e.message); }
}

function run(){
  // tenant subfolders
  const tenants = fs.readdirSync(baseDir).filter(f=> fs.statSync(path.join(baseDir,f)).isDirectory());
  tenants.forEach(t=>{
    const pedidosPath = path.join(baseDir, t, 'pedidos.json');
    if(fs.existsSync(pedidosPath)) migrateFile(pedidosPath);
  });
}
run();
