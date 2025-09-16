import { describe, it, expect } from 'vitest';
import utils from '../services/_reminderUtils';

describe('reminder utils', () => {
  it('atStartOfDay produces midnight', () => {
    const d = new Date(); d.setHours(13,45,30,123);
    const x = utils.atStartOfDay(d);
    expect(x.getHours()).toBe(0);
    expect(x.getMinutes()).toBe(0);
  });

  it('parseDDMMYYYY accepts DD-MM-YYYY', () => {
    const d = utils.parseDDMMYYYY('25-12-2025');
    expect(d instanceof Date).toBe(true);
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()+1).toBe(12);
    expect(d.getDate()).toBe(25);
  });

  it('parseDDMMYYYY accepts DD/MM', () => {
    const d = utils.parseDDMMYYYY('01/01');
    expect(d instanceof Date).toBe(true);
    expect(d.getDate()).toBe(1);
    expect(d.getMonth()+1).toBe(1);
  });

  it('isTomorrow works', () => {
    const t = new Date(); t.setDate(t.getDate()+1);
    expect(utils.isTomorrow(t)).toBe(true);
  });

  it('todayKey format', () => {
    expect(utils.todayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('normalizePhoneToJid adds ES code for 9 digits', () => {
    expect(utils.normalizePhoneToJid('657826485')).toBe('34657826485@c.us');
  });

  it('calcTotal computes price', () => {
    const cfg = { options:{ precios:{ grande: 35 } } };
    expect(utils.calcTotal(cfg,'grande',2)).toBe(70);
  });

  it('buildReminderText keeps format and variables', () => {
    const cfg = { options:{ precios:{ grande: 35 } } };
    const order = { fields:{ tamano:'grande', sabores:['Oreo'], cantidad:2, fecha:'25-12' }, total:70 };
    const txt = utils.buildReminderText(cfg, order);
    expect(txt).toContain('¡Hola! 😊');
    expect(txt).toContain('mañana');
    expect(txt).toContain('(25-12)');
    expect(txt).toContain('• Tamaño: *grande*');
    expect(txt).toContain('• Cantidad: *2*');
    expect(txt).toContain('• Sabores: *Oreo*');
    expect(txt).toContain('• Total aprox: *70€*');
  });
});
