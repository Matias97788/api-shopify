import { obtenerProductos } from '../src/shopify.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const { products } = await obtenerProductos();
    res.status(200).json({ count: products.length, products });
  } catch (err) {
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.errors || err.message;
    res.status(status).json({ error: 'No se pudieron obtener los productos', details: msg });
  }
}