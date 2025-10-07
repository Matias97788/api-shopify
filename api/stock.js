import { actualizarStock } from '../src/shopify.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const body = req.body || {};
    const updates = body.updates ?? body;

    if (!updates || (Array.isArray(updates) && updates.length === 0)) {
      return res.status(400).json({ error: 'Falta body con updates o un objeto de actualización' });
    }

    const result = await actualizarStock(updates);
    res.status(200).json(result);
  } catch (err) {
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.errors || err.message;
    res.status(status).json({ error: 'No se pudo actualizar el stock', details: msg });
  }
}